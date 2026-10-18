import type { ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import {
  appError,
  AppErrorException,
  applyRenames,
  assessBackup,
  assessRestore,
  backupFileName,
  dumpArgs,
  dumpOptionProblems,
  dumpRunScopes,
  includedNamespaces,
  newId,
  normaliseRestoreOptions,
  restoreArgs,
  restoreOptionProblems,
  sidecarPathFor,
  toolsConfigYaml,
  unresolvedFindings,
  uriHosts,
  uriWithoutCredentials,
  type AppError,
  type BackupInspection,
  type BackupJobKind,
  type BackupResult,
  type BackupServerInfo,
  type BackupSidecar,
  type BackupStartInput,
  type DumpFacts,
  type Finding,
  type RestoreOptions,
  type RestoreStartInput,
  type RpcEvent,
} from '@mongo-gui/core';
import { mapDriverError, redactPassword } from '@mongo-gui/mongo-adapter';
import { log as defaultLog, type Logger } from '../log';
import { redactText } from '../redact';
import type { SpawnFn } from '../tools/probe';
import type { ResolvedTools, ToolsRegistry } from '../tools/registry';
import { toolEnv } from '../tools/tool-env';
import type { ToolsEndpoint } from './endpoint';
import { hashDirectory, hashFile, listFiles } from './file-hash';
import { createProgressTracker, type ProgressTracker } from './progress-tracker';
import { buildSidecar, writeSidecar } from './sidecar-writer';
import { openConfigPipe, type ConfigPipe } from './temp-config';
import { runTool } from './tool-process';

/** Progress events per job, at most this often. Phase changes and the final event are not throttled. */
export const BACKUP_PROGRESS_INTERVAL_MS = 250;
// How long dispose waits for cancelled tools to exit before it kills them.
const DISPOSE_WAIT_MS = 2000;
const MAX_PLAN = 5000;
const MAX_SIDECAR_WARNINGS = 200;

export interface BackupServiceDeps<Client = unknown> {
  readonly registry: Pick<ToolsRegistry, 'resolve' | 'list' | 'markInUse'>;
  /** Returns the live client, or throws NOT_CONNECTED. */
  readonly getClient: (connectionId: string) => Client;
  /** resolveToolsEndpoint with its dependencies bound. */
  readonly endpoint: (
    connectionId: string,
    overrides?: { readPreference?: BackupStartInput['options']['readPreference'] },
  ) => Promise<ToolsEndpoint>;
  readonly readServerInfo: (
    client: Client,
    scope?: BackupStartInput['scope'],
  ) => Promise<BackupServerInfo>;
  /** Describes a backup source, as backup.inspect does. */
  readonly inspect: (path: string) => Promise<BackupInspection>;
  readonly spawn: SpawnFn;
  readonly emit: (event: RpcEvent) => void;
  readonly now: () => number;
  /** Parent of the private tools-<uuid> config folders. */
  readonly tmpRoot: string;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch?: string;
  /** True when the folder was picked in a folder dialog this session. */
  readonly isPickedFolder: (folder: string) => boolean;
  readonly env?: Record<string, string>;
  readonly log?: Logger;
  readonly progressIntervalMs?: number;
  readonly killGraceMs?: number;
  readonly disposeWaitMs?: number;
}

export interface BackupService {
  /** Checks the request, then starts the dump in the background. Throws before any job exists. */
  startDump(input: BackupStartInput): Promise<string>;
  /** Checks the request, then starts the restore in the background. Throws before any job exists. */
  startRestore(input: RestoreStartInput): Promise<string>;
  /** Stops a job. An unknown or finished job is ignored. */
  cancel(jobId: string): void;
  cancelConnection(connectionId: string): void;
  cancelAll(): void;
  /** True for an output or sidecar path a finished dump wrote this session. */
  wroteFile(path: string): boolean;
  /** Cancels every job and waits for the tools to exit, killing the ones that do not. */
  dispose(): Promise<void>;
}

interface Job {
  readonly jobId: string;
  readonly connectionId: string;
  readonly kind: BackupJobKind;
  readonly abort: AbortController;
  child?: ChildProcess;
  done?: Promise<void>;
}

interface DumpPlan {
  readonly input: BackupStartInput;
  readonly endpoint: ToolsEndpoint;
  readonly tools: ResolvedTools;
  readonly server: BackupServerInfo;
  readonly findings: Finding[];
  readonly outputPath: string;
  readonly sidecarPath: string;
}

interface RestorePlan {
  readonly input: RestoreStartInput;
  readonly options: RestoreOptions;
  readonly endpoint: ToolsEndpoint;
  readonly tools: ResolvedTools;
  readonly inspection: BackupInspection;
  readonly targetDatabases: string[];
}

function invalid(message: string): AppErrorException {
  return new AppErrorException(appError('VALIDATION', message));
}

/**
 * An AppError for any failure, with every secret masked. A driver failure is mapped as the other
 * calls map it; any other failure is INTERNAL.
 */
function toAppError(failure: unknown, secrets: readonly string[], driver = false): AppError {
  const error =
    failure instanceof AppErrorException
      ? failure.error
      : driver
        ? mapDriverError(failure)
        : appError('INTERNAL', failure instanceof Error ? failure.message : String(failure));
  const sorted = [...secrets].sort((a, b) => b.length - a.length);
  const mask = (text: string): string =>
    sorted.reduce(
      (value, secret) => redactPassword(value, secret),
      redactPassword(redactText(text)),
    );
  const { detail, cause, ...rest } = error;
  return {
    ...rest,
    message: mask(rest.message),
    ...(detail === undefined ? {} : { detail: mask(detail) }),
    ...(cause === undefined ? {} : { cause: mask(cause) }),
  };
}

/** Runs a driver call during a start check. Rethrows its error mapped and masked. */
async function masked<T>(secrets: readonly string[], action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (failure) {
    throw new AppErrorException(toAppError(failure, secrets, true));
  }
}

function refuseUnresolved(findings: Finding[]): void {
  const first = findings[0];
  if (first !== undefined) throw invalid(first.message);
}

async function installedVersions(registry: BackupServiceDeps['registry']): Promise<string[]> {
  const listed = await registry.list('auto');
  return listed.installs
    .filter((install) => install.health.state === 'ok')
    .map((install) => install.version);
}

/** Passes bytes through while counting them and, optionally, hashing them. */
function meter(onBytes: (count: number) => void, hash?: ReturnType<typeof createHash>): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      hash?.update(chunk);
      onBytes(chunk.byteLength);
      callback(null, chunk);
    },
  });
}

