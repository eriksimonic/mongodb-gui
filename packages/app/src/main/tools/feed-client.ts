import {
  AppErrorException,
  appError,
  feedVersionsFor,
  ToolsFeedSchema,
  type FeedDownload,
  type ToolsAvailableOutput,
  type ToolsPlatform,
} from '@mongo-gui/core';

export const FEED_URL = 'https://downloads.mongodb.org/tools/db/full.json';
const FEED_TIMEOUT_MS = 30_000;
const CACHE_MS = 60 * 60 * 1000;

export interface FeedClientDeps {
  // Electron net.fetch in the app, so the system proxy applies.
  readonly fetchImpl: typeof fetch;
  readonly now: () => Date;
  readonly platform: ToolsPlatform;
}

export interface FeedClient {
  // Versions this platform can download. No URL is part of the output.
  available(installedVersions: readonly string[], refresh?: boolean): Promise<ToolsAvailableOutput>;
  // The trusted download for one version, or undefined when the feed has none.
  find(version: string): Promise<FeedDownload | undefined>;
}

interface Cached {
  readonly fetchedAt: Date;
  readonly downloads: FeedDownload[];
}

export function createFeedClient(deps: FeedClientDeps): FeedClient {
  let cache: Cached | undefined;

  async function load(refresh: boolean): Promise<Cached> {
    if (!refresh && cache && deps.now().getTime() - cache.fetchedAt.getTime() < CACHE_MS) {
      return cache;
    }
    let body: unknown;
    try {
      const response = await deps.fetchImpl(FEED_URL, {
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new AppErrorException(
          appError('CONNECTION_FAILED', `The MongoDB download feed answered ${response.status}.`),
        );
      }
      body = await response.json();
    } catch (error) {
      if (error instanceof AppErrorException) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new AppErrorException(
        appError('CONNECTION_FAILED', 'Could not reach the MongoDB download feed.', detail),
      );
    }
    const parsed = ToolsFeedSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppErrorException(
        appError('CONNECTION_FAILED', 'The MongoDB download feed has an unexpected format.'),
      );
    }
    cache = { fetchedAt: deps.now(), downloads: feedVersionsFor(parsed.data, deps.platform) };
    return cache;
  }

  return {
    async available(installedVersions, refresh = false) {
      const { fetchedAt, downloads } = await load(refresh);
      const installed = new Set(installedVersions);
      return {
        fetchedAt: fetchedAt.toISOString(),
        versions: downloads.map((download) => ({
          version: download.version,
          target: download.target,
          installed: installed.has(download.version),
        })),
      };
    },

    async find(version) {
      const { downloads } = await load(false);
      return downloads.find((download) => download.version === version);
    },
  };
}
