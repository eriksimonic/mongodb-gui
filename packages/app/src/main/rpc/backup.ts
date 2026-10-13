import {
  AppErrorException,
  appError,
  rpcContract,
  type BackupInspection,
  type BackupScope,
  type BackupServerInfo,
} from '@mongo-gui/core';
import { readBackupServerInfo } from '@mongo-gui/mongo-adapter';
import type { SavedBackupsRepository, SavedRestoresRepository } from '@mongo-gui/storage';
import { basename, dirname } from 'node:path';
import type { BackupService } from '../backup/backup-service';
import { driverCall, entry, type Operation } from './operation';

/** The client a backup call runs against. */
type BackupClient = Parameters<typeof readBackupServerInfo>[0];

// The sidecar inside a dump folder. A picked one stands for its folder.
const DIRECTORY_SIDECAR_NAME = 'mongo-gui-backup.json';

/** The backup services the backup calls use. The router builds them. */
export interface BackupRpcServices {
  readonly backups: Pick<BackupService, 'startDump' | 'startRestore' | 'cancel'>;
  /** Reads the server facts the backup dialog shows. */
  readonly describeServer: (client: BackupClient, scope?: BackupScope) => Promise<BackupServerInfo>;
  /** Describes an archive or a dump folder. */
  readonly inspect: (path: string) => Promise<BackupInspection>;
}

/** What the backup service needs from the router. */
export interface BackupRpcDeps {
  /** The backup and tools services. Throws INTERNAL when the router was built without them. */
  readonly tools: () => BackupRpcServices;
  readonly getClient: (connectionId: string) => BackupClient;
  readonly repos: () => {
    readonly savedBackups: SavedBackupsRepository;
    readonly savedRestores: SavedRestoresRepository;
  };
  readonly requireConnectionProfile: (connectionId: string) => void;
  /** The real location of a folder picked in a folder dialog this session, or undefined. */
  readonly pickedFolder: (folder: string) => string | undefined;
  /** True when the file was picked in an open dialog this session. */
  readonly isOpenedFile: (file: string) => boolean;
  readonly resolveRequestPath: (path: string) => string;
  readonly isDirectory: (path: string) => boolean;
}

export interface BackupRpcService {
  operations(): [string, Operation][];
  /** Forgets the backup sources inspected this session. Called on renderer reset. */
  clearInspected(): void;
}

/**
 * Creates the backup, saved backup and saved restore calls. A restore reads only a source that an
 * inspect call returned this session.
 */
export function createBackupRpcService(deps: BackupRpcDeps): BackupRpcService {
  // Backup sources inspected this session: a restore reads only these.
  const inspectedSources = new Set<string>();

  /**
   * The source a backup.inspect call may read: an archive picked in an open dialog (a picked
   * sidecar stands for its archive or dump folder), or a folder picked in a folder dialog.
   */
  const inspectableSource = (path: string): string => {
    const file = deps.resolveRequestPath(path);
    if (deps.isOpenedFile(file)) {
      if (basename(file) === DIRECTORY_SIDECAR_NAME) {
        return dirname(file);
      }
      return file.endsWith('.json') ? file.slice(0, -'.json'.length) : file;
    }
    const folder = deps.pickedFolder(file);
    if (folder !== undefined && deps.isDirectory(folder)) {
      return folder;
    }
    throw new AppErrorException(appError('VALIDATION', 'Choose the backup in a dialog first.'));
  };

  function operations(): [string, Operation][] {
    return [
      entry('savedRestores.list', rpcContract.savedRestores.list, () =>
        deps.repos().savedRestores.list(),
      ),
      entry('savedRestores.save', rpcContract.savedRestores.save, (input) => {
        // Only a source inspected this session, so a saved path was always picked in a dialog.
        if (!inspectedSources.has(deps.resolveRequestPath(input.source))) {
          throw new AppErrorException(appError('VALIDATION', 'Open the backup in a dialog first.'));
        }
        return deps
          .repos()
          .savedRestores.save({ ...input, source: deps.resolveRequestPath(input.source) });
      }),
      entry('savedRestores.open', rpcContract.savedRestores.open, async (input) => {
        const saved = deps
          .repos()
          .savedRestores.list()
          .find((item) => item.id === input.id);
        if (saved === undefined) {
          throw new AppErrorException(appError('NOT_FOUND', 'The saved restore was not found.'));
        }
        const inspection = await deps.tools().inspect(saved.source);
        inspectedSources.add(saved.source);
        inspectedSources.add(inspection.path);
        return inspection;
      }),
      entry('savedRestores.rename', rpcContract.savedRestores.rename, (input) =>
        deps.repos().savedRestores.rename(input.id, input.name),
      ),
      entry('savedRestores.remove', rpcContract.savedRestores.remove, (input) => {
        deps.repos().savedRestores.remove(input.id);
      }),

      entry('backup.describeServer', rpcContract.backup.describeServer, (input) => {
        deps.requireConnectionProfile(input.connectionId);
        const { describeServer } = deps.tools();
        return driverCall(() => describeServer(deps.getClient(input.connectionId), input.scope));
      }),
      entry('backup.start', rpcContract.backup.start, async (input) => {
        deps.requireConnectionProfile(input.connectionId);
        const folder = deps.pickedFolder(input.folder);
        if (folder === undefined) {
          throw new AppErrorException(
            appError('VALIDATION', 'Choose the backup folder in a dialog first.'),
          );
        }
        // The service writes into the real folder, so the kernel writes where the check looked.
        return { jobId: await deps.tools().backups.startDump({ ...input, folder }) };
      }),
      entry('backup.inspect', rpcContract.backup.inspect, async (input) => {
        const source = inspectableSource(input.path);
        const inspection = await deps.tools().inspect(source);
        inspectedSources.add(source);
        inspectedSources.add(inspection.path);
        return inspection;
      }),
      entry('backup.startRestore', rpcContract.backup.startRestore, async (input) => {
        deps.requireConnectionProfile(input.connectionId);
        const source = deps.resolveRequestPath(input.source);
        if (!inspectedSources.has(source)) {
          throw new AppErrorException(appError('VALIDATION', 'Open the backup in a dialog first.'));
        }
        return { jobId: await deps.tools().backups.startRestore({ ...input, source }) };
      }),
      entry('savedBackups.list', rpcContract.savedBackups.list, () =>
        deps.repos().savedBackups.list(),
      ),
      entry('savedBackups.save', rpcContract.savedBackups.save, (input) =>
        deps.repos().savedBackups.save(input),
      ),
      entry('savedBackups.rename', rpcContract.savedBackups.rename, (input) =>
        deps.repos().savedBackups.rename(input.id, input.label),
      ),
      entry('savedBackups.remove', rpcContract.savedBackups.remove, (input) => {
        deps.repos().savedBackups.remove(input.id);
      }),
      entry('backup.cancel', rpcContract.backup.cancel, (input) => {
        deps.tools().backups.cancel(input.jobId);
      }),
    ];
  }

  return {
    operations,
    clearInspected() {
      inspectedSources.clear();
    },
  };
}
