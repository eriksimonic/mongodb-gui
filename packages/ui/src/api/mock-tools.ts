import {
  newId,
  type RpcEvent,
  type ToolsAvailableOutput,
  type ToolsDownloadProgress,
  type ToolsInstall,
  type ToolsInstallId,
  type ToolsLicenceOutput,
  type ToolsListOutput,
  type ToolsPreference,
  type ToolsVersion,
} from '@mongo-gui/core';
import { fail } from './mock-support';

/** Which tools the mock has. `missing` has none, `mismatch` only 100.19.1, `broken` a bundled install that fails its check. */
export type MockToolsMode = 'ok' | 'missing' | 'mismatch' | 'broken';

export const MOCK_BUNDLED_VERSION = '100.19.1';
export const MOCK_DOWNLOADED_VERSION = '100.12.1';

const MOCK_FEED_VERSIONS: readonly { version: ToolsVersion; sizeBytes: number }[] = [
  { version: '100.19.1', sizeBytes: 61_300_000 },
  { version: '100.15.0', sizeBytes: 58_900_000 },
  { version: '100.12.1', sizeBytes: 55_400_000 },
  { version: '100.10.0', sizeBytes: 54_100_000 },
  { version: '100.9.5', sizeBytes: 52_700_000 },
];
const MOCK_FEED_TARGET = 'ubuntu2204';
const DOWNLOAD_TICK_MS = 120;
const DOWNLOAD_STEPS = 6;

const KERBEROS_MESSAGE =
  'mongodump: error while loading shared libraries: libgssapi_krb5.so.2: cannot open shared object file: No such file or directory';

export interface MockTools {
  list(preference: ToolsPreference): ToolsListOutput;
  available(): ToolsAvailableOutput;
  download(version: ToolsVersion): string;
  cancelDownload(downloadId: string): void;
  remove(id: ToolsInstallId): void;
  licence(id: ToolsInstallId): ToolsLicenceOutput;
}

