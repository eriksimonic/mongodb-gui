import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcEvent } from '@mongo-gui/core';
import { createMockTools } from './mock';

function downloadEvents(events: readonly RpcEvent[]) {
  return events.flatMap((event) => (event.type === 'tools:download' ? [event] : []));
}

describe('mock tools', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the bundled and the downloaded install, newest first', () => {
    const tools = createMockTools(() => undefined, 'ok');
    const list = tools.list('auto');
    expect(list.installs.map((install) => install.id)).toEqual(['bundled', 'downloaded:100.12.1']);
    expect(list.resolved).toBe('100.19.1');
  });

  it('has no installs in missing mode and only 100.19.1 in mismatch mode', () => {
    expect(createMockTools(() => undefined, 'missing').list('auto').installs).toEqual([]);
    expect(createMockTools(() => undefined, 'missing').list('auto').resolved).toBeUndefined();
    const mismatch = createMockTools(() => undefined, 'mismatch').list('auto');
    expect(mismatch.installs.map((install) => install.version)).toEqual(['100.19.1']);
  });

  it('reports the bundled install broken with the Kerberos message and falls back to the download', () => {
    const list = createMockTools(() => undefined, 'broken').list('auto');
    const bundled = list.installs.find((install) => install.id === 'bundled');
    expect(bundled?.health.state).toBe('broken');
    expect(JSON.stringify(bundled?.health)).toContain('libgssapi_krb5');
    expect(list.resolved).toBe('100.12.1');
  });

  it('resolves a pinned version that is installed and ignores one that is not', () => {
    const tools = createMockTools(() => undefined, 'ok');
    expect(tools.list('100.12.1').resolved).toBe('100.12.1');
    expect(tools.list('100.9.5').resolved).toBe('100.19.1');
  });

  it('lists five feed versions and marks the installed ones', () => {
    const feed = createMockTools(() => undefined, 'ok').available();
    expect(feed.versions).toHaveLength(5);
    expect(feed.versions.filter((item) => item.installed).map((item) => item.version)).toEqual([
      '100.19.1',
      '100.12.1',
    ]);
  });

  it('walks a download through its phases and installs the version', async () => {
    const events: RpcEvent[] = [];
    const tools = createMockTools((event) => events.push(event), 'missing');
    const downloadId = tools.download('100.15.0');
    await vi.advanceTimersByTimeAsync(3000);

    const phases = downloadEvents(events).map((event) => event.progress.phase);
    expect(phases[0]).toBe('downloading');
    expect(phases.slice(-4)).toEqual(['verifying', 'extracting', 'checking', 'done']);
    expect(downloadEvents(events).every((event) => event.downloadId === downloadId)).toBe(true);
    expect(tools.list('auto').installs.map((install) => install.id)).toEqual([
      'downloaded:100.15.0',
    ]);
  });

  it('stops a download on cancel and installs nothing', async () => {
    const events: RpcEvent[] = [];
    const tools = createMockTools((event) => events.push(event), 'missing');
    const downloadId = tools.download('100.15.0');
    await vi.advanceTimersByTimeAsync(300);
    tools.cancelDownload(downloadId);
    await vi.advanceTimersByTimeAsync(3000);

    const phases = downloadEvents(events).map((event) => event.progress.phase);
    expect(phases.at(-1)).toBe('cancelled');
    expect(phases).not.toContain('done');
    expect(tools.list('auto').installs).toEqual([]);
  });

  it('removes a downloaded install and refuses the bundled one', () => {
    const tools = createMockTools(() => undefined, 'ok');
    tools.remove('downloaded:100.12.1');
    expect(tools.list('auto').installs.map((install) => install.id)).toEqual(['bundled']);
    expect(() => tools.remove('bundled')).toThrow();
    expect(() => tools.remove('downloaded:100.12.1')).toThrow();
  });

  it('returns licence text for an install', () => {
    const licence = createMockTools(() => undefined, 'ok').licence('bundled');
    expect(licence.version).toBe('100.19.1');
    expect(licence.licence).toContain('Apache');
  });
});
