import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcEvent, ToolsDownloadProgress } from '@mongo-gui/core';
import { buildTgz } from './archive/tar.test';
import { createToolsDownloads, type ToolsDownloads } from './download-service';
import type { FeedClient } from './feed-client';
import { toolsRoots, type ToolsRoots } from './paths';
import { fakeSpawn, versionBanner } from './probe.test';
import type { ToolsRegistry } from './registry';

const VERSION = '100.19.1';
const URL_ = `https://fastdl.mongodb.org/tools/db/mongodb-database-tools-ubuntu2004-x86_64-${VERSION}.tgz`;

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

function archive(): Buffer {
  const top = `mongodb-database-tools-ubuntu2004-x86_64-${VERSION}`;
  return buildTgz([
    { name: `${top}/bin/mongodump`, data: 'dump-binary' },
    { name: `${top}/bin/mongorestore`, data: 'restore-binary' },
    { name: `${top}/LICENSE.md`, data: 'licence' },
    { name: `${top}/bin/other`, data: 'ignored' },
  ]);
}

function stream(chunks: Buffer[], gate?: Promise<void>): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (gate && i === 1) await gate;
      const chunk = chunks[i++];
      if (chunk) controller.enqueue(new Uint8Array(chunk));
      else controller.close();
    },
  });
}

function split(data: Buffer): Buffer[] {
  const mid = Math.floor(data.length / 2);
  return [data.subarray(0, mid), data.subarray(mid)];
}

