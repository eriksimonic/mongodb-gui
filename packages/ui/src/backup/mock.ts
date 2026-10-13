import {
  backupFileName,
  newId,
  sidecarPathFor,
  type BackupInspection,
  type BackupJobKind,
  type BackupNamespaceInfo,
  type BackupProgress,
  type BackupResult,
  type BackupScope,
  type BackupServerInfo,
  type BackupStartInput,
  type ConnectionStatus,
  type RestoreStartInput,
  type RpcEvent,
} from '@mongo-gui/core';
import type { MockDatabase } from '../api/mock-catalog';
import { fixtureInspection } from './mock-fixtures';
import type { MockPicks } from '../api/mock-picks';
import { fail } from '../api/mock-support';

const FRAME_DELAY_MS = 70;
const AVERAGE_OBJECT_SIZE = 420;
const BAR_WIDTH = 24;
const EMPTY_PROGRESS: Omit<BackupProgress, 'elapsedMs' | 'cancelled'> = {
  phase: 'preparing',
  documents: 0,
  bytes: 0,
  active: [],
  finishedNamespaces: 0,
  failedDocuments: 0,
  lines: [],
  warnings: [],
  done: false,
};
const MOCK_SHA = 'cd'.repeat(32);

export interface MockBackupContext {
  readonly emit: (event: RpcEvent) => void;
  readonly picks: MockPicks;
  readonly catalogOf: (connectionId: string) => MockDatabase[];
  readonly statusOf: (connectionId: string) => ConnectionStatus;
}

export interface MockBackup {
  describeServer(connectionId: string, scope: BackupScope | undefined): BackupServerInfo;
  start(input: BackupStartInput): string;
  inspect(path: string): BackupInspection;
  startRestore(input: RestoreStartInput): string;
  cancel(jobId: string): void;
  wroteFile(path: string): boolean;
}

interface Frame {
  progress: Omit<BackupProgress, 'elapsedMs' | 'cancelled'>;
  /** Runs when the frame is sent. The final frame uses it to emit catalog changes. */
  after?: () => void;
}

interface MockJob {
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Ends the job with the progress it has. */
  finish: () => void;
}

function stamp(): string {
  return `${new Date().toISOString().replace('Z', '')}+0000`;
}

function bar(namespace: string, done: number, total: number): string {
  const filled = total === 0 ? BAR_WIDTH : Math.floor((done / total) * BAR_WIDTH);
  const percent = total === 0 ? 100 : (done / total) * 100;
  return `${stamp()}\t[${'#'.repeat(filled)}${'.'.repeat(BAR_WIDTH - filled)}]  ${namespace}  ${done}/${total}  (${percent.toFixed(1)}%)`;
}

function documentWord(count: number): string {
  return count === 1 ? '1 document' : `${count} documents`;
}

function namespacesOf(
  catalog: readonly MockDatabase[],
  scope: BackupScope | undefined,
): BackupNamespaceInfo[] {
  const wanted = (database: string): boolean => {
    if (scope === undefined || scope.kind === 'server') {
      return true;
    }
    return scope.kind === 'databases'
      ? scope.databases.includes(database)
      : scope.database === database;
  };
  return catalog
    .filter((database) => wanted(database.name))
    .flatMap((database) =>
      database.collections
        .filter((item) => scope?.kind !== 'collection' || item.info.name === scope.collection)
        .map((item) => ({
          database: database.name,
          collection: item.info.name,
          type: item.info.type,
          documents: item.info.type === 'view' ? 0 : item.documents.length,
          ...(item.info.options?.capped === true ? { capped: true } : {}),
        })),
    );
}

/** The databases a scope dumps, in order. */
function scopeDatabases(scope: BackupScope, all: readonly string[]): string[] {
  switch (scope.kind) {
    case 'server':
      return [...all];
    case 'databases':
      return [...scope.databases];
    default:
      return [scope.database];
  }
}

/**
 * Runs dump and restore jobs against the mock. A job is a list of frames built up front, sent one
 * every few milliseconds. Nothing is written, but the lines, the counters, the several-database
 * progress and the cancel behave as the router does. Cancel ends the job with a cancelled frame.
 */
