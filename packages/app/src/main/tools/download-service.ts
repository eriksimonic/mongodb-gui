import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AppErrorException,
  appError,
  toAppError,
  type AppError,
  type RpcEvent,
  type ToolsDownloadProgress,
  type ToolsInstallManifest,
  type ToolsPlatform,
} from '@mongo-gui/core';
import { extractToolsArchive } from './archive/extract';
import type { FeedClient } from './feed-client';
import { binaryName, type ToolsRoots } from './paths';
import { probeTools, type SpawnFn } from './probe';
import type { ToolsRegistry } from './registry';

const SIZE_CAP = 300 * 1024 * 1024;
const EVENT_INTERVAL_MS = 250;
const ALLOWED_HOSTS = new Set(['fastdl.mongodb.org', 'downloads.mongodb.org']);

export interface ToolsDownloadsDeps {
  readonly feed: FeedClient;
  readonly registry: ToolsRegistry;
  readonly fetchImpl: typeof fetch;
  readonly emit: (event: RpcEvent) => void;
  readonly roots: ToolsRoots;
  readonly platform: ToolsPlatform;
  readonly now: () => Date;
  // Runs the version probe. Defaults to child_process.spawn.
  readonly spawn?: SpawnFn;
  // Environment for the probe. Defaults to the tool allow-list of process.env.
  readonly env?: Record<string, string>;
}

export interface ToolsDownloads {
  start(version: string): Promise<{ downloadId: string }>;
  cancel(downloadId: string): void;
  cancelAll(): void;
}

