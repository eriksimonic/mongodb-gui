import { closeSync, createReadStream, openSync, readSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { gunzipSync, createGunzip } from 'node:zlib';
import {
  appError,
  AppErrorException,
  detectArchiveKind,
  parseSidecar,
  sidecarPathFor,
  type BackupInspection,
  type BackupNamespaceInfo,
  type BackupSidecar,
} from '@mongo-gui/core';
import type { ArchivePrelude } from '@mongo-gui/mongo-adapter';
import { listFiles } from './file-hash';

const MAX_PRELUDE_BYTES = 64 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 32 * 1024 * 1024;
const MAX_NAMESPACES = 5000;

export interface InspectDeps {
  readPrelude: (bytes: Uint8Array) => ArchivePrelude;
}

type Namespace = BackupNamespaceInfo;

function invalid(message: string): AppErrorException {
  return new AppErrorException(appError('VALIDATION', message));
}

/**
 * Describes a backup the user picked. A `.json` path maps to the archive beside it. Problems with the
 * sidecar are reported in the result and never thrown, the dump itself can still be restored.
 */
export async function inspectBackup(path: string, deps: InspectDeps): Promise<BackupInspection> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new AppErrorException(appError('NOT_FOUND', 'The backup was not found.'));
  }
  if (info.isDirectory()) return inspectDirectory(path);
  if (!info.isFile()) throw invalid('Choose a backup file or a dump folder.');
  const archivePath = path.endsWith('.json') ? path.slice(0, -'.json'.length) : path;
  if (archivePath !== path) {
    try {
      if (!statSync(archivePath).isFile()) throw new Error('not a file');
    } catch {
      throw new AppErrorException(
        appError('NOT_FOUND', 'The archive for this description was not found.'),
      );
    }
  }
  return inspectArchive(archivePath, deps);
}

async function readSidecar(
  path: string,
): Promise<{ sidecar?: BackupSidecar; sidecarProblem?: string }> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return {};
    size = info.size;
  } catch {
    return {};
  }
  if (size > MAX_SIDECAR_BYTES) return { sidecarProblem: 'The backup description is too large' };
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { sidecarProblem: 'The backup description is not valid JSON' };
  }
  const parsed = parseSidecar(value);
  return 'sidecar' in parsed ? { sidecar: parsed.sidecar } : { sidecarProblem: parsed.problem };
}

function sidecarNamespaces(sidecar: BackupSidecar): Namespace[] {
  return sidecar.databases.flatMap((db) =>
    db.collections.map((c) => ({
      database: db.name,
      collection: c.name,
      type: c.type,
      documents: c.documents,
      ...(c.capped === undefined ? {} : { capped: c.capped }),
      ...(c.clustered === undefined ? {} : { clustered: c.clustered }),
      ...(c.encrypted === undefined ? {} : { encrypted: c.encrypted }),
    })),
  );
}

// Reads the start of the (inflated) archive until the prelude is complete or the limit is reached.
async function readArchiveStart(path: string, gzip: boolean): Promise<Uint8Array> {
  const source = createReadStream(path);
  const stream = gzip ? source.pipe(createGunzip()) : source;
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      chunks.push(buffer);
      total += buffer.byteLength;
      if (total >= MAX_PRELUDE_BYTES) break;
    }
  } catch (cause) {
    // A damaged tail is not a problem when the start was already read.
    if (total === 0) throw cause;
  } finally {
    source.destroy();
    if (stream !== source) stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, MAX_PRELUDE_BYTES);
}

