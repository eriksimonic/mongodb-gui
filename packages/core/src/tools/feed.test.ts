import { describe, expect, it } from 'vitest';
import { feedVersionsFor, selectFeedDownload, ToolsFeedSchema } from './feed';

const FIXTURES = import.meta.glob<unknown>('./fixtures/feed-excerpt.json', {
  eager: true,
  import: 'default',
});
const feed = ToolsFeedSchema.parse(FIXTURES['./fixtures/feed-excerpt.json']);
const sha = 'a'.repeat(64);

function entry(name: string, arch: string, url: string, hash = sha) {
  return { name, arch, archive: { url, sha256: hash } };
}

describe('feedVersionsFor', () => {
  it('keeps 100.3.0 and later, dedupes and sorts newest first', () => {
    const list = feedVersionsFor(feed, { os: 'linux', arch: 'x64' });
    expect(list.map((d) => d.version)).toEqual(['100.19.1', '100.18.0', '100.12.1', '100.3.0']);
    expect(list[0]?.target).toBe('ubuntu2004');
  });

  it('falls back to rhel70 on Linux x64', () => {
    const list = feedVersionsFor(feed, { os: 'linux', arch: 'x64' });
    expect(list.find((d) => d.version === '100.3.0')?.target).toBe('rhel70');
  });

  it('picks per platform', () => {
    expect(feedVersionsFor(feed, { os: 'win32', arch: 'x64' })[0]?.url).toMatch(/windows.*\.zip$/);
    expect(feedVersionsFor(feed, { os: 'linux', arch: 'arm64' }).map((d) => d.version)).toEqual([
      '100.19.1',
      '100.18.0',
      '100.12.1',
    ]);
    const arm = feedVersionsFor(feed, { os: 'darwin', arch: 'arm64' });
    expect(arm[0]?.url).toContain('arm64');
    expect(arm.find((d) => d.version === '100.3.0')?.url).toContain('x86_64');
  });
});

describe('selectFeedDownload', () => {
  const platform = { os: 'linux', arch: 'x64' } as const;
  const make = (url: string, hash = sha) => ({
    version: '100.1.0',
    downloads: [entry('ubuntu2004', 'x86_64', url, hash)],
  });

  it('accepts the allowed hosts', () => {
    expect(selectFeedDownload(make('https://fastdl.mongodb.org/a.tgz'), platform)).toBeDefined();
    expect(selectFeedDownload(make('https://downloads.mongodb.org/a.tgz'), platform)).toBeDefined();
  });

  it.each([
    'http://fastdl.mongodb.org/a.tgz',
    'https://evil.example.com/a.tgz',
    'https://fastdl.mongodb.org.evil.com/a.tgz',
    'https://fastdl.mongodb.org/a.rpm',
    'not a url',
  ])('drops %s', (url) => {
    expect(selectFeedDownload(make(url), platform)).toBeUndefined();
  });

  it('drops a download without a valid checksum', () => {
    expect(
      selectFeedDownload(make('https://fastdl.mongodb.org/a.tgz', 'xyz'), platform),
    ).toBeUndefined();
  });
});