async function folderSize(dir: string): Promise<number> {
  let total = 0;
  for (const path of await listFiles(dir)) {
    total += (await stat(join(dir, ...path.split('/')))).size;
  }
  return total;
}

function dumpFacts(inspection: BackupInspection): DumpFacts {
  const sidecar = inspection.sidecar;
  const serverVersion = sidecar?.source.serverVersion ?? inspection.prelude?.serverVersion;
  const fcv = sidecar?.source.fcv;
  const toolsVersion = sidecar?.tools.version ?? inspection.prelude?.toolsVersion;
  return {
    sidecar: sidecar !== undefined,
    sidecarNewerFormat: inspection.sidecarProblem === 'Made by a newer Mongo GUI',
    ...(serverVersion === undefined ? {} : { serverVersion }),
    ...(fcv === undefined ? {} : { fcv }),
    ...(toolsVersion === undefined ? {} : { toolsVersion }),
    namespaces: inspection.namespaces,
  };
}

/** The databases a restore writes to, after renames. */
function targetDatabasesOf(inspection: BackupInspection, options: RestoreOptions): string[] {
  const sources =
    options.include === undefined
      ? inspection.namespaces.map((ns) => ns.database)
      : options.include.map((selector) => selector.slice(0, selector.indexOf('.')));
  return [...new Set(sources.map((database) => applyRenames(database, options.renames)))];
}

/** True for a namespace the dump options leave out. */
function isExcluded(collection: string, options: BackupStartInput['options']): boolean {
  return (
    options.excludeCollections.includes(collection) ||
    options.excludeCollectionsWithPrefix.some((prefix) => collection.startsWith(prefix))
  );
}

