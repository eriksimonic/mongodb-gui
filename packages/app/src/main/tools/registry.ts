import { lstat, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  AppErrorException,
  appError,
  compareVersions,
  ToolsInstallManifestSchema,
  type AppError,
  type ToolsInstall,
  type ToolsInstallId,
  type ToolsInstallManifest,
  type ToolsLicenceOutput,
  type ToolsListOutput,
  type ToolsPlatform,
  type ToolsPreference,
} from '@mongo-gui/core';
import { binaryName, type ToolsRoots } from './paths';
import { probeTools, type ProbeResult, type SpawnFn } from './probe';

export interface ToolsRegistryDeps {
  readonly roots: ToolsRoots;
  readonly spawn: SpawnFn;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  // Part of the shared wiring with the download service. The registry itself reads no clock.
  readonly now?: () => Date;
  // Environment for the probe. Defaults to the tool allow-list of process.env.
  readonly env?: Record<string, string>;
}

// A healthy install picked for a job, with the paths of its two binaries.
export interface ResolvedTools {
  readonly install: ToolsInstall;
  readonly dir: string;
  readonly mongodump: string;
  readonly mongorestore: string;
}

export interface ToolsRegistry {
  list(preference: ToolsPreference): Promise<ToolsListOutput>;
  resolve(version: string): Promise<ResolvedTools>;
  resolvePreferred(preference: ToolsPreference): Promise<ResolvedTools>;
  remove(id: ToolsInstallId): Promise<void>;
  licence(id: ToolsInstallId): Promise<ToolsLicenceOutput>;
  // Marks a version as used by a running job until the returned function is called.
  markInUse(version: string): () => void;
  // Removes leftovers of an earlier run: staging folders, partial downloads and temp configs.
  sweep(): Promise<void>;
}

interface Scanned {
  readonly dir: string;
  readonly install: Omit<ToolsInstall, 'inUse'>;
}

const MANIFEST = 'install.json';
const LICENCE_CAP = 256 * 1024;
const NOTICES_CAP = 2 * 1024 * 1024;
const FOLDER_VERSION = /^(\d{1,4}\.\d{1,4}\.\d{1,4})-/;

