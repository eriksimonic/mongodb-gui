import { describe, expect, it, vi } from 'vitest';
import { createFeedClient, FEED_URL } from './feed-client';

const SHA = 'b'.repeat(64);

function feed(): unknown {
  const download = (version: string): unknown => ({
    version,
    downloads: [
      {
        name: 'ubuntu2004',
        arch: 'x86_64',
        archive: {
          url: `https://fastdl.mongodb.org/tools/db/mongodb-database-tools-ubuntu2004-x86_64-${version}.tgz`,
          sha256: SHA,
        },
      },
    ],
  });
  return { versions: [download('100.9.4'), download('100.19.1'), download('99.0.0')] };
}

function setup(respond: () => Promise<Response>) {
  let time = new Date('2026-10-10T10:00:00.000Z');
  const fetchImpl = vi.fn(respond) as unknown as typeof fetch;
  const client = createFeedClient({
    fetchImpl,
    now: () => time,
    platform: { os: 'linux', arch: 'x64' },
  });
  return {
    client,
    fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
    advance: (ms: number) => {
      time = new Date(time.getTime() + ms);
    },
  };
}

const ok = (): Promise<Response> => Promise.resolve(Response.json(feed()));

describe('createFeedClient', () => {
  it('lists versions newest first, marks installed ones and exposes no URL', async () => {
    const { client, fetchImpl } = setup(ok);
    const out = await client.available(['100.9.4']);
    expect(out.versions).toEqual([
      { version: '100.19.1', target: 'ubuntu2004', installed: false },
      { version: '100.9.4', target: 'ubuntu2004', installed: true },
    ]);
    expect(out.fetchedAt).toBe('2026-10-10T10:00:00.000Z');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(FEED_URL);
    expect(JSON.stringify(out)).not.toContain('https://');
  });

  it('caches for one hour and refetches on refresh', async () => {
    const { client, fetchImpl, advance } = setup(ok);
    await client.available([]);
    advance(59 * 60 * 1000);
    await client.available([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await client.available([], true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    advance(61 * 60 * 1000);
    await client.available([]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('finds the download of one version', async () => {
    const { client } = setup(ok);
    expect((await client.find('100.19.1'))?.sha256).toBe(SHA);
    expect(await client.find('100.1.1')).toBeUndefined();
  });

  it('maps a network failure to CONNECTION_FAILED', async () => {
    const { client } = setup(() => Promise.reject(new TypeError('fetch failed')));
    await expect(client.available([])).rejects.toMatchObject({
      error: { code: 'CONNECTION_FAILED' },
    });
  });

  it('maps an error status and a malformed body to CONNECTION_FAILED', async () => {
    const status = setup(() => Promise.resolve(new Response('no', { status: 503 })));
    await expect(status.client.available([])).rejects.toMatchObject({
      error: { code: 'CONNECTION_FAILED' },
    });
    const bad = setup(() => Promise.resolve(Response.json({ nope: 1 })));
    await expect(bad.client.available([])).rejects.toMatchObject({
      error: { code: 'CONNECTION_FAILED' },
    });
  });
});
