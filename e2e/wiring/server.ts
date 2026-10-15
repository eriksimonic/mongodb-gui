// Wiring layer server. The real main-process router runs in this Node process, loaded from source
// with Vite's ssrLoadModule. The server also serves the built renderer and the RPC endpoint.
// Nothing here imports Electron.
import { fork } from 'node:child_process';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as ChildModule from '../../packages/app/src/main/shell/child';
import type * as ServicesModule from '../../packages/app/src/main/rpc/app-services';
import type * as RouterModule from '../../packages/app/src/main/rpc/router';
import type * as DialogPicksModule from '../../packages/app/src/main/dialog-picks';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const appRoot = join(repoRoot, 'packages/app');
const rendererDir = join(appRoot, 'out/renderer');
const shellRuntimePath = join(appRoot, 'out/main/shell-runtime.cjs');
const faviconPath = join(appRoot, 'build/icon.png');
const wiringDataDir = join(repoRoot, 'e2e/output/wiring-data');
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };

export const WIRING_PASSWORD = 'wiring vault password';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export interface RouterModules {
  readonly router: typeof RouterModule;
  readonly services: typeof ServicesModule;
  readonly child: typeof ChildModule;
  readonly dialogPicks: typeof DialogPicksModule;
}

export interface ModuleLoader {
  readonly modules: RouterModules;
  close(): Promise<void>;
}

export interface UnexpectedOutcome {
  readonly method: string;
  readonly code: string;
  readonly message: string;
}

export interface WiringServerOptions {
  readonly modules: RouterModules;
  readonly mongoUri: string;
  /** Lets the docker runtime use the host engine. Off by default, so tests stay off it. */
  readonly realDocker?: boolean;
}

export interface WiringServer {
  readonly url: string;
  /** Results the UI should never get: INTERNAL, or a call the router rejects as unknown or invalid. */
  readonly unexpectedOutcomes: UnexpectedOutcome[];
  /** Queues paths for the next file dialogs. Each open or save dialog takes one. Empty cancels. */
  setDialogPicks(paths: readonly string[]): void;
  stop(): Promise<void>;
}

interface ViteLike {
  ssrLoadModule(url: string): Promise<unknown>;
  close(): Promise<void>;
}

interface RpcOutcome {
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly message: string };
}

/** Loads the router, its services and the shell child from source. Run once per worker. */
export async function loadRouterModules(): Promise<ModuleLoader> {
  const requireFromApp = createRequire(join(appRoot, 'package.json'));
  // Imported by path so this file needs no type dependency on vite.
  const vite = (await import(pathToFileURL(requireFromApp.resolve('vite')).href)) as {
    createServer(options: object): Promise<ViteLike>;
  };
  const server = await vite.createServer({
    configFile: false,
    root: appRoot,
    appType: 'custom',
    logLevel: 'warn',
    server: { middlewareMode: true, hmr: false },
  });
  const load = (file: string) => server.ssrLoadModule(join(appRoot, 'src/main', file));
  const modules: RouterModules = {
    router: (await load('rpc/router.ts')) as RouterModules['router'],
    services: (await load('rpc/app-services.ts')) as RouterModules['services'],
    child: (await load('shell/child.ts')) as RouterModules['child'],
    dialogPicks: (await load('dialog-picks.ts')) as RouterModules['dialogPicks'],
  };
  return { modules, close: () => server.close() };
}

