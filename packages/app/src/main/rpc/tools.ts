import { rpcContract, type ToolsPreference } from '@mongo-gui/core';
import type { SettingsRepository } from '@mongo-gui/storage';
import type { ToolsDownloads } from '../tools/download-service';
import type { FeedClient } from '../tools/feed-client';
import type { ToolsRegistry } from '../tools/registry';
import { entry, type Operation } from './operation';

/** The tools services the tools calls use. The router builds them. */
export interface ToolsRpcServices {
  readonly registry: Pick<ToolsRegistry, 'list' | 'remove' | 'licence'>;
  readonly feed: Pick<FeedClient, 'available'>;
  readonly downloads: ToolsDownloads;
}

/** What the tools calls need from the router. */
export interface ToolsRpcDeps {
  /** The tools services. Throws INTERNAL when the router was built without them. */
  readonly tools: () => ToolsRpcServices;
  readonly repos: () => { readonly settings: SettingsRepository };
}

/** The tools.* calls: the installed MongoDB tools, the feed of available versions and downloads. */
export function toolsOperations(deps: ToolsRpcDeps): [string, Operation][] {
  /** The saved tools version, or 'auto' while the vault is locked. */
  const toolsPreference = (): ToolsPreference => {
    try {
      return deps.repos().settings.get().mongoToolsVersion;
    } catch {
      return 'auto';
    }
  };

  return [
    entry('tools.list', rpcContract.tools.list, () =>
      deps.tools().registry.list(toolsPreference()),
    ),
    entry('tools.available', rpcContract.tools.available, async (input) => {
      const { registry, feed } = deps.tools();
      const listed = await registry.list('auto');
      const installed = listed.installs
        .filter((install) => install.health.state === 'ok')
        .map((install) => install.version);
      return feed.available(installed, input.refresh);
    }),
    entry('tools.download', rpcContract.tools.download, (input) =>
      deps.tools().downloads.start(input.version),
    ),
    entry('tools.cancelDownload', rpcContract.tools.cancelDownload, (input) => {
      deps.tools().downloads.cancel(input.downloadId);
    }),
    entry('tools.remove', rpcContract.tools.remove, (input) =>
      deps.tools().registry.remove(input.id),
    ),
    entry('tools.licence', rpcContract.tools.licence, (input) =>
      deps.tools().registry.licence(input.id),
    ),
  ];
}