export function createToolsRegistry(deps: ToolsRegistryDeps): ToolsRegistry {
  const { roots, platform } = deps;
  const os: ToolsPlatform['os'] =
    platform === 'win32' || platform === 'darwin' ? platform : 'linux';
  const arch: ToolsPlatform['arch'] = deps.arch === 'arm64' ? 'arm64' : 'x64';
  const bundledSupported = (os === 'linux' || os === 'win32') && arch === 'x64';
  const probes = new Map<string, { mtimeMs: number; result: Promise<ProbeResult> }>();
  const inUse = new Map<string, number>();

  // Probes each folder once per run. A replaced binary has a new mtime and is probed again.
  async function probeCached(dir: string): Promise<ProbeResult> {
    const binDir = join(dir, 'bin');
    const mtimeMs = await stat(join(binDir, binaryName('mongodump', platform))).then(
      (info) => info.mtimeMs,
      () => -1,
    );
    const cached = probes.get(dir);
    if (cached && cached.mtimeMs === mtimeMs) return cached.result;
    const result = probeTools(binDir, deps.spawn, platform, deps.env ? { env: deps.env } : {});
    probes.set(dir, { mtimeMs, result });
    return result;
  }

  async function scanFolder(
    dir: string,
    source: 'bundled' | 'downloaded',
  ): Promise<Scanned | undefined> {
    const manifest = await readManifest(dir);
    const probe = await probeCached(dir);
    const version =
      manifest?.version ??
      (probe.ok ? probe.version : undefined) ??
      (source === 'downloaded' ? FOLDER_VERSION.exec(basename(dir))?.[1] : undefined);
    // Without a version the folder cannot have an id, so it is not listed.
    if (!version) return undefined;
    let health: ToolsInstall['health'] = { state: 'ok' };
    if (!manifest) {
      health = broken(appError('VALIDATION', `${MANIFEST} is missing or not valid.`));
    } else if (!probe.ok) {
      health = broken(probe.error);
    } else if (probe.version !== manifest.version) {
      health = broken(
        appError(
          'VALIDATION',
          `mongodump reports ${probe.version}, but ${MANIFEST} says ${manifest.version}.`,
        ),
      );
    }
    const gitVersion = manifest?.gitVersion ?? (probe.ok ? probe.gitVersion : undefined);
    return {
      dir,
      install: {
        id: source === 'bundled' ? 'bundled' : `downloaded:${version}`,
        source,
        version,
        ...(manifest ? { target: manifest.target, installedAt: manifest.installedAt } : {}),
        ...(gitVersion ? { gitVersion } : {}),
        location: dir,
        sizeBytes: await folderSize(dir),
        health,
      },
    };
  }

  // Every install folder, including several downloaded folders for one version.
  async function scanAll(): Promise<Scanned[]> {
    const found: Scanned[] = [];
    if (await isDirectory(roots.bundled)) {
      const bundled = await scanFolder(roots.bundled, 'bundled');
      if (bundled) found.push(bundled);
    }
    const names = await childDirectories(roots.downloaded);
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const scanned = await scanFolder(join(roots.downloaded, name), 'downloaded');
      if (scanned) found.push(scanned);
    }
    return found;
  }

  // One entry per id. A healthy folder wins over a broken one with the same version.
  async function scan(): Promise<Scanned[]> {
    const byId = new Map<string, Scanned>();
    for (const scanned of await scanAll()) {
      const existing = byId.get(scanned.install.id);
      if (
        !existing ||
        (existing.install.health.state !== 'ok' && scanned.install.health.state === 'ok')
      ) {
        byId.set(scanned.install.id, scanned);
      }
    }
    return [...byId.values()].sort(
      (a, b) =>
        compareVersions(b.install.version, a.install.version) ||
        (a.install.source === 'bundled' ? -1 : 0) - (b.install.source === 'bundled' ? -1 : 0),
    );
  }

  function isInUse(version: string): boolean {
    return (inUse.get(version) ?? 0) > 0;
  }

  function toResolved(scanned: Scanned): ResolvedTools {
    const binDir = join(scanned.dir, 'bin');
    return {
      install: { ...scanned.install, inUse: isInUse(scanned.install.version) },
      dir: scanned.dir,
      mongodump: join(binDir, binaryName('mongodump', platform)),
      mongorestore: join(binDir, binaryName('mongorestore', platform)),
    };
  }

  // Bundled before downloaded for a version. 'auto', or a pinned version that is not installed,
  // takes the healthy bundled install, else the newest healthy downloaded one.
  function pick(installs: Scanned[], preference: ToolsPreference): Scanned | undefined {
    const healthy = installs.filter((scanned) => scanned.install.health.state === 'ok');
    if (preference !== 'auto') {
      const exact = healthy.find((scanned) => scanned.install.version === preference);
      if (exact) return exact;
    }
    return healthy.find((scanned) => scanned.install.source === 'bundled') ?? healthy[0];
  }

  return {
    async list(preference) {
      const installs = await scan();
      const resolved = pick(installs, preference);
      return {
        platform: { os, arch },
        bundledSupported,
        installs: installs.map((scanned) => ({
          ...scanned.install,
          inUse: isInUse(scanned.install.version),
        })),
        preference,
        ...(resolved ? { resolved: resolved.install.version } : {}),
      };
    },

    async resolve(version) {
      const found = (await scan()).find(
        (scanned) => scanned.install.version === version && scanned.install.health.state === 'ok',
      );
      if (!found) {
        throw new AppErrorException(
          appError('NOT_FOUND', `MongoDB Database Tools ${version} are not installed.`),
        );
      }
      return toResolved(found);
    },

    async resolvePreferred(preference) {
      const found = pick(await scan(), preference);
      if (!found) {
        throw new AppErrorException(
          appError('NOT_FOUND', 'MongoDB Database Tools are not installed.'),
        );
      }
      return toResolved(found);
    },

    async remove(id) {
      if (!id.startsWith('downloaded:')) {
        throw new AppErrorException(
          appError('VALIDATION', 'The bundled MongoDB Database Tools cannot be removed.'),
        );
      }
      const version = id.slice('downloaded:'.length);
      const folders = (await scanAll()).filter((scanned) => scanned.install.id === id);
      if (folders.length === 0) {
        throw new AppErrorException(
          appError('NOT_FOUND', `MongoDB Database Tools ${version} are not installed.`),
        );
      }
      if (isInUse(version)) {
        throw new AppErrorException(
          appError('VALIDATION', `MongoDB Database Tools ${version} are in use by a running job.`),
        );
      }
      const root = await realpath(roots.downloaded);
      for (const { dir } of folders) {
        // Deletes only a real folder directly inside the downloaded root, never through a link.
        const real = await realpath(dir);
        if (dirname(real) !== root || real === root) {
          throw new AppErrorException(
            appError(
              'VALIDATION',
              `Refusing to remove ${dir}: it is not inside ${roots.downloaded}.`,
            ),
          );
        }
        await rm(real, { recursive: true, force: true });
        probes.delete(dir);
      }
    },

    async licence(id) {
      const found = (await scan()).find((scanned) => scanned.install.id === id);
      if (!found) {
        throw new AppErrorException(
          appError('NOT_FOUND', 'These MongoDB Database Tools are not installed.'),
        );
      }
      const licence = await readCapped(join(found.dir, 'LICENSE.md'), LICENCE_CAP);
      if (licence === undefined) {
        throw new AppErrorException(
          appError(
            'NOT_FOUND',
            `The licence of MongoDB Database Tools ${found.install.version} is missing.`,
          ),
        );
      }
      const thirdPartyNotices =
        (await readCapped(join(found.dir, 'THIRD-PARTY-NOTICES'), NOTICES_CAP)) ?? '';
      return { version: found.install.version, licence, thirdPartyNotices };
    },

    markInUse(version) {
      inUse.set(version, (inUse.get(version) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = (inUse.get(version) ?? 1) - 1;
        if (count > 0) inUse.set(version, count);
        else inUse.delete(version);
      };
    },

    async sweep() {
      for (const name of await childNames(roots.downloaded)) {
        if (name.startsWith('.staging-') || name.endsWith('.partial')) {
          await rm(join(roots.downloaded, name), { recursive: true, force: true });
        }
      }
      for (const name of await childNames(roots.tmp)) {
        if (name.startsWith('tools-')) {
          await rm(join(roots.tmp, name), { recursive: true, force: true });
        }
      }
    },
  };
}

function broken(error: AppError): ToolsInstall['health'] {
  return { state: 'broken', error };
}

async function readManifest(dir: string): Promise<ToolsInstallManifest | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8'));
    const parsed = ToolsInstallManifestSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

async function childNames(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}

// Real folders only. A symbolic link in the downloaded root is ignored.
async function childDirectories(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function folderSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await folderSize(path);
    else if (entry.isFile())
      total += await lstat(path).then(
        (info) => info.size,
        () => 0,
      );
  }
  return total;
}

// Reads at most maxBytes of a text file. Undefined when the file cannot be read.
async function readCapped(path: string, maxBytes: number): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, 'r');
    const size = Math.min((await handle.stat()).size, maxBytes);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').slice(0, maxBytes);
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}