async function inspectArchive(path: string, deps: InspectDeps): Promise<BackupInspection> {
  const bytes = (await stat(path)).size;
  const first = Buffer.alloc(4);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, first, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  const kind = detectArchiveKind(first);
  if (kind === 'unknown') throw invalid('This file is not a mongodump archive.');
  const gzip = kind === 'gzip';

  let prelude: ArchivePrelude;
  try {
    prelude = deps.readPrelude(await readArchiveStart(path, gzip));
  } catch (cause) {
    throw invalid(
      `The archive could not be read. ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const side = await readSidecar(sidecarPathFor(path, 'archive'));
  const namespaces: Namespace[] = side.sidecar
    ? sidecarNamespaces(side.sidecar)
    : prelude.namespaces.map((n) => ({ ...n }));
  const hasPrelude = prelude.serverVersion !== undefined || prelude.toolsVersion !== undefined;
  return {
    path,
    kind: 'archive',
    gzip,
    bytes,
    ...side,
    ...(hasPrelude
      ? {
          prelude: {
            ...(prelude.serverVersion === undefined
              ? {}
              : { serverVersion: prelude.serverVersion }),
            ...(prelude.toolsVersion === undefined ? {} : { toolsVersion: prelude.toolsVersion }),
          },
        }
      : {}),
    namespaces: namespaces.slice(0, MAX_NAMESPACES),
    hasOplog: side.sidecar?.oplog ?? false,
    hasUsersAndRoles:
      side.sidecar?.usersAndRoles ??
      namespaces.some((n) => n.database === 'admin' && n.collection === 'system.users'),
  };
}

const OPLOG_FILE = /^oplog\.bson(\.gz)?$/;
const DATA_FILE = /\.(bson|metadata\.json)(\.gz)?$/;

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

// Collection name and kind of file for one name in a database folder, or undefined for other files.
function parseDataFile(file: string): { name: string; metadata: boolean; gz: boolean } | undefined {
  const match = DATA_FILE.exec(file);
  if (!match) return undefined;
  const name = file.slice(0, match.index);
  if (name === '' || name.startsWith('$')) return undefined;
  return {
    name: decodeName(name),
    metadata: match[1] === 'metadata.json',
    gz: match[2] !== undefined,
  };
}

async function inspectDirectory(path: string): Promise<BackupInspection> {
  const files = await listFiles(path);
  const top = files.filter((f) => !f.includes('/'));
  const layout: 'root' | 'database' = top.some((f) => DATA_FILE.test(f) && !OPLOG_FILE.test(f))
    ? 'database'
    : 'root';

  // Database name to the file names inside its folder.
  const dbs = new Map<string, string[]>();
  if (layout === 'database') {
    dbs.set(decodeName(basename(path)), top);
  } else {
    for (const file of files) {
      const slash = file.indexOf('/');
      if (slash < 0 || file.indexOf('/', slash + 1) >= 0) continue;
      const db = decodeName(file.slice(0, slash));
      const list = dbs.get(db) ?? [];
      list.push(file.slice(slash + 1));
      dbs.set(db, list);
    }
  }

  const namespaces: Namespace[] = [];
  let gzip = false;
  let hasUsersAndRoles = false;
  for (const [database, names] of dbs) {
    const bson = new Set<string>();
    const metadata = new Set<string>();
    for (const file of names) {
      if (/^\$admin\.system\.users\.bson(\.gz)?$/.test(file)) hasUsersAndRoles = true;
      const parsed = parseDataFile(file);
      if (!parsed) continue;
      if (parsed.gz) gzip = true;
      (parsed.metadata ? metadata : bson).add(parsed.name);
    }
    if (database === 'admin' && bson.has('system.users')) hasUsersAndRoles = true;
    const all = new Set([...bson, ...metadata]);
    for (const name of [...all].sort()) {
      if (name.startsWith('system.buckets.')) {
        namespaces.push({
          database,
          collection: name.slice('system.buckets.'.length),
          type: 'timeseries',
        });
      } else if (!bson.has(name)) {
        namespaces.push({ database, collection: name, type: 'view' });
      } else {
        namespaces.push({ database, collection: name, type: 'collection' });
      }
    }
  }
  const hasOplog = top.some((f) => OPLOG_FILE.test(f)) && layout === 'root';
  if (hasOplog) gzip ||= top.includes('oplog.bson.gz');

  const prelude = await readDirectoryPrelude(path, files);
  const side = await readSidecar(sidecarPathFor(path, 'directory'));
  let bytes = 0;
  for (const file of files) bytes += (await stat(join(path, ...file.split('/')))).size;

  const final = side.sidecar ? sidecarNamespaces(side.sidecar) : namespaces;
  return {
    path,
    kind: 'directory',
    layout,
    gzip,
    bytes,
    ...side,
    ...(prelude === undefined ? {} : { prelude }),
    namespaces: final.slice(0, MAX_NAMESPACES),
    hasOplog,
    hasUsersAndRoles,
  };
}

// prelude.json sits at the root of the picked folder, which is a dump root or a database folder.
async function readDirectoryPrelude(
  path: string,
  files: string[],
): Promise<BackupInspection['prelude']> {
  const pattern = /(^|\/)prelude\.json(\.gz)?$/;
  const name =
    files.find((f) => !f.includes('/') && pattern.test(f)) ?? files.find((f) => pattern.test(f));
  if (name === undefined) return undefined;
  try {
    const raw = await readFile(join(path, ...name.split('/')));
    if (raw.byteLength > MAX_SIDECAR_BYTES) return undefined;
    const text = (name.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
    const value: unknown = JSON.parse(text);
    return pickVersions(value);
  } catch {
    return undefined;
  }
}

function pickVersions(value: unknown): BackupInspection['prelude'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const header = [record.Header, record.header, record].find(
    (v): v is Record<string, unknown> => typeof v === 'object' && v !== null,
  );
  const pick = (...keys: string[]): string | undefined => {
    for (const source of [header, record]) {
      for (const key of keys) {
        const found = source?.[key];
        if (typeof found === 'string' && found.length <= 64) return found;
      }
    }
    return undefined;
  };
  const serverVersion = pick('server_version', 'serverVersion', 'ServerVersion');
  const toolsVersion = pick('tool_version', 'toolVersion', 'ToolVersion');
  if (serverVersion === undefined && toolsVersion === undefined) return undefined;
  return {
    ...(serverVersion === undefined ? {} : { serverVersion }),
    ...(toolsVersion === undefined ? {} : { toolsVersion }),
  };
}
