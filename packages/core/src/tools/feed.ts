import { z } from 'zod';
import type { ToolsPlatform } from './types';

// Loose on purpose. Only the fields below are read from MongoDB's feed.
export const ToolsFeedSchema = z.looseObject({
  versions: z.array(
    z.looseObject({
      version: z.string(),
      downloads: z
        .array(
          z.looseObject({
            name: z.string(),
            arch: z.string(),
            archive: z.looseObject({ url: z.string(), sha256: z.string().optional() }).optional(),
          }),
        )
        .default([]),
    }),
  ),
});
export type ToolsFeed = z.infer<typeof ToolsFeedSchema>;
export type ToolsFeedVersion = ToolsFeed['versions'][number];
export type FeedDownload = { version: string; target: string; url: string; sha256: string };

const ALLOWED_HOSTS = new Set(['fastdl.mongodb.org', 'downloads.mongodb.org']);

// Target and arch pairs in order of preference.
function preferences(platform: ToolsPlatform): [string, string[]][] {
  if (platform.os === 'win32') return [['windows', ['x86_64']]];
  if (platform.os === 'darwin') {
    return platform.arch === 'arm64'
      ? [
          ['macos', ['arm64']],
          ['macos', ['x86_64']],
        ]
      : [['macos', ['x86_64']]];
  }
  return platform.arch === 'arm64'
    ? [
        ['ubuntu2004', ['aarch64', 'arm64']],
        ['rhel82', ['aarch64']],
      ]
    : [
        ['ubuntu2004', ['x86_64']],
        ['rhel70', ['x86_64']],
      ];
}

function safeUrl(url: string): boolean {
  const m = /^https:\/\/([^/?#@:]+)(\/[^?#]*)$/.exec(url);
  return m !== null && ALLOWED_HOSTS.has(m[1]!) && /\.(tgz|zip)$/.test(m[2]!);
}

// The download for this platform, or undefined when the feed has none or its URL is not trusted.
export function selectFeedDownload(
  version: ToolsFeedVersion,
  platform: ToolsPlatform,
): FeedDownload | undefined {
  for (const [target, arches] of preferences(platform)) {
    for (const arch of arches) {
      const entry = version.downloads.find((d) => d.name === target && d.arch === arch);
      const archive = entry?.archive;
      if (archive?.sha256 && /^[0-9a-f]{64}$/.test(archive.sha256)) {
        return safeUrl(archive.url)
          ? { version: version.version, target, url: archive.url, sha256: archive.sha256 }
          : undefined;
      }
    }
  }
  return undefined;
}

function compare(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

// Tools 100.x only, one download per version, newest first.
export function feedVersionsFor(feed: ToolsFeed, platform: ToolsPlatform): FeedDownload[] {
  const byVersion = new Map<string, ToolsFeedVersion>();
  // The last entry wins, which matches the duplicated 100.12.1.
  for (const v of feed.versions) if (/^100\.\d+\.\d+$/.test(v.version)) byVersion.set(v.version, v);
  return [...byVersion.values()]
    .map((v) => selectFeedDownload(v, platform))
    .filter((d): d is FeedDownload => d !== undefined)
    .sort((a, b) => compare(b.version, a.version));
}