export function createMockBackup(context: MockBackupContext): MockBackup {
  const { emit, picks, catalogOf, statusOf } = context;
  const jobs = new Map<string, MockJob>();
  const written = new Set<string>();
  const inspected = new Map<string, BackupInspection>();

  function run(connectionId: string, kind: BackupJobKind, frames: readonly Frame[]): string {
    const jobId = newId();
    const job: MockJob = { cancelled: false, timer: undefined, finish: () => undefined };
    const startedAt = Date.now();
    let index = 0;
    let latest: Omit<BackupProgress, 'elapsedMs' | 'cancelled'> | undefined;

    const send = (progress: Omit<BackupProgress, 'elapsedMs' | 'cancelled'>): void => {
      latest = progress;
      emit({
        type: 'backup:progress',
        connectionId,
        jobId,
        kind,
        progress: {
          ...progress,
          cancelled: job.cancelled,
          elapsedMs: Math.max(0, Date.now() - startedAt),
        },
      });
    };

    const last = frames.at(-1);
    job.finish = (): void => {
      jobs.delete(jobId);
      if (job.cancelled) {
        send({
          ...(latest ?? frames[0]?.progress ?? EMPTY_PROGRESS),
          phase: 'finished',
          active: [],
          lines: [`${stamp()}\tcancelled`],
          warnings: [],
          done: true,
        });
      }
    };

    const step = (): void => {
      job.timer = undefined;
      const frame = frames[index];
      index += 1;
      if (frame === undefined) {
        return;
      }
      send(frame.progress);
      frame.after?.();
      if (frame === last) {
        jobs.delete(jobId);
        return;
      }
      job.timer = setTimeout(step, FRAME_DELAY_MS);
    };

    jobs.set(jobId, job);
    job.timer = setTimeout(step, FRAME_DELAY_MS);
    return jobId;
  }

  /** Frames that walk each namespace through writing, a progress bar and done. */
  function namespaceFrames(
    namespaces: readonly { database: string; name: string; documents: number; view: boolean }[],
    verbs: { start: (ns: string) => string; done: (ns: string, documents: number) => string },
    databases: readonly string[],
  ): { frames: Frame[]; documents: number } {
    const total = namespaces.reduce((sum, item) => sum + item.documents, 0);
    const frames: Frame[] = [];
    let documents = 0;
    let finished = 0;
    const base = (): Omit<
      BackupProgress,
      'elapsedMs' | 'cancelled' | 'lines' | 'phase' | 'active' | 'done'
    > => ({
      documents,
      totalDocuments: total,
      bytes: documents * AVERAGE_OBJECT_SIZE,
      totalBytes: total * AVERAGE_OBJECT_SIZE,
      fraction: total === 0 ? 1 : Math.min(0.95, documents / total),
      finishedNamespaces: finished,
      totalNamespaces: namespaces.length,
      failedDocuments: 0,
      warnings: [],
    });
    for (const item of namespaces) {
      const ns = `${item.database}.${item.name}`;
      const databaseIndex = databases.indexOf(item.database) + 1;
      const databaseFields =
        databases.length > 1
          ? { currentDatabase: item.database, databaseIndex, databaseCount: databases.length }
          : {};
      const active = (done: number) => [{ namespace: ns, documents: done, total: item.documents }];
      frames.push({
        progress: {
          ...base(),
          ...databaseFields,
          phase: 'running',
          active: item.view ? [] : active(0),
          lines: [`${stamp()}\t${verbs.start(ns)}`],
          done: false,
        },
      });
      if (!item.view) {
        const half = Math.floor(item.documents / 2);
        documents += half;
        frames.push({
          progress: {
            ...base(),
            ...databaseFields,
            phase: 'running',
            active: active(half),
            lines: [bar(ns, half, item.documents)],
            done: false,
          },
        });
        documents += item.documents - half;
      }
      finished += 1;
      frames.push({
        progress: {
          ...base(),
          ...databaseFields,
          phase: 'running',
          active: [],
          lines: [`${stamp()}\t${verbs.done(ns, item.documents)}`],
          done: false,
        },
      });
    }
    return { frames, documents };
  }

  return {
    describeServer(connectionId, scope) {
      const status = statusOf(connectionId);
      const catalog = catalogOf(connectionId);
      const namespaces = scope === undefined ? [] : namespacesOf(catalog, scope);
      return {
        serverVersion: status.state === 'connected' ? status.serverVersion : '8.0.4',
        fcv: '8.0',
        storageEngine: 'wiredTiger',
        topology: status.state === 'connected' ? status.topology : 'standalone',
        ...(status.state === 'connected' && status.setName !== undefined
          ? { setName: status.setName }
          : {}),
        directConnection: status.state === 'connected' && status.directConnection === true,
        hosts: status.state === 'connected' ? [...status.hosts] : [],
        databases: catalog.map((database) => database.name),
        namespaces,
        namespacesTruncated: false,
      };
    },

    start(input) {
      picks.requireFolder(input.folder);
      const catalog = catalogOf(input.connectionId);
      const all = namespacesOf(catalog, input.scope);
      const names = scopeDatabases(
        input.scope,
        catalog.map((database) => database.name),
      );
      const sep = input.folder.includes('\\') && !input.folder.includes('/') ? '\\' : '/';
      const fileName = backupFileName(input.name, input.options);
      const outputPath = `${input.folder.replace(/[\\/]$/, '')}${sep}${fileName}`;
      const kind = input.options.output;
      const sidecarPath = sidecarPathFor(outputPath, kind);
      const toArchive = kind === 'archive' ? 'archive on stdout' : `${fileName}/`;
      const items = all
        .filter((item) => !input.options.excludeCollections.includes(item.collection))
        .map((item) => ({
          database: item.database,
          name: item.collection,
          documents: item.documents ?? 0,
          view: item.type === 'view',
        }));
      const { frames, documents } = namespaceFrames(
        items,
        {
          start: (ns) => `writing \`${ns}\` to \`${toArchive}\``,
          done: (ns, count) => `done dumping \`${ns}\` (${documentWord(count)})`,
        },
        names,
      );
      const bytes = documents * AVERAGE_OBJECT_SIZE;
      const tail = {
        documents,
        totalDocuments: documents,
        bytes,
        totalBytes: bytes,
        finishedNamespaces: items.length,
        totalNamespaces: items.length,
        failedDocuments: 0,
        active: [],
        lines: [],
        warnings: [],
      };
      const result: BackupResult = {
        kind: 'dump',
        outputPath,
        sidecarPath,
        bytes,
        ...(kind === 'archive' ? { sha256: MOCK_SHA } : {}),
        documents,
        namespaces: items.length,
      };
      frames.push(
        { progress: { ...tail, phase: 'hashing', fraction: 0.96, done: false } },
        { progress: { ...tail, phase: 'writing-sidecar', fraction: 0.99, done: false } },
        {
          progress: { ...tail, phase: 'finished', fraction: 1, done: true, result },
          after: () => {
            written.add(outputPath);
            written.add(sidecarPath);
          },
        },
      );
      return run(input.connectionId, 'dump', [
        {
          progress: {
            ...tail,
            documents: 0,
            bytes: 0,
            finishedNamespaces: 0,
            phase: 'preparing',
            done: false,
          },
        },
        ...frames,
      ]);
    },

    inspect(path) {
      picks.requireOpenedOrFolder(path);
      const inspection = fixtureInspection(path);
      inspected.set(inspection.path, inspection);
      return inspection;
    },

    startRestore(input) {
      const inspection = inspected.get(input.source);
      if (inspection === undefined) {
        throw fail('VALIDATION', 'Inspect the backup before restoring it.');
      }
      const { options } = input;
      const selected = inspection.namespaces.filter(
        (item) =>
          options.include === undefined ||
          options.include.some(
            (selector) =>
              selector === `${item.database}.*` ||
              selector === `${item.database}.${item.collection}`,
          ),
      );
      const target = (database: string): string =>
        options.renames.find((rename) => rename.from === database)?.to ?? database;
      const items = selected.map((item) => ({
        database: target(item.database),
        name: item.collection,
        documents: item.documents ?? 0,
        view: item.type === 'view',
        from: item.database,
      }));
      const databases = [...new Set(items.map((item) => item.database))];
      const { frames, documents } = namespaceFrames(
        items,
        {
          start: (ns) => (options.dryRun ? `would restore ${ns}` : `restoring ${ns} from archive`),
          done: (ns, count) =>
            options.dryRun
              ? `would finish restoring ${ns} (${documentWord(count)})`
              : `finished restoring ${ns} (${documentWord(count)}, 0 failures)`,
        },
        databases,
      );
      const bytes = documents * AVERAGE_OBJECT_SIZE;
      const result: BackupResult = {
        kind: 'restore',
        dryRun: options.dryRun,
        restored: options.dryRun ? 0 : documents,
        failed: 0,
        databases,
        plan: options.dryRun
          ? items.map((item) => ({
              from: `${item.from}.${item.name}`,
              to: `${item.database}.${item.name}`,
            }))
          : [],
      };
      const connectionId = input.connectionId;
      frames.push({
        progress: {
          phase: 'finished',
          documents,
          totalDocuments: documents,
          bytes,
          totalBytes: bytes,
          fraction: 1,
          active: [],
          finishedNamespaces: items.length,
          totalNamespaces: items.length,
          failedDocuments: 0,
          lines: [],
          warnings: [],
          done: true,
          result,
        },
        after: () => {
          if (!options.dryRun) {
            for (const database of databases) {
              emit({ type: 'catalog:changed', connectionId, database });
            }
          }
        },
      });
      return run(connectionId, 'restore', [
        {
          progress: {
            phase: 'preparing',
            documents: 0,
            bytes: 0,
            active: [],
            finishedNamespaces: 0,
            failedDocuments: 0,
            lines: [`${stamp()}\tpreparing collections to restore from`],
            warnings: [],
            done: false,
          },
        },
        ...frames,
      ]);
    },

    cancel(jobId) {
      const job = jobs.get(jobId);
      if (job === undefined) {
        return;
      }
      job.cancelled = true;
      if (job.timer !== undefined) {
        clearTimeout(job.timer);
        job.timer = undefined;
      }
      job.finish();
    },

    wroteFile(path) {
      return written.has(path);
    },
  };
}