/** Starts a router, vault and user-data folder of its own, on a free port. */
export async function startWiringServer({
  modules,
  mongoUri,
  realDocker = false,
}: WiringServerOptions): Promise<WiringServer> {
  mkdirSync(wiringDataDir, { recursive: true });
  const userDataDir = mkdtempSync(join(wiringDataDir, 'run-'));
  const {
    router: routerModule,
    services: servicesModule,
    child: childModule,
    dialogPicks: dialogPicksModule,
  } = modules;
  // The dialogs can be re-scripted per test, so the router calls through this variable.
  let dialogs = dialogPicksModule.scriptedDialogs('[]');

  const services = servicesModule.createAppServices({
    userDataDir,
    kdf: FAST_KDF,
    failureDelayMs: 0,
    spillBases: [userDataDir],
    // A missing socket keeps the docker runtime off the host engine. A real docker test skips it.
    ...(realDocker ? {} : { dockerSocketPath: join(userDataDir, 'no-docker.sock') }),
    // Tools live in packages/app in development. resourcesPath is read only when packaged.
    tools: {
      isPackaged: false,
      resourcesPath: appRoot,
      appRoot,
      appVersion: 'wiring',
      fetchImpl: (input, init) => fetch(input, init),
    },
    // Electron uses utilityProcess.fork. A Node child process speaks the same protocol.
    shell: {
      entryPath: shellRuntimePath,
      fork: (request) => {
        const child = fork(request.entryPath, [], {
          env: { ...request.env },
          execArgv: [...request.execArgv],
          silent: true,
        });
        // Piped output must be read, or a long run can block on a full pipe.
        child.stdout?.resume();
        child.stderr?.resume();
        return childModule.fromChildProcess(child);
      },
    },
  });

  const sseClients = new Set<ServerResponse>();
  const unexpectedOutcomes: UnexpectedOutcome[] = [];
  const tracePath = process.env['MONGO_GUI_RPC_TRACE'];
  const router = routerModule.createRouter({
    ...services,
    onEvent: (event) => {
      const frame = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of sseClients) {
        client.write(frame);
      }
    },
    openExternal: async () => undefined,
    versions: () => ({
      app: 'wiring',
      electron: 'none',
      chrome: 'none',
      node: process.versions.node,
    }),
    // Stand-ins for the native file dialogs. They take picks from setDialogPicks and cancel when empty.
    dialogs: {
      showOpenDialog: (input) => dialogs.showOpenDialog(input),
      showSaveDialog: (input) => dialogs.showSaveDialog(input),
      showItemInFolder: () => undefined,
    },
    startup: {
      read: () => ({ disableGpu: false }),
      write: () => undefined,
      restart: () => undefined,
    },
    ...(tracePath ? { rpcTracePath: tracePath } : {}),
  });

  await expectOk(router.handle('vault.initialise', { password: WIRING_PASSWORD }));
  await expectOk(router.handle('connections.create', { name: 'Local dev', uri: mongoUri }));
  // The same URI with the password removed, so the secured-connect journey gets a password prompt.
  // A string replace, not URL parsing: WHATWG URL rejects multi-host (replica set) URIs.
  // A URI without credentials comes back unchanged.
  const securedUri = mongoUri.replace(/^mongodb:\/\/([^:@/]+):[^@/]*@/, 'mongodb://$1@');
  await expectOk(router.handle('connections.create', { name: 'Secured dev', uri: securedUri }));

  const http = createHttpServer((req, res) => {
    if (req.method === 'POST' && req.url === '/__e2e/rpc') {
      void handleRpc(req, res, router, unexpectedOutcomes);
      return;
    }
    if (req.method === 'GET' && req.url === '/__e2e/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': open\n\n');
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
        // Electron resets on navigation and reload. A closed stream is the browser equivalent.
        if (sseClients.size === 0) {
          router.resetRenderer();
        }
      });
      return;
    }
    serveRenderer(req, res);
  });

  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    unexpectedOutcomes,
    setDialogPicks(paths) {
      dialogs = dialogPicksModule.scriptedDialogs(JSON.stringify(paths));
    },
    async stop() {
      // Clear first. Locking the vault below emits events, and a write to an ended stream throws.
      const clients = [...sseClients];
      sseClients.clear();
      for (const client of clients) {
        client.end();
      }
      router.resetRenderer();
      services.vault.lock();
      await services.dispose();
      await new Promise<void>((done) => {
        http.close(() => done());
        http.closeAllConnections();
      });
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** Serves files from the built renderer. Unknown paths and types get a 404. */
function serveRenderer(req: IncomingMessage, res: ServerResponse): void {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  // The browser asks for an icon on its own. The app icon stands in, so the request is not a 404.
  if (pathname === '/favicon.ico') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(readFileSync(faviconPath));
    return;
  }
  const file = resolve(rendererDir, pathname === '/' ? 'index.html' : pathname.slice(1));
  const type = CONTENT_TYPES[extname(file)];
  const isFile =
    file.startsWith(rendererDir + sep) && statSync(file, { throwIfNoEntry: false })?.isFile();
  if (type === undefined || !isFile) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': type });
  res.end(readFileSync(file));
}

async function handleRpc(
  req: IncomingMessage,
  res: ServerResponse,
  router: { handle(method: string, input: unknown): Promise<unknown> },
  unexpectedOutcomes: UnexpectedOutcome[],
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  let method = '';
  let result: RpcOutcome;
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      method: string;
      input?: unknown;
    };
    method = body.method;
    result = (await router.handle(body.method, body.input)) as RpcOutcome;
  } catch (error) {
    result = {
      ok: false,
      error: { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) },
    };
  }
  if (!result.ok && result.error !== undefined && isUnexpected(result.error)) {
    unexpectedOutcomes.push({ method, code: result.error.code, message: result.error.message });
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}

/** The router rejects these two messages when the UI sends a call it does not know, a wiring bug. */
function isUnexpected(error: { code: string; message: string }): boolean {
  if (error.code === 'INTERNAL') {
    return true;
  }
  return (
    error.code === 'VALIDATION' &&
    (error.message === 'The input is invalid.' || error.message === 'The method is not known.')
  );
}

async function expectOk(pending: Promise<unknown>): Promise<void> {
  const result = (await pending) as RpcOutcome;
  if (!result.ok) {
    throw new Error(`seed failed: ${JSON.stringify(result)}`);
  }
}
