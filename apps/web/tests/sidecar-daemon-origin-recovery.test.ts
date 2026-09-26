// A packaged web sidecar used to pin the daemon origin from OD_PORT at startup.
// After the daemon it was started beside exits, a replacement can listen on a
// new port while the web process keeps proxying at the dead one. Workspace
// calls then fail and Run never leaves the idle state.
//
// The managed production proxy asks the sibling daemon for its current status
// before each daemon-routed request. These tests use real loopback servers and
// a mocked sidecar status boundary.

import { createServer as createHttpServer, request as sendHttpRequest, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getSidecarStatus, type SidecarStamp } from '@open-design/sidecar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDaemonProxyHandler,
  createManagedDaemonOriginResolver,
  startWebSidecar,
  type DaemonOriginResolver,
} from '../sidecar/server';

vi.mock('@open-design/sidecar', () => ({
  getSidecarStatus: vi.fn(),
}));

const DAEMON_STATUS_TIMEOUT_MS = 1000;
const RECOVERY_STAMP: SidecarStamp = {
  app: 'web',
  channel: 'stable',
  mode: 'runtime',
  namespace: 'recovery',
  source: 'packaged',
};
const SIBLING_DAEMON_STAMP: SidecarStamp = { ...RECOVERY_STAMP, app: 'daemon' };
const ENV_KEYS = [
  'OD_PORT',
  'OD_WEB_OUTPUT_MODE',
  'OD_WEB_STANDALONE_ROOT',
  'OD_STANDALONE_STARTUP_TIMEOUT_MS',
] as const;

type RecordedRequest = {
  body: string;
  method: string;
  origin?: string;
  url: string;
};

type RecordedDaemon = {
  close: () => Promise<void>;
  origin: string;
  port: number;
  requests: RecordedRequest[];
};

type ProxyHandle = {
  close: () => Promise<void>;
  fallbackCalls: () => number;
  port: number;
};

const cleanups: (() => Promise<void>)[] = [];
let envSnapshot = snapshotEnv();

function snapshotEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  return {
    OD_PORT: process.env.OD_PORT,
    OD_WEB_OUTPUT_MODE: process.env.OD_WEB_OUTPUT_MODE,
    OD_WEB_STANDALONE_ROOT: process.env.OD_WEB_STANDALONE_ROOT,
    OD_STANDALONE_STARTUP_TIMEOUT_MS: process.env.OD_STANDALONE_STARTUP_TIMEOUT_MS,
  };
}

function restoreEnv(previous: Record<(typeof ENV_KEYS)[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = previous[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function statusSnapshot(url: string | null): { desktopAuthGateActive: boolean; state: 'running'; url: string | null } {
  return { desktopAuthGateActive: false, state: 'running', url };
}

beforeEach(() => {
  envSnapshot = snapshotEnv();
});

afterEach(async () => {
  vi.mocked(getSidecarStatus).mockReset();
  while (cleanups.length > 0) await cleanups.pop()?.();
  restoreEnv(envSnapshot);
});

async function startRecordedDaemon(host = '127.0.0.1'): Promise<RecordedDaemon> {
  const requests: RecordedRequest[] = [];
  const server = createHttpServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      body: Buffer.concat(chunks).toString('utf8'),
      method: request.method ?? 'GET',
      ...(typeof request.headers.origin === 'string' ? { origin: request.headers.origin } : {}),
      url: request.url ?? '',
    });
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, url: request.url }));
  });
  const port = await listen(server, host);
  const originHost = host.includes(':') ? `[${host}]` : host;
  const daemon: RecordedDaemon = {
    origin: `http://${originHost}:${port}`,
    port,
    requests,
    close: async () => {
      await closeHttpServer(server);
    },
  };
  cleanups.push(daemon.close);
  return daemon;
}

async function startProxy(
  daemonOrigin: string | null | DaemonOriginResolver,
  fallback: (request: IncomingMessage, response: ServerResponse) => void = spaShell,
): Promise<ProxyHandle> {
  let calls = 0;
  const server = createHttpServer(createDaemonProxyHandler(daemonOrigin, async (request, response) => {
    calls += 1;
    fallback(request, response);
  }));
  const port = await listen(server);
  const proxy: ProxyHandle = {
    port,
    fallbackCalls: () => calls,
    close: async () => {
      await closeHttpServer(server);
    },
  };
  cleanups.push(proxy.close);
  return proxy;
}

function spaShell(_request: IncomingMessage, response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!DOCTYPE html><html><body>app shell</body></html>');
}

function listen(server: HttpServer | NetServer, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error == null ? resolve() : reject(error)));
  });
  server.closeAllConnections();
}