interface Running {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

export function createToolsDownloads(deps: ToolsDownloadsDeps): ToolsDownloads {
  const running = new Map<string, Running>();
  const spawnFn = deps.spawn ?? nodeSpawn;

  async function start(version: string): Promise<{ downloadId: string }> {
    if (running.size > 0) {
      throw new AppErrorException(
        appError('ALREADY_EXISTS', 'A MongoDB tools download is already running.'),
      );
    }
    const listing = await deps.registry.list('auto');
    if (listing.installs.some((install) => install.version === version)) {
      throw new AppErrorException(
        appError('VALIDATION', `MongoDB Database Tools ${version} are already installed.`),
      );
    }
    const download = await deps.feed.find(version);
    if (!download) {
      throw new AppErrorException(
        appError('NOT_FOUND', `MongoDB Database Tools ${version} are not available for download.`),
      );
    }
    // A second start can arrive while the awaits above run.
    if (running.size > 0) {
      throw new AppErrorException(
        appError('ALREADY_EXISTS', 'A MongoDB tools download is already running.'),
      );
    }
    const downloadId = randomUUID();
    const controller = new AbortController();
    const done = run(downloadId, version, download, controller).finally(() => {
      running.delete(downloadId);
    });
    running.set(downloadId, { controller, done });
    return { downloadId };
  }

  async function run(
    downloadId: string,
    version: string,
    download: { url: string; sha256: string; target: string },
    controller: AbortController,
  ): Promise<void> {
    const partial = join(deps.roots.downloaded, `${randomUUID()}.partial`);
    const staging = join(deps.roots.downloaded, `.staging-${randomUUID()}`);
    let transferred = 0;
    let total: number | undefined;
    let bytesPerSecond: number | undefined;
    const send = (progress: ToolsDownloadProgress): void =>
      deps.emit({ type: 'tools:download', downloadId, version, progress });
    const phase = (name: ToolsDownloadProgress['phase']): void =>
      send({
        phase: name,
        transferred,
        ...(total !== undefined ? { total } : {}),
        ...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}),
      });
    const cancelled = (): boolean => controller.signal.aborted;
    try {
      await mkdir(deps.roots.downloaded, { recursive: true });
      phase('downloading');
      const started = deps.now().getTime();
      let lastEmit = started;
      const digest = await streamToFile(
        deps.fetchImpl,
        download.url,
        partial,
        controller.signal,
        (bytes, length) => {
          transferred = bytes;
          total = length;
          const now = deps.now().getTime();
          if (now - started > 0) bytesPerSecond = (bytes / (now - started)) * 1000;
          if (now - lastEmit >= EVENT_INTERVAL_MS) {
            lastEmit = now;
            phase('downloading');
          }
        },
      );
      phase('downloading');
      phase('verifying');
      if (digest !== download.sha256) {
        throw new AppErrorException(
          appError('VALIDATION', "The download does not match MongoDB's published checksum."),
        );
      }
      if (cancelled()) throw cancelError();
      phase('extracting');
      const buffer = await readFile(partial);
      const kind = download.url.endsWith('.zip') ? 'zip' : 'tgz';
      try {
        await extractToolsArchive(buffer, kind, staging, deps.platform.os);
      } catch (error) {
        if (error instanceof AppErrorException) throw error;
        throw new AppErrorException(
          appError(
            'VALIDATION',
            'The download is not a usable MongoDB Database Tools archive.',
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
      if (cancelled()) throw cancelError();
      phase('checking');
      const probe = await probeTools(
        join(staging, 'bin'),
        spawnFn,
        deps.platform.os,
        deps.env ? { env: deps.env } : {},
      );
      if (!probe.ok) throw new AppErrorException(probe.error);
      if (probe.version !== version) {
        throw new AppErrorException(
          appError(
            'VALIDATION',
            `The archive holds MongoDB Database Tools ${probe.version}, not ${version}.`,
          ),
        );
      }
      const manifest: ToolsInstallManifest = {
        format: 'mongo-gui.tools',
        formatVersion: 1,
        source: 'downloaded',
        version,
        target: download.target,
        os: deps.platform.os,
        arch: deps.platform.arch,
        archiveUrl: download.url,
        archiveSha256: download.sha256,
        binaries: {
          mongodump: await hashFile(
            join(staging, 'bin', binaryName('mongodump', deps.platform.os)),
          ),
          mongorestore: await hashFile(
            join(staging, 'bin', binaryName('mongorestore', deps.platform.os)),
          ),
        },
        ...(probe.gitVersion ? { gitVersion: probe.gitVersion } : {}),
        ...(probe.goVersion ? { goVersion: probe.goVersion } : {}),
        installedAt: deps.now().toISOString(),
      };
      await writeFile(join(staging, 'install.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      if (cancelled()) throw cancelError();
      await rename(staging, join(deps.roots.downloaded, `${version}-${download.target}`));
      phase('done');
    } catch (error) {
      let failure: AppError = toAppError(error);
      if (cancelled() || failure.code === 'CANCELLED') {
        send({ phase: 'cancelled', transferred });
        return;
      }
      if (failure.code === 'INTERNAL' && isNetworkError(error)) {
        failure = appError(
          'CONNECTION_FAILED',
          'The download from MongoDB failed.',
          failure.message,
        );
      }
      send({ phase: 'error', transferred, error: failure });
    } finally {
      await rm(partial, { force: true }).catch(() => undefined);
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    start,
    cancel(downloadId) {
      running.get(downloadId)?.controller.abort();
    },
    cancelAll() {
      for (const entry of running.values()) entry.controller.abort();
    },
  };
}

function cancelError(): AppErrorException {
  return new AppErrorException(appError('CANCELLED', 'The download was cancelled.'));
}

function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError || (error as { name?: string } | undefined)?.name === 'AbortError'
  );
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

// Streams the response body into a file while hashing it. Returns the sha256 in hex.
async function streamToFile(
  fetchImpl: typeof fetch,
  url: string,
  path: string,
  signal: AbortSignal,
  onProgress: (bytes: number, total: number | undefined) => void,
): Promise<string> {
  const response = await fetchImpl(url, { signal });
  if (response.url) {
    const final = new URL(response.url);
    if (final.protocol !== 'https:' || !ALLOWED_HOSTS.has(final.hostname)) {
      throw new AppErrorException(
        appError('VALIDATION', 'The download was redirected to a host that is not trusted.'),
      );
    }
  }
  if (!response.ok || !response.body) {
    throw new AppErrorException(
      appError('CONNECTION_FAILED', `MongoDB's download server answered ${response.status}.`),
    );
  }
  const length = Number(response.headers.get('content-length'));
  const total = Number.isFinite(length) && length > 0 ? length : undefined;
  if (total !== undefined && total > SIZE_CAP) throw tooLarge();
  const out = createWriteStream(path, { mode: 0o600 });
  // Listens from the start: an open or write error (ENOSPC, EACCES) can come while the loop
  // waits for the body or for 'drain', and an 'error' with no listener crashes main.
  const failed = new Promise<never>((_resolve, reject) => out.once('error', reject));
  failed.catch(() => undefined);
  const hash = createHash('sha256');
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), failed]);
      if (done) break;
      if (signal.aborted) throw cancelError();
      bytes += value.byteLength;
      if (bytes > SIZE_CAP) throw tooLarge();
      hash.update(value);
      if (!out.write(value)) {
        await Promise.race([new Promise<void>((resolve) => out.once('drain', resolve)), failed]);
      }
      onProgress(bytes, total);
    }
    await Promise.race([new Promise<void>((resolve) => out.end(resolve)), failed]);
  } catch (error) {
    out.destroy();
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return hash.digest('hex');
}

function tooLarge(): AppErrorException {
  return new AppErrorException(
    appError('VALIDATION', 'The download is larger than the 300 MB limit.'),
  );
}
