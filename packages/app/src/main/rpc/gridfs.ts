import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { appError, AppErrorException, rpcContract } from '@mongo-gui/core';
import {
  deleteFiles,
  dropBucket,
  getFile,
  listBuckets,
  listFiles,
  renameFile,
  setFileMetadata,
} from '@mongo-gui/mongo-adapter';
import { driverCall, entry, type Operation } from './operation';
import { pickedFile, realFolder, resolveRequestPath } from './picked-paths';
import type { TransferService } from './transfer';

/** The client a GridFS call runs against. */
type GridFsClient = Parameters<typeof listBuckets>[0];

/** What the GridFS calls need from the router. */
export interface GridFsDeps {
  readonly getClient: (connectionId: string) => GridFsClient;
  readonly transfers: Pick<TransferService, 'startGridFsUpload' | 'startGridFsDownload'>;
  /** Throws unless the connection has a saved profile. */
  readonly requireConnectionProfile: (connectionId: string) => void;
  /** Files the open dialog returned this session. An upload uses one up when it starts. */
  readonly openedFiles: Set<string>;
  /** Save paths the save dialog returned this session. */
  readonly savePaths: ReadonlySet<string>;
  /** Folders the folder dialog returned this session. */
  readonly folderPicks: ReadonlySet<string>;
}

/**
 * A download writes only to a save path picked this session, or directly inside a folder picked
 * this session. The folder is compared by its real location, so a symlink inside it is refused.
 */
export function refuseUnpickedDownload(
  target: string,
  savedFiles: ReadonlySet<string>,
  pickedFolders: ReadonlySet<string>,
): void {
  const folder = realFolder(dirname(target));
  if (savedFiles.has(target) || (folder !== undefined && pickedFolders.has(folder))) {
    return;
  }
  throw new AppErrorException(
    appError('VALIDATION', 'Choose the folder or the save location in a dialog first.'),
  );
}

/** A download without overwrite refuses an existing file, so the renderer can offer a replace. */
export function refuseExistingFile(path: string): void {
  if (existsSync(path)) {
    throw new AppErrorException(
      appError('ALREADY_EXISTS', 'The file exists. Replace it to overwrite.'),
    );
  }
}

/** GridFS buckets, files and transfers. Uploads and downloads pass through the picks the dialogs made. */
export function gridfsOperations(deps: GridFsDeps): [string, Operation][] {
  const { transfers, openedFiles, savePaths, folderPicks } = deps;
  return [
    entry('gridfs.listBuckets', rpcContract.gridfs.listBuckets, (input) =>
      driverCall(() => listBuckets(deps.getClient(input.connectionId), input)),
    ),
    entry('gridfs.listFiles', rpcContract.gridfs.listFiles, (input) =>
      driverCall(() => listFiles(deps.getClient(input.connectionId), input)),
    ),
    entry('gridfs.getFile', rpcContract.gridfs.getFile, (input) =>
      driverCall(() => getFile(deps.getClient(input.connectionId), input)),
    ),
    entry('gridfs.startUpload', rpcContract.gridfs.startUpload, (input) => {
      const { connectionId, ...request } = input;
      deps.requireConnectionProfile(connectionId);
      const path = pickedFile(request.path, openedFiles);
      const transferId = transfers.startGridFsUpload(connectionId, { ...request, path });
      // Used up only once the transfer has started, so a failed start leaves the pick usable.
      openedFiles.delete(path);
      return { transferId };
    }),
    entry('gridfs.startDownload', rpcContract.gridfs.startDownload, (input) => {
      const { connectionId, ...request } = input;
      deps.requireConnectionProfile(connectionId);
      const path = resolveRequestPath(request.path);
      refuseUnpickedDownload(path, savePaths, folderPicks);
      if (request.overwrite !== true) {
        // Checked before the transfer starts, so the caller gets the refusal as the call's error.
        refuseExistingFile(path);
      }
      return { transferId: transfers.startGridFsDownload(connectionId, { ...request, path }) };
    }),
    entry('gridfs.deleteFiles', rpcContract.gridfs.deleteFiles, (input) =>
      driverCall(() => deleteFiles(deps.getClient(input.connectionId), input)),
    ),
    entry('gridfs.renameFile', rpcContract.gridfs.renameFile, (input) =>
      driverCall(() => renameFile(deps.getClient(input.connectionId), input)),
    ),
    entry('gridfs.setMetadata', rpcContract.gridfs.setMetadata, (input) =>
      driverCall(() => setFileMetadata(deps.getClient(input.connectionId), input)),
    ),
    entry('gridfs.dropBucket', rpcContract.gridfs.dropBucket, (input) =>
      driverCall(() =>
        dropBucket(deps.getClient(input.connectionId), input.database, input.bucket),
      ),
    ),
  ];
}