describe('createToolsDownloads', () => {
  let dir: string;
  let roots: ToolsRoots;
  let events: { downloadId: string; progress: ToolsDownloadProgress }[];
  let installed: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tools-download-'));
    roots = toolsRoots({
      isPackaged: false,
      resourcesPath: '',
      appRoot: dir,
      userDataDir: dir,
      platform: 'linux',
      arch: 'x64',
    });
    await mkdir(roots.downloaded, { recursive: true });
    events = [];
    installed = [];
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  function make(
    body: () => Response | Promise<Response>,
    options: { sha?: string; probeVersion?: string; data?: Buffer } = {},
  ): ToolsDownloads {
    const data = options.data ?? archive();
    const feed: FeedClient = {
      available: vi.fn(),
      find: (version) =>
        Promise.resolve(
          version === VERSION
            ? { version, target: 'ubuntu2004', url: URL_, sha256: options.sha ?? sha(data) }
            : undefined,
        ),
    };
    const registry = {
      list: () => Promise.resolve({ installs: installed.map((version) => ({ version })) }),
    } as unknown as ToolsRegistry;
    return createToolsDownloads({
      feed,
      registry,
      fetchImpl: (() => Promise.resolve(body())) as unknown as typeof fetch,
      emit: (event: RpcEvent) => {
        if (event.type === 'tools:download') events.push(event);
      },
      roots,
      platform: { os: 'linux', arch: 'x64' },
      now: () => new Date('2026-10-10T10:00:00.000Z'),
      spawn: fakeSpawn(() => ({ stdout: versionBanner(options.probeVersion ?? VERSION) })).spawn,
      env: { PATH: '/usr/bin' },
    });
  }

  const response = (chunks: Buffer[], gate?: Promise<void>, url = URL_): Response => {
    const res = new Response(stream(chunks, gate), {
      headers: { 'content-length': String(chunks.reduce((n, c) => n + c.length, 0)) },
    });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };

  const last = (): ToolsDownloadProgress | undefined => events.at(-1)?.progress;
  const settle = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(['done', 'error', 'cancelled']).toContain(last()?.phase);
    });
  };

  it('downloads, verifies, extracts and installs a version', async () => {
    const data = archive();
    const downloads = make(() => response(split(data)), { data });
    const { downloadId } = await downloads.start(VERSION);
    await settle();
    expect(last()?.phase).toBe('done');
    expect(events.every((e) => e.downloadId === downloadId)).toBe(true);
    const phases = events.map((e) => e.progress.phase);
    expect(phases).toEqual(
      expect.arrayContaining(['downloading', 'verifying', 'extracting', 'checking']),
    );
    const target = join(roots.downloaded, `${VERSION}-ubuntu2004`);
    expect(await readdir(target)).toEqual(
      expect.arrayContaining(['bin', 'LICENSE.md', 'install.json']),
    );
    const manifest = JSON.parse(await readFile(join(target, 'install.json'), 'utf8'));
    expect(manifest).toMatchObject({
      source: 'downloaded',
      version: VERSION,
      archiveSha256: sha(data),
      binaries: { mongodump: sha(Buffer.from('dump-binary')) },
    });
    expect(await readdir(roots.downloaded)).toEqual([`${VERSION}-ubuntu2004`]);
  });

  it('refuses a checksum mismatch and removes the partial file', async () => {
    const downloads = make(() => response(split(archive())), { sha: 'c'.repeat(64) });
    await downloads.start(VERSION);
    await settle();
    expect(last()).toMatchObject({ phase: 'error', error: { code: 'VALIDATION' } });
    // The service sends the final event first and removes the staging folder in its cleanup.
    await vi.waitFor(async () => {
      expect(await readdir(roots.downloaded)).toEqual([]);
    });
  });

  it('cancels mid-stream and deletes the partial file', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const downloads = make(() => response(split(archive()), gate));
    const { downloadId } = await downloads.start(VERSION);
    await vi.waitFor(async () => expect((await readdir(roots.downloaded)).length).toBe(1));
    downloads.cancel(downloadId);
    release();
    await settle();
    expect(last()?.phase).toBe('cancelled');
    // The service sends the final event first and removes the staging folder in its cleanup.
    await vi.waitFor(async () => {
      expect(await readdir(roots.downloaded)).toEqual([]);
    });
  });

  it('refuses a second download while one runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const downloads = make(() => response(split(archive()), gate));
    await downloads.start(VERSION);
    await expect(downloads.start(VERSION)).rejects.toMatchObject({
      error: { code: 'ALREADY_EXISTS' },
    });
    downloads.cancelAll();
    release();
    await settle();
  });

  it('refuses an installed version and an unknown one', async () => {
    installed = [VERSION];
    const downloads = make(() => response([]));
    await expect(downloads.start(VERSION)).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    installed = [];
    await expect(downloads.start('100.1.1')).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('reports an archive that extraction refuses and leaves no staging folder', async () => {
    const data = buildTgz([{ name: 'top/../evil', data: 'x' }]);
    const downloads = make(() => response(split(data)), { data });
    await downloads.start(VERSION);
    await settle();
    expect(last()).toMatchObject({ phase: 'error', error: { code: 'VALIDATION' } });
    // The service sends the final event first and removes the staging folder in its cleanup.
    await vi.waitFor(async () => {
      expect(await readdir(roots.downloaded)).toEqual([]);
    });
  });

  it('refuses an archive whose binary reports another version', async () => {
    const downloads = make(() => response(split(archive())), { probeVersion: '100.1.0' });
    await downloads.start(VERSION);
    await settle();
    expect(last()).toMatchObject({ phase: 'error', error: { code: 'VALIDATION' } });
    // The service sends the final event first and removes the staging folder in its cleanup.
    await vi.waitFor(async () => {
      expect(await readdir(roots.downloaded)).toEqual([]);
    });
  });

  it('refuses a redirect to a host that is not trusted', async () => {
    const downloads = make(() => {
      return response(split(archive()), undefined, 'https://evil.example.com/a.tgz');
    });
    await downloads.start(VERSION);
    await settle();
    expect(last()).toMatchObject({ phase: 'error', error: { code: 'VALIDATION' } });
  });

  it('reports a file that cannot be written while the body is still streaming', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const downloads = make(async () => {
      // A file in place of the folder makes the partial file fail to open.
      await rm(roots.downloaded, { recursive: true, force: true });
      await writeFile(roots.downloaded, '');
      return response(split(archive()), gate);
    });
    await downloads.start(VERSION);
    try {
      await settle();
      expect(last()?.phase).toBe('error');
    } finally {
      release();
    }
  });

  it('maps a network failure to CONNECTION_FAILED', async () => {
    const downloads = make(() => Promise.reject(new TypeError('fetch failed')));
    await downloads.start(VERSION);
    await settle();
    expect(last()).toMatchObject({ phase: 'error', error: { code: 'CONNECTION_FAILED' } });
  });
});
