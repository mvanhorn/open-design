import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getSidecarStatus, type SidecarStamp } from '@open-design/sidecar';
import { describe, expect, it, vi } from 'vitest';

import {
  createStandaloneBackendEnv,
  createStandaloneParentMonitorImport,
  createStandaloneServerArgs,
  normalizeDaemonProxyOriginHeader,
  resolveDaemonProxyTarget,
  resolveNextBundlerOptions,
  resolveStandaloneBackendOrigin,
  resolveStandaloneServerEntry,
  startWebSidecar,
} from '../sidecar/server';

vi.mock('@open-design/sidecar', () => ({
  getSidecarStatus: vi.fn(),
}));

vi.mock('next', () => ({
  default: () => ({
    prepare: async () => {},
    getRequestHandler: () => async (
      _request: unknown,
      response: { statusCode: number; setHeader: (name: string, value: string) => void; end: (body: string) => void },
    ) => {
      response.statusCode = 200;
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<!DOCTYPE html><html><body>app shell</body></html>');
    },
    close: async () => {},
  }),
}));

describe('resolveDaemonProxyTarget', () => {
  it('proxies allowlisted relative paths to the daemon origin', () => {
    const target = resolveDaemonProxyTarget('http://127.0.0.1:7456', '/api/projects?limit=10');

    expect(target?.href).toBe('http://127.0.0.1:7456/api/projects?limit=10');
  });

  it('does not let absolute request URLs replace the daemon origin', () => {
    const target = resolveDaemonProxyTarget(
      'http://127.0.0.1:7456',
      'http://169.254.169.254/api/latest/meta-data?token=1',
    );

    expect(target?.href).toBe('http://127.0.0.1:7456/api/latest/meta-data?token=1');
  });

  it('rejects non-daemon paths', () => {
    expect(resolveDaemonProxyTarget('http://127.0.0.1:7456', '/settings')).toBeNull();
  });
});

describe('resolveStandaloneServerEntry', () => {
  it('resolves the traced monorepo standalone server entry', async () => {
    const previousDistDir = process.env.OD_WEB_DIST_DIR;
    delete process.env.OD_WEB_DIST_DIR;
    const webRoot = await mkdtemp(join(tmpdir(), 'open-design-web-standalone-'));
    const nestedRoot = join(webRoot, '.next', 'standalone', 'apps', 'web');
    const fallbackRoot = join(webRoot, '.next', 'standalone');

    try {
      await mkdir(nestedRoot, { recursive: true });
      await mkdir(fallbackRoot, { recursive: true });
      await writeFile(join(nestedRoot, 'server.js'), '', 'utf8');
      await writeFile(join(fallbackRoot, 'server.js'), '', 'utf8');

      expect(resolveStandaloneServerEntry(webRoot)).toBe(join(nestedRoot, 'server.js'));
    } finally {
      if (previousDistDir == null) {
        delete process.env.OD_WEB_DIST_DIR;
      } else {
        process.env.OD_WEB_DIST_DIR = previousDistDir;
      }
      await rm(webRoot, { force: true, recursive: true });
    }
  });

  it('prefers a copied standalone resource root before package fallback entries', async () => {
    const previousDistDir = process.env.OD_WEB_DIST_DIR;
    delete process.env.OD_WEB_DIST_DIR;
    const webRoot = await mkdtemp(join(tmpdir(), 'open-design-web-package-'));
    const copiedRoot = await mkdtemp(join(tmpdir(), 'open-design-web-copied-'));
    const copiedWebRoot = join(copiedRoot, 'apps', 'web');
    const packageFallbackRoot = join(webRoot, '.next', 'standalone', 'apps', 'web');

    try {
      await mkdir(copiedWebRoot, { recursive: true });
      await mkdir(packageFallbackRoot, { recursive: true });
      await writeFile(join(copiedWebRoot, 'server.js'), '', 'utf8');
      await writeFile(join(packageFallbackRoot, 'server.js'), '', 'utf8');

      expect(resolveStandaloneServerEntry(webRoot, copiedRoot)).toBe(join(copiedWebRoot, 'server.js'));
    } finally {
      if (previousDistDir == null) {
        delete process.env.OD_WEB_DIST_DIR;
      } else {
        process.env.OD_WEB_DIST_DIR = previousDistDir;
      }
      await rm(webRoot, { force: true, recursive: true });
      await rm(copiedRoot, { force: true, recursive: true });
    }
  });

  it('can resolve a copied standalone resource without a web package root', async () => {
    const copiedRoot = await mkdtemp(join(tmpdir(), 'open-design-web-copied-only-'));
    const copiedWebRoot = join(copiedRoot, 'apps', 'web');

    try {
      await mkdir(copiedWebRoot, { recursive: true });
      await writeFile(join(copiedWebRoot, 'server.js'), '', 'utf8');

      expect(resolveStandaloneServerEntry(null, copiedRoot)).toBe(join(copiedWebRoot, 'server.js'));
    } finally {
      await rm(copiedRoot, { force: true, recursive: true });
    }
  });
});

