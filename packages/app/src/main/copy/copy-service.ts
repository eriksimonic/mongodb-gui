import { PassThrough } from 'node:stream';
import {
  appError,
  AppErrorException,
  assessCopy,
  compareVersions,
  copyDumpArgs,
  copyRestoreArgs,
  firstToolsFor,
  newId,
  parseRestoreCounts,
  sameServer,
  tempCollectionName,
  toolsConfigYaml,
  type AppError,
  type ConnectionProfile,
  type CopyFinding,
  type CopyFindingCode,
  type CopyItem,
  type CopyMode,
  type CopyOptions,
  type CopyProgress,
  type NamespaceRef,
  type RpcEvent,
} from '@mongo-gui/core';
import {
  dropCollectionIfExists,
  mapDriverError,
  mergeCollection,
  parseCommandEjson,
  readBackupServerInfo,
  redactPassword,
  renameCollection,
  serverIdentity,
  type ConnectionManager,
} from '@mongo-gui/mongo-adapter';
import type { CopyService } from '../rpc/copy';
import type { ToolsEndpoint } from '../backup/endpoint';
import { log as defaultLog, type Logger } from '../log';
import { redactText } from '../redact';
import { openConfigPipe, type ConfigPipe } from '../backup/temp-config';
import { runTool } from '../backup/tool-process';
import type { SpawnFn } from '../tools/probe';
import type { ResolvedTools, ToolsRegistry } from '../tools/registry';
import { toolEnv } from '../tools/tool-env';

/** A live connection's client, as the connection manager hands it out. */
type LiveClient = ReturnType<ConnectionManager['getClient']>;
/** A parsed item filter. It is an EJSON object. */
type FilterDocument = NonNullable<ReturnType<typeof parseCommandEjson>>;

/** Progress events per job, at most this often. Phase changes and the final event are not throttled. */
export const COPY_PROGRESS_INTERVAL_MS = 250;
const MERGE_BATCH_SIZE = 1000;
const MAX_LINES_PER_EVENT = 100;
const MAX_NOTES = 50;
// Views and system collections are skipped. assessCopy reports the views.
const SYSTEM_PREFIX = 'system.';

/** The copy service the router calls, plus the stops the router and the app use. */
export interface CopyJobs extends CopyService {
  /** Cancels every running job. A renderer reset and a vault lock call it. */
  cancelAll(): void;
  /** Cancels the jobs that read or write this connection. */
  cancelConnection(connectionId: string): void;
  /** Cancels every job and waits until each has dropped its temporary collection. */
  dispose(): Promise<void>;
}

export interface CopyServiceDeps {
  readonly registry: Pick<ToolsRegistry, 'list' | 'resolve' | 'resolvePreferred' | 'markInUse'>;
  /** Returns the live client, or throws NOT_CONNECTED. */
  readonly getClient: (connectionId: string) => LiveClient;
  /** Throws VAULT_LOCKED or NOT_FOUND like the store does. */
  readonly getProfile: (connectionId: string) => ConnectionProfile;
  /** resolveToolsEndpoint with its dependencies bound. */
  readonly endpoint: (connectionId: string) => Promise<ToolsEndpoint>;
  readonly readServerInfo: typeof readBackupServerInfo;
  readonly identify: typeof serverIdentity;
  readonly rename: typeof renameCollection;
  readonly dropIfExists: typeof dropCollectionIfExists;
  readonly merge: typeof mergeCollection;
  readonly runTool: typeof runTool;
  readonly spawn: SpawnFn;
  readonly emit: (event: RpcEvent) => void;
  readonly now: () => number;
  /** Parent of the private tools-<uuid> config folders. */
  readonly tmpRoot: string;
  readonly platform: NodeJS.Platform;
  readonly env?: Record<string, string>;
  readonly log?: Logger;
  readonly progressIntervalMs?: number;
  readonly killGraceMs?: number;
}

interface Job {
  readonly jobId: string;
  readonly sourceConnectionId: string;
  readonly targetConnectionId: string;
  readonly abort: AbortController;
  done?: Promise<void>;
}

interface ReportDelta {
  readonly documents?: number | undefined;
  readonly failed?: number | undefined;
  readonly skipped?: number | undefined;
}

/** What a job reports: the running tally, and the events it sends. */
interface Reporter {
  start(target: string): void;
  collectionDone(): void;
  note(text: string): void;
  add(delta: ReportDelta): void;
  line(text: string): void;
  maybe(): void;
  finish(error?: AppError): void;
}

