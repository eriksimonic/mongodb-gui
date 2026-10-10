import type { ToolsDownloadProgress, ToolsListOutput, ToolsVersion } from '@mongo-gui/core';
import { useCallback, useEffect, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { runReported } from '../notify-error';

export interface ToolsDownloadState {
  readonly version: ToolsVersion;
  readonly progress: ToolsDownloadProgress;
}

export interface MongoTools {
  /** The installed tools, or undefined until the first load. */
  readonly list: ToolsListOutput | undefined;
  readonly reload: () => Promise<void>;
  /** The latest progress of every download seen since this hook mounted, by download id. */
  readonly downloads: Readonly<Record<string, ToolsDownloadState>>;
}

/** Loads the installed tools and follows downloads. A finished download reloads the list. */
export function useMongoTools(): MongoTools {
  const { rpc, onEvent } = useUiApi();
  const [list, setList] = useState<ToolsListOutput | undefined>(undefined);
  const [downloads, setDownloads] = useState<Readonly<Record<string, ToolsDownloadState>>>({});

  const reload = useCallback(async () => {
    setList(await rpc.tools.list());
  }, [rpc]);

  useEffect(() => {
    let active = true;
    void runReported(async () => {
      const loaded = await rpc.tools.list();
      if (active) {
        setList(loaded);
      }
    });
    const stop = onEvent((event) => {
      if (event.type !== 'tools:download') {
        return;
      }
      setDownloads((current) => ({
        ...current,
        [event.downloadId]: { version: event.version, progress: event.progress },
      }));
      if (event.progress.phase === 'done') {
        void runReported(async () => {
          const loaded = await rpc.tools.list();
          if (active) {
            setList(loaded);
          }
        });
      }
    });
    return () => {
      active = false;
      stop();
    };
  }, [rpc, onEvent]);

  return { list, reload, downloads };
}