describe('createStandaloneServerArgs', () => {
  it('preloads a parent monitor before running the standalone server entry', () => {
    const args = createStandaloneServerArgs('/tmp/open-design/server.js');

    expect(args).toHaveLength(3);
    expect(args[0]).toBe('--import');
    expect(args[1]).toBe(createStandaloneParentMonitorImport());
    expect(args[2]).toBe('/tmp/open-design/server.js');
  });

  it('uses a data import that exits when the recorded parent disappears', () => {
    const importSpecifier = createStandaloneParentMonitorImport('OD_TEST_PARENT_PID');
    const source = decodeURIComponent(importSpecifier.replace(/^data:text\/javascript,/, ''));

    expect(importSpecifier).toMatch(/^data:text\/javascript,/);
    expect(source).toContain('process.env["OD_TEST_PARENT_PID"]');
    expect(source).toContain('process.ppid === parentPid');
    expect(source).toContain('process.kill(parentPid, 0)');
    expect(source).toContain('process.exit(0)');
  });
});

describe('standalone backend binding', () => {
  it('keeps the hidden standalone backend on loopback even when the public sidecar host is wider', () => {
    const env = createStandaloneBackendEnv({
      baseEnv: { ...process.env, OD_HOST: '0.0.0.0' },
      parentPid: 1234,
      port: 5876,
    });

    expect(resolveStandaloneBackendOrigin(5876)).toBe('http://127.0.0.1:5876');
    expect(env.HOSTNAME).toBe('127.0.0.1');
    expect(env.PORT).toBe('5876');
    expect(env.NODE_ENV).toBe('production');
    expect(env.OD_STANDALONE_PARENT_PID).toBe('1234');
  });

  it('accepts a listening standalone backend before the app root responds to HTTP', async () => {
    const previousOutputMode = process.env.OD_WEB_OUTPUT_MODE;
    const previousStandaloneRoot = process.env.OD_WEB_STANDALONE_ROOT;
    const previousStartupTimeout = process.env.OD_STANDALONE_STARTUP_TIMEOUT_MS;
    const standaloneRoot = await mkdtemp(join(tmpdir(), 'open-design-web-slow-http-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'open-design-web-runtime-'));
    const fakeWebRoot = join(standaloneRoot, 'apps', 'web');

    try {
      await mkdir(fakeWebRoot, { recursive: true });
      await writeFile(
        join(fakeWebRoot, 'server.js'),
        `
import { createServer } from 'node:net';

const server = createServer(() => {
  // Keep accepted sockets open. A TCP readiness probe should pass, but an
  // HTTP HEAD/GET probe against "/" will hang until its client timeout.
});

server.listen(Number(process.env.PORT), process.env.HOSTNAME || '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
        'utf8',
      );

      process.env.OD_WEB_OUTPUT_MODE = 'standalone';
      process.env.OD_WEB_STANDALONE_ROOT = standaloneRoot;
      process.env.OD_STANDALONE_STARTUP_TIMEOUT_MS = '3000';

      const handle = await startWebSidecar({
        app: 'web',
        base: runtimeRoot,
        ipc: join(runtimeRoot, 'web.sock'),
        mode: 'runtime',
        namespace: 'slow-http',
        source: 'tools-pack',
      });

      try {
        await expect(handle.status()).resolves.toMatchObject({ state: 'running' });
      } finally {
        await handle.stop();
      }
    } finally {
      if (previousOutputMode == null) delete process.env.OD_WEB_OUTPUT_MODE;
      else process.env.OD_WEB_OUTPUT_MODE = previousOutputMode;
      if (previousStandaloneRoot == null) delete process.env.OD_WEB_STANDALONE_ROOT;
      else process.env.OD_WEB_STANDALONE_ROOT = previousStandaloneRoot;
      if (previousStartupTimeout == null) delete process.env.OD_STANDALONE_STARTUP_TIMEOUT_MS;
      else process.env.OD_STANDALONE_STARTUP_TIMEOUT_MS = previousStartupTimeout;
      await rm(standaloneRoot, { force: true, recursive: true });
      await rm(runtimeRoot, { force: true, recursive: true });
    }
  });

  it('does not treat a hijacked backend port as standalone readiness', async () => {
    const previousOutputMode = process.env.OD_WEB_OUTPUT_MODE;
    const previousStandaloneRoot = process.env.OD_WEB_STANDALONE_ROOT;
    const previousStartupTimeout = process.env.OD_STANDALONE_STARTUP_TIMEOUT_MS;
    const standaloneRoot = await mkdtemp(join(tmpdir(), 'open-design-web-hijacked-port-'));
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'open-design-web-hijacked-runtime-'));
    const fakeWebRoot = join(standaloneRoot, 'apps', 'web');
    let handle: Awaited<ReturnType<typeof startWebSidecar>> | undefined;

    try {
      await mkdir(fakeWebRoot, { recursive: true });
      await writeFile(
        join(fakeWebRoot, 'server.js'),
        `
import { createServer } from 'node:net';

const host = process.env.HOSTNAME || '127.0.0.1';
const port = Number(process.env.PORT);
let sawProbe = false;
const dummyServer = createServer((socket) => {
  socket.end();
  if (!sawProbe) {
    sawProbe = true;
    process.exit(70);
  }
});

dummyServer.listen(port, host, () => {
  const intendedServer = createServer();
  intendedServer.once('error', () => {
    // Keep the dummy listener alive until the readiness probe connects, then
    // surface the failed intended bind like a port-race crash.
  });
  intendedServer.listen(port, host);
});

process.on('SIGTERM', () => dummyServer.close(() => process.exit(0)));
`,
        'utf8',
      );

      process.env.OD_WEB_OUTPUT_MODE = 'standalone';
      process.env.OD_WEB_STANDALONE_ROOT = standaloneRoot;
      process.env.OD_STANDALONE_STARTUP_TIMEOUT_MS = '1000';

      await expect((async () => {
        handle = await startWebSidecar({
          app: 'web',
          base: runtimeRoot,
          ipc: join(runtimeRoot, 'web.sock'),
          mode: 'runtime',
          namespace: 'hijacked-port',
          source: 'tools-pack',
        });
      })()).rejects.toThrow(/standalone Next\.js server exited before readiness/);
    } finally {
      await handle?.stop();
      if (previousOutputMode == null) delete process.env.OD_WEB_OUTPUT_MODE;
      else process.env.OD_WEB_OUTPUT_MODE = previousOutputMode;
      if (previousStandaloneRoot == null) delete process.env.OD_WEB_STANDALONE_ROOT;
      else process.env.OD_WEB_STANDALONE_ROOT = previousStandaloneRoot;
      if (previousStartupTimeout == null) delete process.env.OD_STANDALONE_STARTUP_TIMEOUT_MS;
      else process.env.OD_STANDALONE_STARTUP_TIMEOUT_MS = previousStartupTimeout;
      await rm(standaloneRoot, { force: true, recursive: true });
      await rm(runtimeRoot, { force: true, recursive: true });
    }
  });
});

describe('resolveNextBundlerOptions', () => {
  it('uses webpack for local dev by default to avoid stale Turbopack chunk graphs', () => {
    const previous = process.env.OD_WEB_DEV_BUNDLER;
    delete process.env.OD_WEB_DEV_BUNDLER;

    try {
      expect(resolveNextBundlerOptions(true)).toEqual({ webpack: true });
    } finally {
      if (previous == null) delete process.env.OD_WEB_DEV_BUNDLER;
      else process.env.OD_WEB_DEV_BUNDLER = previous;
    }
  });

  it('lets local developers explicitly opt back into Turbopack', () => {
    const previous = process.env.OD_WEB_DEV_BUNDLER;
    process.env.OD_WEB_DEV_BUNDLER = 'turbopack';

    try {
      expect(resolveNextBundlerOptions(true)).toEqual({ turbopack: true });
    } finally {
      if (previous == null) delete process.env.OD_WEB_DEV_BUNDLER;
      else process.env.OD_WEB_DEV_BUNDLER = previous;
    }
  });

  it('does not force a bundler for production mode', () => {
    expect(resolveNextBundlerOptions(false)).toEqual({});
  });
});

const DAEMON_STATUS_TIMEOUT_MS = 1000;
const STARTUP_ENV_KEYS = [
  'OD_PORT',
  'OD_WEB_OUTPUT_MODE',
  'OD_WEB_STANDALONE_ROOT',
  'OD_STANDALONE_STARTUP_TIMEOUT_MS',
] as const;

function snapshotStartupEnv(): Record<(typeof STARTUP_ENV_KEYS)[number], string | undefined> {
  return {
    OD_PORT: process.env.OD_PORT,
    OD_WEB_OUTPUT_MODE: process.env.OD_WEB_OUTPUT_MODE,
    OD_WEB_STANDALONE_ROOT: process.env.OD_WEB_STANDALONE_ROOT,
    OD_STANDALONE_STARTUP_TIMEOUT_MS: process.env.OD_STANDALONE_STARTUP_TIMEOUT_MS,
  };
}

function restoreStartupEnv(previous: Record<(typeof STARTUP_ENV_KEYS)[number], string | undefined>): void {
  for (const key of STARTUP_ENV_KEYS) {
    const value = previous[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

async function startMarkedDaemon(marker: string): Promise<{
  origin: string;
  port: number;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server: HttpServer = createHttpServer((request, response) => {
    requests.push(`${request.method ?? 'GET'} ${request.url ?? ''}`);
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ marker }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error == null ? resolve() : reject(error)));
      });
      server.closeAllConnections();
    },
  };
}

function installSiblingStatus(stamp: SidecarStamp, origin: string, decoyOrigin: string): void {
  vi.mocked(getSidecarStatus).mockImplementation(async (candidate) => {
    const identity = candidate as SidecarStamp;
    const url = identity.app === 'daemon'
      && identity.namespace === stamp.namespace
      && identity.channel === stamp.channel
      && identity.source === stamp.source
      && identity.mode === stamp.mode
      ? origin
      : decoyOrigin;
    return { desktopAuthGateActive: false, state: 'running', url };
  });
}

describe('daemon origin startup wiring', () => {
  it('follows live sidecar status for regular production and leaves pages on Next', async () => {
    const previous = snapshotStartupEnv();
    const stale = await startMarkedDaemon('stale');
    const live = await startMarkedDaemon('live');
    const decoy = await startMarkedDaemon('decoy');
    const stamp: SidecarStamp = {
      app: 'web',
      channel: 'stable',
      mode: 'runtime',
      namespace: 'prod-regular',
      source: 'packaged',
    };
    delete process.env.OD_WEB_OUTPUT_MODE;
    delete process.env.OD_WEB_STANDALONE_ROOT;
    process.env.OD_PORT = String(stale.port);
    installSiblingStatus(stamp, live.origin, decoy.origin);
    const handle = await startWebSidecar({ mode: 'runtime', stamp });

    try {
      const web = await handle.status();
      const page = await fetch(new URL('/settings', web.url ?? ''));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('app shell');
      expect(getSidecarStatus).not.toHaveBeenCalled();

      const api = await fetch(new URL('/api/projects?limit=3', web.url ?? ''));
      expect(api.status).toBe(200);
      expect(await api.json()).toEqual({ marker: 'live' });
      expect(live.requests).toEqual(['GET /api/projects?limit=3']);
      expect(stale.requests).toEqual([]);
      expect(decoy.requests).toEqual([]);
      expect(vi.mocked(getSidecarStatus).mock.calls).toEqual([
        [{ ...stamp, app: 'daemon' }, { timeoutMs: DAEMON_STATUS_TIMEOUT_MS }],
      ]);
    } finally {
      await handle.stop();
      await stale.close();
      await live.close();
      await decoy.close();
      restoreStartupEnv(previous);
      vi.mocked(getSidecarStatus).mockReset();
    }
  });

  it('follows live sidecar status for standalone production', async () => {
    const previous = snapshotStartupEnv();
    const standaloneRoot = await mkdtemp(join(tmpdir(), 'open-design-web-live-origin-'));
    const stale = await startMarkedDaemon('stale');
    const live = await startMarkedDaemon('live');
    const decoy = await startMarkedDaemon('decoy');
    const stamp: SidecarStamp = {
      app: 'web',
      channel: 'stable',
      mode: 'runtime',
      namespace: 'prod-standalone',
      source: 'packaged',
    };
    let handle: Awaited<ReturnType<typeof startWebSidecar>> | undefined;

    try {
      const fakeWebRoot = join(standaloneRoot, 'apps', 'web');
      await mkdir(fakeWebRoot, { recursive: true });
      await writeFile(
        join(fakeWebRoot, 'server.js'),
        `
import { createServer } from 'node:http';

const server = createServer((_request, response) => {
  response.statusCode = 200;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!DOCTYPE html><html><body>standalone shell</body></html>');
});
server.listen(Number(process.env.PORT), process.env.HOSTNAME || '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
        'utf8',
      );
      process.env.OD_WEB_OUTPUT_MODE = 'standalone';
      process.env.OD_WEB_STANDALONE_ROOT = standaloneRoot;
      process.env.OD_STANDALONE_STARTUP_TIMEOUT_MS = '3000';
      process.env.OD_PORT = String(stale.port);
      installSiblingStatus(stamp, live.origin, decoy.origin);

      handle = await startWebSidecar({ mode: 'runtime', stamp });
      const web = await handle.status();
      const page = await fetch(new URL('/settings', web.url ?? ''));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('standalone shell');
      expect(getSidecarStatus).not.toHaveBeenCalled();

      const api = await fetch(new URL('/artifacts/board?download=1', web.url ?? ''));
      expect(api.status).toBe(200);
      expect(await api.json()).toEqual({ marker: 'live' });
      expect(live.requests).toEqual(['GET /artifacts/board?download=1']);
      expect(stale.requests).toEqual([]);
      expect(decoy.requests).toEqual([]);
      expect(vi.mocked(getSidecarStatus).mock.calls).toEqual([
        [{ ...stamp, app: 'daemon' }, { timeoutMs: DAEMON_STATUS_TIMEOUT_MS }],
      ]);
    } finally {
      await handle?.stop();
      await stale.close();
      await live.close();
      await decoy.close();
      restoreStartupEnv(previous);
      vi.mocked(getSidecarStatus).mockReset();
      await rm(standaloneRoot, { force: true, recursive: true });
    }
  });

  it('keeps the explicit dev port when a stamp is present', async () => {
    const previous = snapshotStartupEnv();
    const explicit = await startMarkedDaemon('explicit');
    const reported = await startMarkedDaemon('reported');
    const stamp: SidecarStamp = {
      app: 'web',
      channel: 'local',
      mode: 'dev',
      namespace: 'dev-explicit',
      source: 'tools-dev',
    };
    delete process.env.OD_WEB_OUTPUT_MODE;
    delete process.env.OD_WEB_STANDALONE_ROOT;
    process.env.OD_PORT = String(explicit.port);
    installSiblingStatus(stamp, reported.origin, reported.origin);
    const handle = await startWebSidecar({ mode: 'dev', stamp });

    try {
      const web = await handle.status();
      const api = await fetch(new URL('/api/projects', web.url ?? ''));
      expect(api.status).toBe(200);
      expect(await api.json()).toEqual({ marker: 'explicit' });
      expect(explicit.requests).toEqual(['GET /api/projects']);
      expect(reported.requests).toEqual([]);
      expect(getSidecarStatus).not.toHaveBeenCalled();
    } finally {
      await handle.stop();
      await explicit.close();
      await reported.close();
      restoreStartupEnv(previous);
      vi.mocked(getSidecarStatus).mockReset();
    }
  });

  it('keeps the explicit environment port for an unstamped runtime', async () => {
    const previous = snapshotStartupEnv();
    const explicit = await startMarkedDaemon('explicit');
    delete process.env.OD_WEB_OUTPUT_MODE;
    delete process.env.OD_WEB_STANDALONE_ROOT;
    process.env.OD_PORT = String(explicit.port);
    vi.mocked(getSidecarStatus).mockResolvedValue({
      desktopAuthGateActive: false,
      state: 'running',
      url: 'http://127.0.0.1:9',
    });
    const handle = await startWebSidecar({ mode: 'runtime' });

    try {
      const web = await handle.status();
      const api = await fetch(new URL('/frames/preview?t=1', web.url ?? ''));
      expect(api.status).toBe(200);
      expect(await api.json()).toEqual({ marker: 'explicit' });
      expect(explicit.requests).toEqual(['GET /frames/preview?t=1']);
      expect(getSidecarStatus).not.toHaveBeenCalled();
    } finally {
      await handle.stop();
      await explicit.close();
      restoreStartupEnv(previous);
      vi.mocked(getSidecarStatus).mockReset();
    }
  });
});

describe('normalizeDaemonProxyOriginHeader', () => {
  it('normalizes the current web origin to the daemon origin', () => {
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: 'http://127.0.0.1:3000',
        webPort: 3000,
      }),
    ).toBe('http://127.0.0.1:7456');
  });

  it('accepts localhost as an equivalent loopback web origin', () => {
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: 'http://localhost:3000',
        webPort: 3000,
      }),
    ).toBe('http://127.0.0.1:7456');
  });

  it('normalizes matching private LAN browser origins to the daemon origin', () => {
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: 'http://192.168.3.23:8085',
        requestHost: '192.168.3.23:8085',
        webPort: 8085,
      }),
    ).toBe('http://127.0.0.1:7456');
  });

  it('does not normalize mismatched private LAN origins', () => {
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: 'http://192.168.3.23:8085',
        requestHost: '192.168.3.24:8085',
        webPort: 8085,
      }),
    ).toBe('http://192.168.3.23:8085');
  });

  it('normalizes matching wildcard configured dev origins to the daemon origin', () => {
    const previous = process.env.OD_ALLOWED_DEV_ORIGINS;
    process.env.OD_ALLOWED_DEV_ORIGINS = '*.local-origin.dev';
    try {
      expect(
        normalizeDaemonProxyOriginHeader({
          daemonOrigin: 'http://127.0.0.1:7456',
          origin: 'http://app.local-origin.dev:8085',
          requestHost: 'app.local-origin.dev:8085',
          webPort: 8085,
        }),
      ).toBe('http://127.0.0.1:7456');
    } finally {
      if (previous == null) delete process.env.OD_ALLOWED_DEV_ORIGINS;
      else process.env.OD_ALLOWED_DEV_ORIGINS = previous;
    }
  });

  it('does not rewrite unrelated browser origins', () => {
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: 'https://example.com',
        webPort: 3000,
      }),
    ).toBe('https://example.com');
  });

  it('preserves absent and null origins for daemon policy to handle', () => {
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: undefined,
        webPort: 3000,
      }),
    ).toBeUndefined();
    expect(
      normalizeDaemonProxyOriginHeader({
        daemonOrigin: 'http://127.0.0.1:7456',
        origin: 'null',
        webPort: 3000,
      }),
    ).toBe('null');
  });
});