/** The databases and collections a dump wrote, for the sidecar. */
function dumpedDatabases(
  server: BackupServerInfo,
  options: BackupStartInput['options'],
  counts: ReadonlyMap<string, number>,
): BackupSidecar['databases'] {
  const byDatabase = new Map<string, BackupSidecar['databases'][number]['collections']>();
  const add = (
    database: string,
    entry: BackupSidecar['databases'][number]['collections'][number],
  ) => {
    const list = byDatabase.get(database) ?? [];
    list.push(entry);
    byDatabase.set(database, list);
  };
  const seen = new Set<string>();
  for (const ns of server.namespaces) {
    const namespace = `${ns.database}.${ns.collection}`;
    if (!counts.has(namespace) && isExcluded(ns.collection, options)) continue;
    seen.add(namespace);
    add(ns.database, {
      name: ns.collection,
      type: ns.type,
      documents: counts.get(namespace) ?? 0,
      ...(ns.documents === undefined ? {} : { estimatedDocuments: ns.documents }),
      ...(ns.capped === undefined ? {} : { capped: ns.capped }),
      ...(ns.clustered === undefined ? {} : { clustered: ns.clustered }),
      ...(ns.encrypted === undefined ? {} : { encrypted: ns.encrypted }),
    });
  }
  // Namespaces the tool dumped that the server listing missed (it is capped).
  for (const [namespace, documents] of counts) {
    const dot = namespace.indexOf('.');
    if (seen.has(namespace) || dot <= 0) continue;
    add(namespace.slice(0, dot), { name: namespace.slice(dot + 1), type: 'collection', documents });
  }
  return [...byDatabase].map(([name, collections]) => ({ name, collections }));
}

/**
 * Runs mongodump and mongorestore jobs. Each start validates in full, so a refused request leaves
 * no job and no file. A job reports through `backup:progress` events, at most four per second plus
 * one final event sent after the job leaves the map. Raw tool lines reach only those events, after
 * redaction; the app log gets the job id, tools version, outcome and duration.
 */