interface PlanItem {
  readonly source: string;
  readonly target: string;
  readonly filterText: string | undefined;
  readonly filter: FilterDocument | undefined;
  // The target is a time series collection. Replace writes it in place, because it cannot rename.
  readonly targetTimeseries: boolean;
  readonly estimate: number | undefined;
}

interface CopyPlan {
  readonly options: CopyOptions;
  readonly items: PlanItem[];
  readonly source: ToolsEndpoint;
  readonly target: ToolsEndpoint;
  readonly sourceClient: LiveClient;
  readonly targetClient: LiveClient;
  readonly tools: ResolvedTools;
  // Every secret of both connections, masked in each error.
  readonly secrets: readonly string[];
  readonly totalDocuments: number | undefined;
}

function invalid(message: string): AppErrorException {
  return new AppErrorException(appError('VALIDATION', message));
}

function cancelledError(): AppError {
  return appError('CANCELLED', 'The copy was cancelled.');
}

function isCancelled(reason: unknown): boolean {
  return reason instanceof AppErrorException && reason.error.code === 'CANCELLED';
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

/** Runs a driver call during a start or a job. Rethrows its error mapped and masked. */
async function masked<T>(secrets: readonly string[], action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (failure) {
    throw new AppErrorException(toAppError(failure, secrets, true));
  }
}

/** The findings that stop a copy: every block, and each strong finding the user did not acknowledge. */
function unresolvedCopyFindings(
  findings: readonly CopyFinding[],
  acknowledged: readonly CopyFindingCode[],
): CopyFinding[] {
  return findings.filter(
    (item) =>
      item.severity === 'block' ||
      (item.severity === 'strong' && !acknowledged.includes(item.code)),
  );
}

/** Parses one item filter. The text must be an EJSON object. */
function parseFilter(item: CopyItem): FilterDocument | undefined {
  if (item.filter === undefined) return undefined;
  const parsed = parseCommandEjson(item.filter);
  if (parsed === undefined) {
    throw invalid(`The filter for ${item.source} is not an EJSON object. Fix it or clear it.`);
  }
  return parsed;
}

/**
 * The newest healthy tools install that fits both servers. Without one, the preferred install is
 * used, and assessCopy blocks the start when that one is too old too.
 */
async function chooseTools(
  registry: CopyServiceDeps['registry'],
  serverVersions: readonly string[],
): Promise<{ tools: ResolvedTools; installed: string[] }> {
  const listed = await registry.list('auto');
  const installed = listed.installs
    .filter((install) => install.health.state === 'ok')
    .map((install) => install.version);
  const minimums = serverVersions
    .map((version) => firstToolsFor(version)?.tools)
    .filter((version): version is string => version !== undefined);
  const fits = (version: string) =>
    minimums.every((minimum) => compareVersions(version, minimum) >= 0);
  const best = installed.filter(fits).sort((a, b) => compareVersions(b, a))[0];
  const tools =
    best === undefined ? await registry.resolvePreferred('auto') : await registry.resolve(best);
  return { tools, installed };
}

/**
 * Copies collections between two connections. Replace and insert only run mongodump and
 * mongorestore, with the dump piped into the restore. Merge uses the driver. A job reports through
 * copy:progress events, at most every COPY_PROGRESS_INTERVAL_MS plus the final event.
 */
export function createCopyService(deps: CopyServiceDeps): CopyJobs {
  const jobs = new Map<string, Job>();
  const logger = deps.log ?? defaultLog;
  const interval = deps.progressIntervalMs ?? COPY_PROGRESS_INTERVAL_MS;
  const env = deps.env ?? toolEnv(process.env, deps.platform);
  const grace = deps.killGraceMs === undefined ? {} : { killGraceMs: deps.killGraceMs };

  /** Every check before a job exists. Each refusal throws, so no job, tool or temp collection starts. */
  async function prepare(options: CopyOptions): Promise<CopyPlan> {
    const profile = deps.getProfile(options.targetConnectionId);
    if (profile.production === true && options.confirmation !== options.targetDatabase) {
      throw invalid(
        `${profile.name} is a production connection. Type ${options.targetDatabase} to confirm the copy.`,
      );
    }
    const filters = options.items.map(parseFilter);
    const source = await deps.endpoint(options.sourceConnectionId);
    const target = await deps.endpoint(options.targetConnectionId);
    const secrets = [...new Set([...source.secrets, ...target.secrets])];
    const sourceClient = deps.getClient(options.sourceConnectionId);
    const targetClient = deps.getClient(options.targetConnectionId);
    const [sourceInfo, targetInfo] = await masked(secrets, () =>
      Promise.all([
        deps.readServerInfo(sourceClient, { kind: 'database', database: options.sourceDatabase }),
        deps.readServerInfo(targetClient, { kind: 'database', database: options.targetDatabase }),
      ]),
    );
    const [sourceId, targetId] = await masked(secrets, () =>
      Promise.all([deps.identify(sourceClient), deps.identify(targetClient)]),
    );
    const { tools, installed } = await chooseTools(deps.registry, [
      sourceInfo.serverVersion,
      targetInfo.serverVersion,
    ]);
    const findings = assessCopy({
      source: sourceInfo,
      target: targetInfo,
      tools: { selected: tools.install.version, installed, available: [] },
      sameServer: sameServer(
        { hosts: sourceId.hosts, setName: sourceId.replicaSet },
        { hosts: targetId.hosts, setName: targetId.replicaSet },
      ),
      options: {
        sourceDatabase: options.sourceDatabase,
        targetDatabase: options.targetDatabase,
        items: options.items,
        mode: options.mode,
      },
      sourceNamespaces: sourceInfo.namespaces,
      targetNamespaces: targetInfo.namespaces,
    });
    const refusal = unresolvedCopyFindings(findings, options.acknowledged)[0];
    if (refusal !== undefined) throw invalid(refusal.message);

    const sourceTypes = new Map(sourceInfo.namespaces.map((ns) => [ns.collection, ns.type]));
    const targetTypes = new Map(targetInfo.namespaces.map((ns) => [ns.collection, ns.type]));
    const items: PlanItem[] = [];
    options.items.forEach((item, index) => {
      if (sourceTypes.get(item.source) === 'view' || item.source.startsWith(SYSTEM_PREFIX)) return;
      items.push({
        source: item.source,
        target: item.target,
        filterText: item.filter,
        filter: filters[index],
        // Merge into a time series target is refused by assessCopy, so only replace reads this.
        targetTimeseries: targetTypes.get(item.target) === 'timeseries',
        estimate: sourceInfo.namespaces.find((ns) => ns.collection === item.source)?.documents,
      });
    });
    if (items.length === 0) {
      throw invalid('Nothing to copy. Views and system collections are not copied.');
    }
    const estimates = items.map((item) => item.estimate);
    const known = estimates.filter((count): count is number => count !== undefined);
    const totalDocuments =
      known.length === estimates.length ? known.reduce((sum, count) => sum + count, 0) : undefined;
    return {
      options,
      items,
      source,
      target,
      sourceClient,
      targetClient,
      tools,
      secrets,
      totalDocuments,
    };
  }

  /** Progress for one job: the running tally and the throttled events. */
  function reporter(job: Job, plan: CopyPlan): Reporter {
    const tally = {
      documents: 0,
      failed: 0,
      skipped: 0,
      collectionsDone: 0,
      current: undefined as string | undefined,
      notes: [] as string[],
      lines: [] as string[],
    };
    const startedAt = deps.now();
    let phase: CopyProgress['phase'] = 'preparing';
    let lastSentAt = Number.NEGATIVE_INFINITY;

    const send = (done: boolean, error?: AppError): void => {
      lastSentAt = deps.now();
      const lines = tally.lines.splice(0);
      deps.emit({
        type: 'copy:progress',
        jobId: job.jobId,
        progress: {
          phase: done ? 'finished' : phase,
          documents: tally.documents,
          ...(plan.totalDocuments === undefined ? {} : { totalDocuments: plan.totalDocuments }),
          collectionsDone: tally.collectionsDone,
          collectionsTotal: plan.items.length,
          ...(tally.current === undefined ? {} : { current: tally.current }),
          failedDocuments: tally.failed,
          skippedDocuments: tally.skipped,
          lines,
          elapsedMs: Math.max(0, deps.now() - startedAt),
          done,
          cancelled: error?.code === 'CANCELLED',
          ...(error === undefined ? {} : { error }),
          ...(tally.notes.length === 0 ? {} : { notes: [...tally.notes] }),
        },
      });
    };

    return {
      /** A collection starts. Sent at once. */
      start(target: string): void {
        phase = 'copying';
        tally.current = target;
        send(false);
      },
      collectionDone(): void {
        tally.collectionsDone += 1;
        send(false);
      },
      note(text: string): void {
        if (tally.notes.length < MAX_NOTES) tally.notes.push(text);
      },
      add(delta: ReportDelta): void {
        tally.documents += delta.documents ?? 0;
        tally.failed += delta.failed ?? 0;
        tally.skipped += delta.skipped ?? 0;
      },
      /** A tool line. It goes out with the next event. */
      line(text: string): void {
        tally.lines.push(text);
        if (tally.lines.length > MAX_LINES_PER_EVENT) tally.lines.shift();
        if (deps.now() - lastSentAt >= interval) send(false);
      },
      /** Sends an event when the interval has passed. */
      maybe(): void {
        if (deps.now() - lastSentAt >= interval) send(false);
      },
      finish(error?: AppError): void {
        send(true, error);
      },
    };
  }

  /** Drop and replace: the temporary collection is renamed over the target, or dropped on failure. */
  async function replaceThroughTemp(
    job: Job,
    plan: CopyPlan,
    item: PlanItem,
    source: NamespaceRef,
    report: Reporter,
  ): Promise<void> {
    const database = plan.options.targetDatabase;
    const temp = tempCollectionName(database, item.target, job.jobId);
    try {
      await pipe(job, plan, source, { database, collection: temp }, item, 'replace', report);
      await masked(plan.secrets, () =>
        deps.rename(plan.targetClient, {
          database,
          name: temp,
          newName: item.target,
          dropTarget: true,
        }),
      );
    } catch (failure) {
      await deps
        .dropIfExists(plan.targetClient, { db: database, collection: temp })
        .catch(() => undefined);
      throw failure;
    }
  }

  async function mergeItem(
    job: Job,
    plan: CopyPlan,
    item: PlanItem,
    report: Reporter,
  ): Promise<void> {
    const { options } = plan;
    const source = plan.sourceClient.db(options.sourceDatabase).collection(item.source);
    const target = plan.targetClient.db(options.targetDatabase).collection(item.target);
    let written = 0;
    let failed = 0;
    await masked(plan.secrets, () =>
      deps.merge({
        source,
        target,
        filter: item.filter ?? {},
        batchSize: MERGE_BATCH_SIZE,
        signal: job.abort.signal,
        onProgress(counts) {
          report.add({ documents: counts.written - written, failed: counts.failed - failed });
          written = counts.written;
          failed = counts.failed;
          report.maybe();
        },
      }),
    );
  }

  /**
   * Runs mongodump and mongorestore for one collection, with the dump piped into the restore. A
   * failure in either run stops the other. Both config files are removed when the pair ends.
   */
  async function pipe(
    job: Job,
    plan: CopyPlan,
    source: NamespaceRef,
    target: NamespaceRef,
    item: PlanItem,
    mode: Exclude<CopyMode, 'merge'>,
    report: Reporter,
  ): Promise<void> {
    const pairStop = new AbortController();
    const signal = AbortSignal.any([job.abort.signal, pairStop.signal]);
    const stopPair = (failure: unknown): never => {
      pairStop.abort();
      throw failure;
    };
    const data = new PassThrough();
    const configs: ConfigPipe[] = [];
    try {
      // A config pipe serves one reader, so each tool run gets its own.
      const dumpConfig = await openConfigPipe(deps.tmpRoot, toolsConfigYaml(plan.source.uri));
      configs.push(dumpConfig);
      const restoreConfig = await openConfigPipe(deps.tmpRoot, toolsConfigYaml(plan.target.uri));
      configs.push(restoreConfig);
      const common = { spawn: deps.spawn, env, platform: deps.platform, signal, ...grace };
      // Waits for both processes to exit, so the caller cleans up only after they stop.
      const outcomes = await Promise.allSettled([
        deps
          .runTool({
            ...common,
            binary: plan.tools.mongodump,
            args: copyDumpArgs({ configPath: dumpConfig.path, source, filter: item.filterText }),
            cwd: dumpConfig.dir,
            stdout: data,
            secrets: plan.source.secrets,
            onLine: (_parsed, text) => report.line(text),
          })
          .catch(stopPair),
        deps
          .runTool({
            ...common,
            binary: plan.tools.mongorestore,
            args: copyRestoreArgs({
              configPath: restoreConfig.path,
              source,
              target,
              mode,
            }),
            cwd: restoreConfig.dir,
            stdin: data,
            secrets: plan.target.secrets,
            onLine: (_parsed, text) => {
              const counts = parseRestoreCounts(text);
              // Insert only reports the skipped existing _ids as failed documents.
              report.add(
                mode === 'insertOnly'
                  ? { documents: counts.restored, skipped: counts.failed }
                  : { documents: counts.restored, failed: counts.failed },
              );
              report.line(text);
            },
          })
          .catch(stopPair),
      ]);
      const failures = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      // The run that failed first is the reason. The other one ends as cancelled.
      const failure = failures.find((outcome) => !isCancelled(outcome.reason)) ?? failures[0];
      if (failure !== undefined) throw failure.reason;
    } finally {
      data.destroy();
      await Promise.all(configs.map((config) => config.dispose()));
    }
  }

  async function copyItem(
    job: Job,
    plan: CopyPlan,
    item: PlanItem,
    report: Reporter,
  ): Promise<void> {
    const { options } = plan;
    const source = { database: options.sourceDatabase, collection: item.source };
    const target = { database: options.targetDatabase, collection: item.target };
    switch (options.mode) {
      case 'merge':
        return mergeItem(job, plan, item, report);
      case 'insertOnly':
        return pipe(job, plan, source, target, item, 'insertOnly', report);
      case 'replace':
        if (item.targetTimeseries) {
          report.note(
            `${target.database}.${target.collection} is a time series collection. Replace drops and refills it in place, so a cancel leaves it partly filled.`,
          );
          return pipe(job, plan, source, target, item, 'replace', report);
        }
        return replaceThroughTemp(job, plan, item, source, report);
    }
  }

  /** Runs the whole job and sends the final event. Errors end the job; they do not escape. */
  async function run(job: Job, plan: CopyPlan): Promise<void> {
    const startedAt = deps.now();
    const report = reporter(job, plan);
    const signal = job.abort.signal;
    let error: AppError | undefined;
    let wrote = false;
    try {
      for (const item of plan.items) {
        if (signal.aborted) break;
        wrote = true;
        report.start(item.target);
        await copyItem(job, plan, item, report);
        report.collectionDone();
      }
      if (signal.aborted) throw new AppErrorException(cancelledError());
    } catch (failure) {
      error = signal.aborted ? cancelledError() : toAppError(failure, plan.secrets);
    }
    jobs.delete(job.jobId);
    logger.info('copy job finished', {
      jobId: job.jobId,
      outcome: error?.code ?? 'OK',
      durationMs: Math.max(0, deps.now() - startedAt),
    });
    report.finish(error);
    // Some documents may be written even when the job failed or was cancelled.
    if (wrote) {
      deps.emit({
        type: 'catalog:changed',
        connectionId: plan.options.targetConnectionId,
        database: plan.options.targetDatabase,
      });
    }
  }

  function cancelWhere(match: (job: Job) => boolean): void {
    for (const job of jobs.values()) {
      if (match(job)) job.abort.abort();
    }
  }

  return {
    async start(options) {
      const plan = await prepare(options);
      const job: Job = {
        jobId: newId(),
        sourceConnectionId: options.sourceConnectionId,
        targetConnectionId: options.targetConnectionId,
        abort: new AbortController(),
      };
      jobs.set(job.jobId, job);
      logger.info('copy job started', {
        jobId: job.jobId,
        mode: options.mode,
        items: plan.items.length,
        toolsVersion: plan.tools.install.version,
      });
      const release = deps.registry.markInUse(plan.tools.install.version);
      job.done = run(job, plan)
        .catch((failure: unknown) => {
          jobs.delete(job.jobId);
          logger.error('copy job crashed', {
            jobId: job.jobId,
            error: failure instanceof Error ? failure.name : 'unknown',
          });
        })
        .finally(release);
      return job.jobId;
    },
    cancel(jobId) {
      jobs.get(jobId)?.abort.abort();
    },
    cancelAll() {
      cancelWhere(() => true);
    },
    cancelConnection(connectionId) {
      cancelWhere(
        (job) => job.sourceConnectionId === connectionId || job.targetConnectionId === connectionId,
      );
    },
    async dispose() {
      const running = [...jobs.values()];
      for (const job of running) job.abort.abort();
      await Promise.all(running.map((job) => job.done));
    },
  };
}