async function expectLiveOriginOutage(response: Response): Promise<void> {
  expect(response.status).toBe(502);
  expect(response.headers.get('content-type') ?? '').toContain('text/plain');
  const body = await response.text();
  expect(body).toContain('ECONNREFUSED');
  expect(body).toContain('live daemon origin is unavailable');
  expect(body).not.toContain('<');
}

function managedResolver(): DaemonOriginResolver {
  return createManagedDaemonOriginResolver(RECOVERY_STAMP);
}

describe('web proxy follows a replacement daemon', () => {
  it('serves the next /api/projects request from daemon B without restarting web', async () => {
    const standaloneRoot = await mkdtemp(join(tmpdir(), 'open-design-web-daemon-swap-'));
    cleanups.push(async () => {
      await rm(standaloneRoot, { force: true, recursive: true });
    });
    const daemonA = await startRecordedDaemon();
    const daemonB = await startRecordedDaemon();
    let reportedOrigin = daemonA.origin;
    vi.mocked(getSidecarStatus).mockImplementation(async (stamp) => {
      const identity = stamp as SidecarStamp;
      if (
        identity.app !== SIBLING_DAEMON_STAMP.app
        || identity.namespace !== 'replacement'
        || identity.channel !== 'stable'
        || identity.source !== 'packaged'
        || identity.mode !== 'runtime'
      ) {
        return statusSnapshot(daemonA.origin);
      }
      return statusSnapshot(reportedOrigin);
    });

    const fakeWebRoot = join(standaloneRoot, 'apps', 'web');
    await mkdir(fakeWebRoot, { recursive: true });
    await writeFile(
      join(fakeWebRoot, 'server.js'),
      `
import { createServer } from 'node:net';

const server = createServer((socket) => socket.end());
server.listen(Number(process.env.PORT), process.env.HOSTNAME || '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
      'utf8',
    );
    process.env.OD_WEB_OUTPUT_MODE = 'standalone';
    process.env.OD_WEB_STANDALONE_ROOT = standaloneRoot;
    process.env.OD_STANDALONE_STARTUP_TIMEOUT_MS = '3000';
    process.env.OD_PORT = String(daemonA.port);

    const handle = await startWebSidecar({
      mode: 'runtime',
      stamp: { ...RECOVERY_STAMP, namespace: 'replacement' },
    });
    cleanups.push(async () => {
      await handle.stop();
    });

    const web = await handle.status();
    const first = await fetch(new URL('/api/projects', web.url ?? ''));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, url: '/api/projects' });
    expect(daemonA.requests.map((entry) => entry.url)).toEqual(['/api/projects']);

    await daemonA.close();
    reportedOrigin = daemonB.origin;

    const second = await fetch(new URL('/api/projects', web.url ?? ''));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, url: '/api/projects' });
    expect(daemonB.requests.map((entry) => entry.url)).toEqual(['/api/projects']);
    expect(vi.mocked(getSidecarStatus).mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of vi.mocked(getSidecarStatus).mock.calls) {
      expect(call[1]).toEqual({ timeoutMs: DAEMON_STATUS_TIMEOUT_MS });
      expect(call[1]).not.toHaveProperty('generationPid');
    }
  });
});

describe('managed daemon origin resolver', () => {
  it('uses the sibling stamp and ignores a stale OD_PORT', async () => {
    const stale = await startRecordedDaemon();
    const live = await startRecordedDaemon();
    const otherNamespace = await startRecordedDaemon();
    process.env.OD_PORT = String(stale.port);
    vi.mocked(getSidecarStatus).mockImplementation(async (stamp) => {
      const identity = stamp as SidecarStamp;
      if (identity.namespace !== RECOVERY_STAMP.namespace || identity.app !== 'daemon') {
        return statusSnapshot(otherNamespace.origin);
      }
      return statusSnapshot(live.origin);
    });

    const proxy = await startProxy(managedResolver());
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/projects?limit=4`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, url: '/api/projects?limit=4' });
    expect(live.requests.map((entry) => entry.url)).toEqual(['/api/projects?limit=4']);
    expect(stale.requests).toEqual([]);
    expect(otherNamespace.requests).toEqual([]);
    expect(vi.mocked(getSidecarStatus).mock.calls).toEqual([
      [SIBLING_DAEMON_STAMP, { timeoutMs: DAEMON_STATUS_TIMEOUT_MS }],
    ]);
  });

  it('returns a plain-text 502 for discovery failures and recovers on a later valid status', async () => {
    const daemon = await startRecordedDaemon();
    const script: Array<'reject' | { url: string | null }> = [
      'reject',
      { url: null },
      { url: '' },
      { url: 'not a url' },
      { url: 'http://10.1.2.3:9' },
      { url: 'http://169.254.169.254/latest/meta-data' },
      { url: 'https://127.0.0.1:7456' },
      { url: 'http://user:pass@127.0.0.1:7456' },
      { url: 'file:///tmp/daemon' },
      { url: 'http://[2001:db8::1]:9' },
      { url: `http://localhost:${daemon.port}/ignored?x=1` },
    ];
    vi.mocked(getSidecarStatus).mockImplementation(async () => {
      const next = script.shift();
      if (next == null || next === 'reject') throw new Error('sidecar status timed out');
      return statusSnapshot(next.url);
    });
    const proxy = await startProxy(managedResolver());
    const failureCount = script.length - 1;

    for (let index = 0; index < failureCount; index += 1) {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/api/projects`);
      await expectLiveOriginOutage(response);
    }
    expect(proxy.fallbackCalls()).toBe(0);
    expect(daemon.requests).toEqual([]);

    const recovered = await fetch(`http://127.0.0.1:${proxy.port}/api/projects`);
    expect(recovered.status).toBe(200);
    expect(daemon.requests.map((entry) => entry.url)).toEqual(['/api/projects']);
    expect(proxy.fallbackCalls()).toBe(0);
  });

  it('shares one in-flight lookup across a burst and looks up again afterwards', async () => {
    const daemon = await startRecordedDaemon();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(getSidecarStatus).mockImplementation(async () => {
      calls += 1;
      await gate;
      return statusSnapshot(daemon.origin);
    });
    const proxy = await startProxy(managedResolver());
    const url = `http://127.0.0.1:${proxy.port}/api/projects`;

    const burst = Promise.all(Array.from({ length: 5 }, () => fetch(url)));
    await expect.poll(() => calls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    release();

    const responses = await burst;
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    await Promise.all(responses.map((response) => response.text()));
    expect(daemon.requests).toHaveLength(5);
    expect(calls).toBe(1);

    const followUp = await fetch(url);
    expect(followUp.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('clears a rejected lookup so a later request can recover', async () => {
    const daemon = await startRecordedDaemon();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let rejectLookup = true;
    vi.mocked(getSidecarStatus).mockImplementation(async () => {
      calls += 1;
      if (!rejectLookup) return statusSnapshot(daemon.origin);
      await gate;
      throw new Error('sidecar status timed out');
    });
    const proxy = await startProxy(managedResolver());
    const url = `http://127.0.0.1:${proxy.port}/api/version`;

    const burst = Promise.all(Array.from({ length: 4 }, () => fetch(url)));
    await expect.poll(() => calls).toBe(1);
    release();
    const failed = await burst;
    expect(failed.map((response) => response.status)).toEqual([502, 502, 502, 502]);
    for (const response of failed) await expectLiveOriginOutage(response);
    expect(calls).toBe(1);
    expect(daemon.requests).toEqual([]);
    expect(proxy.fallbackCalls()).toBe(0);

    rejectLookup = false;
    const recovered = await fetch(url);
    expect(recovered.status).toBe(200);
    expect(calls).toBe(2);
    expect(daemon.requests.map((entry) => entry.url)).toEqual(['/api/version']);
  });

  it('accepts a bracketed IPv6 loopback status URL and proxies to it', async () => {
    const daemon = await startRecordedDaemon('::1');
    expect(daemon.origin.startsWith('http://[::1]:')).toBe(true);
    vi.mocked(getSidecarStatus).mockResolvedValue(
      statusSnapshot(`http://[0:0:0:0:0:0:0:1]:${daemon.port}/ignored`),
    );
    const proxy = await startProxy(managedResolver());

    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/projects`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, url: '/api/projects' });
    expect(daemon.requests.map((entry) => entry.url)).toEqual(['/api/projects']);
    expect(proxy.fallbackCalls()).toBe(0);
  });
});

describe('resolved daemon proxy behavior', () => {
  it('preserves /api, /artifacts, and /frames routing and skips ordinary pages', async () => {
    const daemon = await startRecordedDaemon();
    vi.mocked(getSidecarStatus).mockResolvedValue(statusSnapshot(daemon.origin));
    const proxy = await startProxy(managedResolver());
    const paths = [
      '/api/projects?limit=10',
      '/artifacts/file.bin?download=1',
      '/frames/preview?t=1',
    ];

    for (const path of paths) {
      const response = await fetch(`http://127.0.0.1:${proxy.port}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, url: path });
    }
    expect(daemon.requests.map((entry) => entry.url)).toEqual(paths);
    expect(vi.mocked(getSidecarStatus)).toHaveBeenCalledTimes(paths.length);

    vi.mocked(getSidecarStatus).mockImplementation(() => new Promise(() => {}));
    const page = await fetch(`http://127.0.0.1:${proxy.port}/settings?tab=general`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('app shell');
    expect(vi.mocked(getSidecarStatus)).toHaveBeenCalledTimes(paths.length);
    expect(proxy.fallbackCalls()).toBe(1);
  });

  it('does not let an absolute request target replace the resolved daemon', async () => {
    const daemon = await startRecordedDaemon();
    vi.mocked(getSidecarStatus).mockResolvedValue(statusSnapshot(daemon.origin));
    const proxy = await startProxy(managedResolver());

    const response = await new Promise<{ body: string; status: number }>((resolve, reject) => {
      const upstream = sendHttpRequest({
        hostname: '127.0.0.1',
        method: 'GET',
        path: 'http://169.254.169.254/api/latest/meta-data?token=1',
        port: proxy.port,
      }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            status: incoming.statusCode ?? 0,
          });
        });
      });
      upstream.on('error', reject);
      upstream.end();
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, url: '/api/latest/meta-data?token=1' });
    expect(daemon.requests.map((entry) => entry.url)).toEqual(['/api/latest/meta-data?token=1']);
  });

  it('normalizes the browser origin to the resolved daemon origin', async () => {
    const stale = await startRecordedDaemon();
    const live = await startRecordedDaemon();
    process.env.OD_PORT = String(stale.port);
    vi.mocked(getSidecarStatus).mockResolvedValue(statusSnapshot(live.origin));
    const proxy = await startProxy(managedResolver());

    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/projects`, {
      headers: { origin: `http://127.0.0.1:${proxy.port}` },
    });

    expect(response.status).toBe(200);
    expect(live.requests).toEqual([
      expect.objectContaining({
        origin: live.origin,
        url: '/api/projects',
      }),
    ]);
    expect(stale.requests).toEqual([]);
  });

  it('forwards a POST body once', async () => {
    const daemon = await startRecordedDaemon();
    vi.mocked(getSidecarStatus).mockResolvedValue(statusSnapshot(daemon.origin));
    const proxy = await startProxy(managedResolver());
    const body = JSON.stringify({ name: 'atlas', nonce: 'once' });

    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/projects`, {
      body,
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(daemon.requests).toEqual([
      expect.objectContaining({ body, method: 'POST', url: '/api/projects' }),
    ]);
  });

  it('does not replay a POST when the upstream transport fails', async () => {
    let connections = 0;
    const sockets = new Set<Socket>();
    const upstream: NetServer = createNetServer((socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', () => socket.destroy());
    });
    const upstreamPort = await listen(upstream);
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      if (!upstream.listening) return;
      await new Promise<void>((resolve) => {
        upstream.close(() => resolve());
      });
    });
    vi.mocked(getSidecarStatus).mockResolvedValue(statusSnapshot(`http://127.0.0.1:${upstreamPort}`));
    const proxy = await startProxy(managedResolver());

    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/projects`, {
      body: JSON.stringify({ name: 'atlas' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type') ?? '').toContain('text/plain');
    const body = await response.text();
    expect(body).toBe('socket hang up');
    expect(body).not.toContain('<');
    expect(connections).toBe(1);
    expect(proxy.fallbackCalls()).toBe(0);
  });

  it('streams a chunked daemon response before the upstream ends', async () => {
    let releaseSecond!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const upstream = createHttpServer(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: one\n\n');
      await gate;
      response.write('data: two\n\n');
      response.end();
    });
    const upstreamPort = await listen(upstream);
    cleanups.push(async () => {
      releaseSecond();
      await closeHttpServer(upstream);
    });
    vi.mocked(getSidecarStatus).mockResolvedValue(statusSnapshot(`http://127.0.0.1:${upstreamPort}`));
    const proxy = await startProxy(managedResolver());

    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/events`);
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader == null) throw new Error('missing response body');
    const decoder = new TextDecoder();
    let received = '';
    while (!received.includes('data: one')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    expect(received).toContain('data: one');
    expect(received).not.toContain('data: two');
    releaseSecond();
    while (!received.includes('data: two')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    expect(received).toContain('data: two');
  });

  it('does not forward a request when the client disconnects during discovery', async () => {
    const daemon = await startRecordedDaemon();
    let releaseStatus!: (origin: string) => void;
    const pendingStatus = new Promise<string>((resolve) => {
      releaseStatus = resolve;
    });
    vi.mocked(getSidecarStatus).mockImplementation(async () => statusSnapshot(await pendingStatus));
    const proxy = await startProxy(managedResolver());
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const socket = createConnection(proxy.port, '127.0.0.1');
      cleanups.push(async () => {
        socket.destroy();
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('connect', () => resolve());
      });
      socket.on('error', () => {});
      socket.write([
        'GET /api/projects HTTP/1.1',
        `Host: 127.0.0.1:${proxy.port}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n'));
      await expect.poll(() => vi.mocked(getSidecarStatus).mock.calls.length).toBe(1);
      socket.destroy();
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      releaseStatus(daemon.origin);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(daemon.requests).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