interface MockDownload {
  version: ToolsVersion;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function bundledInstall(broken: boolean): ToolsInstall {
  return {
    id: 'bundled',
    source: 'bundled',
    version: MOCK_BUNDLED_VERSION,
    target: MOCK_FEED_TARGET,
    gitVersion: 'a1b2c3d4e5f6',
    location: '/opt/mongo-gui/resources/tools',
    sizeBytes: 118_000_000,
    health: broken
      ? { state: 'broken', error: { code: 'COMMAND_FAILED', message: KERBEROS_MESSAGE } }
      : { state: 'ok' },
    inUse: false,
  };
}

function downloadedInstall(version: ToolsVersion): ToolsInstall {
  return {
    id: `downloaded:${version}`,
    source: 'downloaded',
    version,
    target: MOCK_FEED_TARGET,
    gitVersion: '0f9e8d7c6b5a',
    location: `/home/mock/.config/mongo-gui/tools/${version}`,
    sizeBytes: 104_000_000,
    installedAt: '2026-09-20T09:30:00.000Z',
    health: { state: 'ok' },
    inUse: false,
  };
}

function initialInstalls(mode: MockToolsMode): ToolsInstall[] {
  switch (mode) {
    case 'missing':
      return [];
    case 'mismatch':
      return [bundledInstall(false)];
    case 'broken':
      return [bundledInstall(true), downloadedInstall(MOCK_DOWNLOADED_VERSION)];
    case 'ok':
      return [bundledInstall(false), downloadedInstall(MOCK_DOWNLOADED_VERSION)];
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * The tools the mock reports, and a download that walks its phases on a timer. The installs are
 * plain data: a finished download adds one and remove deletes one. Cancel stops the timer and
 * ends the download with a cancelled event, as the real downloader does.
 */
export function createMockTools(emit: (event: RpcEvent) => void, mode: MockToolsMode): MockTools {
  const installs = initialInstalls(mode);
  const downloads = new Map<string, MockDownload>();

  const sorted = (): ToolsInstall[] =>
    [...installs].sort(
      (left, right) =>
        compareVersions(left.version, right.version) ||
        (left.source === right.source ? 0 : left.source === 'bundled' ? -1 : 1),
    );

  const resolve = (preference: ToolsPreference): ToolsVersion | undefined => {
    const healthy = sorted().filter((install) => install.health.state === 'ok');
    if (preference !== 'auto' && healthy.some((install) => install.version === preference)) {
      return preference;
    }
    return (healthy.find((install) => install.source === 'bundled') ?? healthy[0])?.version;
  };

  const send = (downloadId: string, version: ToolsVersion, progress: ToolsDownloadProgress) => {
    emit({ type: 'tools:download', downloadId, version, progress });
  };

  return {
    list(preference) {
      const resolved = resolve(preference);
      return {
        platform: { os: 'linux', arch: 'x64' },
        bundledSupported: true,
        installs: sorted(),
        preference,
        ...(resolved === undefined ? {} : { resolved }),
      };
    },
    available() {
      return {
        fetchedAt: new Date().toISOString(),
        versions: MOCK_FEED_VERSIONS.map((entry) => ({
          ...entry,
          target: MOCK_FEED_TARGET,
          installed: installs.some((install) => install.version === entry.version),
        })),
      };
    },
    download(version) {
      const entry = MOCK_FEED_VERSIONS.find((item) => item.version === version);
      if (entry === undefined) {
        throw fail('NOT_FOUND', 'That version is not in the feed.', version);
      }
      const downloadId = newId();
      const job: MockDownload = { version, timer: undefined };
      downloads.set(downloadId, job);
      let step = 0;
      const tick = (): void => {
        step += 1;
        if (step <= DOWNLOAD_STEPS) {
          const transferred = Math.round((entry.sizeBytes * step) / DOWNLOAD_STEPS);
          send(downloadId, version, {
            phase: 'downloading',
            transferred,
            total: entry.sizeBytes,
            bytesPerSecond: Math.round(
              (entry.sizeBytes / DOWNLOAD_STEPS) * (1000 / DOWNLOAD_TICK_MS),
            ),
          });
        } else if (step === DOWNLOAD_STEPS + 1) {
          send(downloadId, version, {
            phase: 'verifying',
            transferred: entry.sizeBytes,
            total: entry.sizeBytes,
          });
        } else if (step === DOWNLOAD_STEPS + 2) {
          send(downloadId, version, {
            phase: 'extracting',
            transferred: entry.sizeBytes,
            total: entry.sizeBytes,
          });
        } else if (step === DOWNLOAD_STEPS + 3) {
          send(downloadId, version, {
            phase: 'checking',
            transferred: entry.sizeBytes,
            total: entry.sizeBytes,
          });
        } else {
          downloads.delete(downloadId);
          installs.push(downloadedInstall(version));
          send(downloadId, version, {
            phase: 'done',
            transferred: entry.sizeBytes,
            total: entry.sizeBytes,
          });
          return;
        }
        job.timer = setTimeout(tick, DOWNLOAD_TICK_MS);
      };
      job.timer = setTimeout(tick, DOWNLOAD_TICK_MS);
      return downloadId;
    },
    cancelDownload(downloadId) {
      const job = downloads.get(downloadId);
      if (job === undefined) {
        return;
      }
      if (job.timer !== undefined) {
        clearTimeout(job.timer);
      }
      downloads.delete(downloadId);
      send(downloadId, job.version, { phase: 'cancelled', transferred: 0 });
    },
    remove(id) {
      if (id === 'bundled') {
        throw fail('VALIDATION', 'The bundled tools cannot be removed.');
      }
      const index = installs.findIndex((install) => install.id === id);
      if (index < 0) {
        throw fail('NOT_FOUND', 'Those tools are not installed.', id);
      }
      installs.splice(index, 1);
    },
    licence(id) {
      const install = installs.find((item) => item.id === id);
      if (install === undefined) {
        throw fail('NOT_FOUND', 'Those tools are not installed.', id);
      }
      return {
        version: install.version,
        licence:
          'Apache License, Version 2.0\n\nMongoDB Database Tools are licensed under the Apache License 2.0. This is mock text for the dev UI.',
        thirdPartyNotices:
          'Third-party notices for MongoDB Database Tools ' +
          `${install.version}\n\ngithub.com/mongodb/mongo-tools-common (Apache-2.0)\ngithub.com/klauspost/compress (BSD-3-Clause)`,
      };
    },
  };
}