export function createBackupService<Client>(deps: BackupServiceDeps<Client>): BackupService {
  const jobs = new Map<string, Job>();
  const wrote = new Set<string>();
  const logger = deps.log ?? defaultLog;
  const interval = deps.progressIntervalMs ?? BACKUP_PROGRESS_INTERVAL_MS;
  const env = deps.env ?? toolEnv(process.env, deps.platform);
  const arch = deps.arch ?? process.arch;

  function register(connectionId: string, kind: BackupJobKind, version: string): Job {
    const job: Job = { jobId: newId(), connectionId, kind, abort: new AbortController() };
    jobs.set(job.jobId, job);
    logger.info('backup job started', { jobId: job.jobId, kind, toolsVersion: version });
    return job;
  }

  /** Event sending for one job. Phase changes go out at once, the rest at most every interval. */
  function sender(job: Job, tracker: ProgressTracker) {
    let lastSentAt = Number.NEGATIVE_INFINITY;
    const send = (end: Parameters<ProgressTracker['snapshot']>[0]): void => {
      lastSentAt = deps.now();
      deps.emit({
        type: 'backup:progress',
        connectionId: job.connectionId,
        jobId: job.jobId,
        kind: job.kind,
        progress: tracker.snapshot(end),
      });
    };
    return {
      now: () => send({ done: false, cancelled: false }),
      maybe: () => {
        if (deps.now() - lastSentAt >= interval) send({ done: false, cancelled: false });
      },
      final: send,
    };
  }

  function spawnFor(job: Job): SpawnFn {
    const spawn = ((...args: Parameters<SpawnFn>) => {
      const child = (deps.spawn as (...inner: Parameters<SpawnFn>) => ChildProcess)(...args);
      job.child = child;
      return child;
    }) as SpawnFn;
    return spawn;
  }

  /** Ends a job: leaves the map, logs the outcome, sends the final event. */
  function finish(
    job: Job,
    send: ReturnType<typeof sender>,
    startedAt: number,
    outcome: { error?: AppError; result?: BackupResult },
  ): void {
    jobs.delete(job.jobId);
    const cancelled = outcome.error?.code === 'CANCELLED';
    logger.info('backup job finished', {
      jobId: job.jobId,
      kind: job.kind,
      outcome: outcome.error?.code ?? 'OK',
      durationMs: Math.max(0, deps.now() - startedAt),
    });
    send.final({
      done: true,
      cancelled,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
    });
  }

  async function runDump(job: Job, plan: DumpPlan): Promise<void> {
    const { input, endpoint, tools, server } = plan;
    const { options } = input;
    const startedAt = deps.now();
    const scopeNamespaces = server.namespaces.filter((ns) => !isExcluded(ns.collection, options));
    const estimated = scopeNamespaces.reduce((sum, ns) => sum + (ns.documents ?? 0), 0);
    const tracker = createProgressTracker(
      'dump',
      { documents: estimated, namespaces: scopeNamespaces.length },
      deps.now,
    );
    const send = sender(job, tracker);
    const signal = job.abort.signal;
    const archive = options.output === 'archive';
    const partialPath = `${plan.outputPath}.partial`;
    let config: ConfigPipe | undefined;
    let error: AppError | undefined;
    let result: BackupResult | undefined;
    // Set once the dump is complete on disk. A later failure keeps the files.
    let dumpComplete = false;
    send.now();
    try {
      config = await openConfigPipe(deps.tmpRoot, toolsConfigYaml(endpoint.uri));
      if (signal.aborted)
        throw new AppErrorException(appError('CANCELLED', 'The backup was cancelled.'));
      const runs = dumpRunScopes(input.scope);
      const several = input.scope.kind === 'databases';
      let firstArgs: string[] | undefined;
      let archiveHash: ReturnType<typeof createHash> | undefined;
      let archiveBytes = 0;
      tracker.phase('running');
      send.now();
      for (const [index, run] of runs.entries()) {
        if (signal.aborted)
          throw new AppErrorException(appError('CANCELLED', 'The backup was cancelled.'));
        if (several && run.kind === 'database') {
          tracker.database(run.database, index + 1, runs.length);
          send.now();
        }
        const args = dumpArgs({
          configPath: config.path,
          scope: run,
          options,
          outDir: archive ? undefined : plan.outputPath,
        });
        firstArgs ??= args.filter((arg) => !arg.startsWith('--config='));
        const onLine = (parsed: Parameters<ProgressTracker['line']>[0], text: string) => {
          tracker.line(parsed, text);
          send.maybe();
        };
        if (archive) {
          archiveHash = createHash('sha256');
          const counter = meter((count) => {
            archiveBytes += count;
            tracker.bytes(count);
            send.maybe();
          }, archiveHash);
          const file = createWriteStream(partialPath, { flags: 'wx', mode: 0o600 });
          const written = pipeline(counter, file);
          // Awaited below. This keeps an early failure from counting as unhandled.
          written.catch(() => undefined);
          try {
            await runTool({
              spawn: spawnFor(job),
              binary: tools.mongodump,
              args,
              env,
              cwd: config.dir,
              stdout: counter,
              secrets: endpoint.secrets,
              onLine,
              signal,
              platform: deps.platform,
              ...(deps.killGraceMs === undefined ? {} : { killGraceMs: deps.killGraceMs }),
            });
          } catch (failure) {
            counter.destroy();
            await written.catch(() => undefined);
            throw failure;
          }
          await written;
        } else {
          await runTool({
            spawn: spawnFor(job),
            binary: tools.mongodump,
            args,
            env,
            cwd: config.dir,
            secrets: endpoint.secrets,
            onLine,
            signal,
            platform: deps.platform,
            ...(deps.killGraceMs === undefined ? {} : { killGraceMs: deps.killGraceMs }),
          });
        }
      }

      let output: BackupSidecar['output'];
      if (archive) {
        if (archiveHash === undefined) throw new Error('The archive was not written');
        await rename(partialPath, plan.outputPath);
        output = {
          kind: 'archive',
          fileName: basename(plan.outputPath),
          gzip: options.gzip,
          bytes: archiveBytes,
          sha256: archiveHash.digest('hex'),
        };
      } else {
        tracker.phase('hashing', await folderSize(plan.outputPath));
        send.now();
        const hashed = await hashDirectory(
          plan.outputPath,
          (count) => {
            tracker.bytes(count);
            send.maybe();
          },
          signal,
        );
        output = {
          kind: 'directory',
          dirName: basename(plan.outputPath),
          gzip: options.gzip,
          bytes: hashed.bytes,
          files: hashed.files,
        };
      }
      if (signal.aborted)
        throw new AppErrorException(appError('CANCELLED', 'The backup was cancelled.'));

      dumpComplete = true;
      tracker.phase('writing-sidecar');
      send.now();
      const mongodumpSha256 = await hashFile(tools.mongodump, () => undefined);
      const install = tools.install;
      const findingNotes = plan.findings
        .filter((item) => item.severity !== 'block')
        .map((item) => item.message);
      const sidecar = buildSidecar({
        appVersion: deps.appVersion,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(deps.now()).toISOString(),
        tools: {
          version: install.version,
          ...(install.gitVersion === undefined ? {} : { gitVersion: install.gitVersion }),
          os: deps.platform,
          arch,
          ...(install.target === undefined ? {} : { target: install.target }),
          source: install.source,
          mongodumpSha256,
        },
        source: {
          connectionName: endpoint.profileName,
          uri: uriWithoutCredentials(endpoint.uri),
          hosts: uriHosts(endpoint.uri),
          srv: /^\s*mongodb\+srv:/i.test(endpoint.uri),
          ...(endpoint.docker === undefined ? {} : { docker: endpoint.docker }),
          topology: server.topology,
          ...(server.setName === undefined ? {} : { setName: server.setName }),
          directConnection: server.directConnection,
          serverVersion: server.serverVersion,
          ...(server.fcv === undefined ? {} : { fcv: server.fcv }),
          ...(server.storageEngine === undefined ? {} : { storageEngine: server.storageEngine }),
        },
        scope: input.scope,
        options,
        readPreferenceUsed: endpoint.readPreference,
        args: firstArgs ?? [],
        output,
        databases: dumpedDatabases(server, options, tracker.finished()),
        oplog: options.oplog,
        usersAndRoles: options.dumpDbUsersAndRoles,
        warnings: [...tracker.warnings(), ...findingNotes].slice(0, MAX_SIDECAR_WARNINGS),
      });
      writeSidecar(plan.sidecarPath, sidecar, endpoint.secrets);
      wrote.add(plan.outputPath);
      wrote.add(plan.sidecarPath);
      result = {
        kind: 'dump',
        outputPath: plan.outputPath,
        sidecarPath: plan.sidecarPath,
        bytes: output.bytes,
        ...(output.kind === 'archive' ? { sha256: output.sha256 } : {}),
        documents: sidecar.totals.documents,
        namespaces: sidecar.totals.collections,
      };
    } catch (failure) {
      error = signal.aborted
        ? appError('CANCELLED', 'The backup was cancelled.')
        : toAppError(failure, endpoint.secrets);
      if (dumpComplete && !signal.aborted) {
        // The dump itself is fine; only the sidecar failed. Keep the files and say so.
        error = {
          ...error,
          message: `The backup finished at ${plan.outputPath}, but its description file could not be written: ${error.message}`,
        };
      } else {
        // The output did not exist at start, so whatever is there now is this job's.
        await rm(partialPath, { force: true }).catch(() => undefined);
        await rm(plan.outputPath, { recursive: true, force: true }).catch(() => undefined);
        if (archive) await rm(plan.sidecarPath, { force: true }).catch(() => undefined);
      }
    } finally {
      await config?.dispose();
    }
    finish(job, send, startedAt, {
      ...(error === undefined ? {} : { error }),
      ...(result === undefined ? {} : { result }),
    });
  }

  async function runRestore(job: Job, plan: RestorePlan): Promise<void> {
    const { input, options, endpoint, tools, inspection } = plan;
    const startedAt = deps.now();
    const selected = includedNamespaces(inspection.namespaces, options.include);
    const totalDocuments =
      inspection.sidecar === undefined
        ? undefined
        : selected.reduce((sum, ns) => sum + (ns.documents ?? 0), 0);
    const tracker = createProgressTracker(
      'restore',
      {
        ...(totalDocuments === undefined ? {} : { documents: totalDocuments }),
        namespaces: selected.length,
      },
      deps.now,
    );
    const send = sender(job, tracker);
    const signal = job.abort.signal;
    const archive = inspection.kind === 'archive';
    let config: ConfigPipe | undefined;
    let error: AppError | undefined;
    let result: BackupResult | undefined;
    let spawned = false;
    send.now();
    try {
      const sidecarOutput = inspection.sidecar?.output;
      if (archive && options.verifyChecksum && sidecarOutput?.kind === 'archive') {
        tracker.phase('verifying', inspection.bytes);
        send.now();
        const sha256 = await hashFile(
          inspection.path,
          (count) => {
            tracker.bytes(count);
            send.maybe();
          },
          signal,
        );
        if (sha256 !== sidecarOutput.sha256) {
          throw invalid('The archive does not match the checksum in its backup description.');
        }
      }
      config = await openConfigPipe(deps.tmpRoot, toolsConfigYaml(endpoint.uri));
      if (signal.aborted)
        throw new AppErrorException(appError('CANCELLED', 'The restore was cancelled.'));
      const args = restoreArgs({
        configPath: config.path,
        source: await restoreSource(config.dir, inspection, deps.platform),
        inspection,
        options,
      });
      tracker.phase('running', archive ? inspection.bytes : undefined);
      send.now();
      const onLine = (parsed: Parameters<ProgressTracker['line']>[0], text: string) => {
        tracker.line(parsed, text);
        send.maybe();
      };
      let stdin: Transform | undefined;
      let read: Promise<void> | undefined;
      if (archive) {
        stdin = meter((count) => {
          tracker.bytes(count);
          send.maybe();
        });
        // Errors surface through runTool's own pipe from this stream into the child.
        read = pipeline(createReadStream(inspection.path), stdin).catch(() => undefined);
      }
      spawned = true;
      try {
        await runTool({
          spawn: spawnFor(job),
          binary: tools.mongorestore,
          args,
          env,
          cwd: config.dir,
          ...(stdin === undefined ? {} : { stdin }),
          secrets: endpoint.secrets,
          onLine,
          signal,
          platform: deps.platform,
          ...(deps.killGraceMs === undefined ? {} : { killGraceMs: deps.killGraceMs }),
        });
      } finally {
        stdin?.destroy();
        await read;
      }
      const plan5000 = options.dryRun
        ? tracker
            .restoring()
            .slice(0, MAX_PLAN)
            .map((from) => ({ from, to: applyRenames(from, options.renames) }))
        : [];
      result = {
        kind: 'restore',
        dryRun: options.dryRun,
        restored: tracker.documents(),
        failed: tracker.failed(),
        databases: plan.targetDatabases,
        plan: plan5000,
      };
    } catch (failure) {
      error = signal.aborted
        ? appError('CANCELLED', 'The restore was cancelled.')
        : toAppError(failure, endpoint.secrets);
    } finally {
      await config?.dispose();
    }
    finish(job, send, startedAt, {
      ...(error === undefined ? {} : { error }),
      ...(result === undefined ? {} : { result }),
    });
    // Some collections may be written even when the run failed or was cancelled.
    if (spawned && !options.dryRun) {
      for (const database of plan.targetDatabases) {
        deps.emit({ type: 'catalog:changed', connectionId: input.connectionId, database });
      }
    }
  }

  function launch(job: Job, run: () => Promise<void>, release: () => void): void {
    job.done = run()
      .catch((failure: unknown) => {
        // run handles its own errors. This only guards against a bug leaving the job behind.
        jobs.delete(job.jobId);
        logger.error('backup job crashed', {
          jobId: job.jobId,
          error: failure instanceof Error ? failure.name : 'unknown',
        });
      })
      .finally(release);
  }

  return {
    async startDump(input) {
      if (!deps.isPickedFolder(input.folder)) {
        throw invalid('Choose the backup folder in a dialog first.');
      }
      const problem = dumpOptionProblems(input.scope, input.options)[0];
      if (problem !== undefined) throw invalid(problem.message);
      const outputPath = join(input.folder, backupFileName(input.name, input.options));
      const sidecarPath = sidecarPathFor(outputPath, input.options.output);
      if (
        existsSync(outputPath) ||
        existsSync(sidecarPath) ||
        existsSync(`${outputPath}.partial`)
      ) {
        throw new AppErrorException(
          appError('ALREADY_EXISTS', 'A backup with this name already exists in the folder.'),
        );
      }
      const readPreference = input.options.readPreference;
      const endpoint = await deps.endpoint(
        input.connectionId,
        readPreference === undefined ? {} : { readPreference },
      );
      const { secrets } = endpoint;
      const tools = await deps.registry.resolve(input.toolsVersion);
      const server = await masked(secrets, async () =>
        deps.readServerInfo(deps.getClient(input.connectionId), input.scope),
      );
      const serverProblem = dumpOptionProblems(input.scope, input.options, server)[0];
      if (serverProblem !== undefined) throw invalid(serverProblem.message);
      const findings = assessBackup({
        server,
        namespaces: server.namespaces,
        tools: {
          selected: tools.install.version,
          installed: await installedVersions(deps.registry),
          available: [],
        },
      });
      refuseUnresolved(
        unresolvedFindings(findings, input.acknowledged, undefined, endpoint.profileName),
      );

      const job = register(input.connectionId, 'dump', tools.install.version);
      const release = deps.registry.markInUse(tools.install.version);
      const plan: DumpPlan = { input, endpoint, tools, server, findings, outputPath, sidecarPath };
      launch(job, () => runDump(job, plan), release);
      return job.jobId;
    },

    async startRestore(input) {
      const endpoint = await deps.endpoint(input.connectionId);
      const { secrets } = endpoint;
      const inspection = await deps.inspect(input.source);
      const tools = await deps.registry.resolve(input.toolsVersion);
      const options = normaliseRestoreOptions(input.options);
      const problem = restoreOptionProblems(options, inspection)[0];
      if (problem !== undefined) throw invalid(problem.message);
      const target = await masked(secrets, async () =>
        deps.readServerInfo(deps.getClient(input.connectionId)),
      );
      const findings = assessRestore({
        dump: dumpFacts(inspection),
        target,
        tools: {
          selected: tools.install.version,
          installed: await installedVersions(deps.registry),
          available: [],
        },
        options,
      });
      refuseUnresolved(
        unresolvedFindings(findings, input.acknowledged, input.confirmation, endpoint.profileName),
      );

      const job = register(input.connectionId, 'restore', tools.install.version);
      const release = deps.registry.markInUse(tools.install.version);
      const plan: RestorePlan = {
        input,
        options,
        endpoint,
        tools,
        inspection,
        targetDatabases: targetDatabasesOf(inspection, options),
      };
      launch(job, () => runRestore(job, plan), release);
      return job.jobId;
    },

    cancel(jobId) {
      jobs.get(jobId)?.abort.abort();
    },
    cancelConnection(connectionId) {
      for (const job of jobs.values()) {
        if (job.connectionId === connectionId) job.abort.abort();
      }
    },
    cancelAll() {
      for (const job of jobs.values()) job.abort.abort();
    },
    wroteFile(path) {
      return wrote.has(path);
    },
    async dispose() {
      const running = [...jobs.values()];
      for (const job of running) job.abort.abort();
      const all = Promise.all(running.map((job) => job.done));
      const waitMs = deps.disposeWaitMs ?? DISPOSE_WAIT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        all.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), waitMs);
        }),
      ]);
      clearTimeout(timer);
      if (!timedOut) return;
      for (const job of running) {
        const child = job.child;
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
      await all;
    },
  };
}

/**
 * The path restoreArgs gets for the backup. A database folder restores through its parent, and
 * mongorestore rejects the whole run when any folder in that parent is not a valid database
 * name. So the parent becomes a private folder that holds only a link to the picked folder,
 * under the same name. The link goes away with the config folder.
 */
async function restoreSource(
  configDir: string,
  inspection: BackupInspection,
  platform: NodeJS.Platform,
): Promise<string> {
  if (inspection.kind !== 'directory' || inspection.layout !== 'database') {
    return inspection.path;
  }
  const parent = join(configDir, 'dump');
  await mkdir(parent, { mode: 0o700 });
  const link = join(parent, basename(inspection.path.replace(/[\\/]+$/, '')));
  // A junction needs no extra rights on Windows. Other systems ignore the type.
  await symlink(inspection.path, link, platform === 'win32' ? 'junction' : 'dir');
  return link;
}
