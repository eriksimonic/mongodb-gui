import { resolve } from 'node:path';
import {
  appError,
  AppErrorException,
  rpcContract,
  type AppVersions,
  type DialogResult,
  type OpenDialogInput,
  type SaveDialogInput,
  type StartupSettings,
} from '@mongo-gui/core';
import { ExportWriter, exportTargetProblem, replaceFile } from './export-file';
import { entry, type Operation } from './operation';
import { realFolder } from './picked-paths';

/** The most text one part of a streamed export may carry. */
const EXPORT_PART_MAX_CHARS = 2 * 1024 * 1024;

/** The start-up options file and the app restart. */
export interface AppStartup {
  readonly read: () => StartupSettings;
  readonly write: (settings: StartupSettings) => void;
  readonly restart: () => void;
}

/** Native file dialogs and the shell reveal. */
export interface AppDialogs {
  showOpenDialog(input: OpenDialogInput): Promise<DialogResult>;
  showSaveDialog(input: SaveDialogInput): Promise<DialogResult>;
  showItemInFolder(path: string): void;
}

export interface AppDeps {
  readonly openExternal: ((url: string) => Promise<void>) | undefined;
  readonly versions: (() => AppVersions) | undefined;
  readonly startup: AppStartup | undefined;
  readonly dialogs: AppDialogs | undefined;
  /** The transfers. Reveal is allowed for a file they wrote this session. */
  readonly transfers: { wroteFile(path: string): boolean };
  /** The backup service. Reveal is allowed for a file it wrote this session. */
  readonly backups: { wroteFile(path: string): boolean } | undefined;
  /** Absolute paths the user picked in a save dialog this session. An export may write only to these. */
  readonly savePaths: Set<string>;
  /** Folders picked in a folder dialog: a download may write only directly inside these. */
  readonly folderPicks: Set<string>;
  /** Files picked in an open dialog: an upload or an import reads only these, one use each. */
  readonly openedFiles: Set<string>;
  /** Exports written in parts, by target path. A failed part, a reset or a quit removes the file. */
  readonly activeExports: Map<string, ExportWriter>;
  readonly abortExport: (path: string) => void;
}

export function appOperations(deps: AppDeps): [string, Operation][] {
  const { savePaths, folderPicks, openedFiles, activeExports, transfers, backups } = deps;
  const abortExport = deps.abortExport;

  const startup = (): AppStartup => {
    if (deps.startup === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'Start-up options are not available.'));
    }
    return deps.startup;
  };

  const appVersions = (): AppVersions => {
    if (deps.versions !== undefined) {
      return deps.versions();
    }
    return {
      app: '0.0.0',
      electron: process.versions['electron'] ?? 'not running in Electron',
      chrome: process.versions['chrome'] ?? 'unknown',
      node: process.versions.node,
    };
  };

  const dialogs = (): AppDialogs => {
    if (deps.dialogs === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'File dialogs are not available.'));
    }
    return deps.dialogs;
  };

  function appendExport(path: string, writer: ExportWriter, content: string): void {
    try {
      writer.append(content);
    } catch (error) {
      abortExport(path);
      throw error;
    }
  }

  return [
    entry('app.openExternal', rpcContract.app.openExternal, async (input) => {
      if (deps.openExternal === undefined) {
        throw new AppErrorException(appError('INTERNAL', 'Links cannot be opened.'));
      }
      await deps.openExternal(new URL(input.url).href);
    }),
    entry('app.versions', rpcContract.app.versions, () => appVersions()),
    entry('app.getStartupSettings', rpcContract.app.getStartupSettings, () => startup().read()),
    entry('app.setStartupSettings', rpcContract.app.setStartupSettings, (input) => {
      startup().write(input);
      return input;
    }),
    entry('app.restart', rpcContract.app.restart, () => {
      startup().restart();
    }),
    entry('app.showOpenDialog', rpcContract.app.showOpenDialog, async (input) => {
      const picked = await dialogs().showOpenDialog(input);
      if (picked.path !== undefined) {
        if (input.directory === true) {
          // The real location is recorded at pick time, so a later symlink change cannot widen it.
          folderPicks.add(realFolder(picked.path) ?? resolve(picked.path));
        } else {
          openedFiles.add(resolve(picked.path));
        }
      }
      return picked;
    }),
    entry('app.showSaveDialog', rpcContract.app.showSaveDialog, async (input) => {
      const picked = await dialogs().showSaveDialog(input);
      if (picked.path !== undefined) {
        savePaths.add(resolve(picked.path));
      }
      return picked;
    }),
    entry('app.writeExport', rpcContract.app.writeExport, (input) => {
      const { path, content, part } = input;
      if (part === 'only') {
        // Only a path the user picked in this session is written, so the renderer cannot pick one.
        if (!savePaths.has(path)) {
          throw new AppErrorException(
            appError('VALIDATION', 'Choose the file with Save as first.'),
          );
        }
        // The pick is good for one write. A refused write needs a new pick.
        savePaths.delete(path);
        const problem = exportTargetProblem(path);
        if (problem !== undefined) {
          throw new AppErrorException(appError('VALIDATION', problem));
        }
        replaceFile(path, content);
        return;
      }
      if (part === 'abort') {
        abortExport(path);
        return;
      }
      if (content.length > EXPORT_PART_MAX_CHARS) {
        throw new AppErrorException(appError('VALIDATION', 'The export part is too large.'));
      }
      if (part === 'first') {
        if (activeExports.has(path)) {
          throw new AppErrorException(appError('VALIDATION', 'This export has already started.'));
        }
        if (!savePaths.has(path)) {
          throw new AppErrorException(
            appError('VALIDATION', 'Choose the file with Save as first.'),
          );
        }
        // The pick is good for one export, parts included.
        savePaths.delete(path);
        const problem = exportTargetProblem(path);
        if (problem !== undefined) {
          throw new AppErrorException(appError('VALIDATION', problem));
        }
        const writer = new ExportWriter(path);
        activeExports.set(path, writer);
        appendExport(path, writer, content);
        return;
      }
      const writer = activeExports.get(path);
      if (writer === undefined) {
        throw new AppErrorException(appError('VALIDATION', 'This export has not started.'));
      }
      appendExport(path, writer, content);
      if (part === 'last') {
        activeExports.delete(path);
        writer.commit();
      }
    }),
    entry('app.showItemInFolder', rpcContract.app.showItemInFolder, (input) => {
      // Only a file this session exported or backed up is revealed, so the renderer cannot open
      // arbitrary paths.
      if (!transfers.wroteFile(input.path) && backups?.wroteFile(input.path) !== true) {
        throw new AppErrorException(
          appError('VALIDATION', 'Only a file exported in this session can be shown.'),
        );
      }
      dialogs().showItemInFolder(input.path);
    }),
  ];
}
