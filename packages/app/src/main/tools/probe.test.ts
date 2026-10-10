import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { probeTools, type SpawnFn } from './probe';

export interface FakeRun {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  // Emits an 'error' event with this errno code instead of running.
  errno?: string;
  // Never exits.
  hang?: boolean;
}

export interface FakeSpawnCall {
  file: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

// A stand-in for node:child_process spawn. The handler decides what each run prints and how it exits.
export function fakeSpawn(handler: (file: string, args: readonly string[]) => FakeRun): {
  spawn: SpawnFn;
  calls: FakeSpawnCall[];
  kills: string[];
} {
  const calls: FakeSpawnCall[] = [];
  const kills: string[] = [];
  const spawn = ((file: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options });
    const run = handler(file, args);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: string) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal?: string) => {
      kills.push(signal ?? 'SIGTERM');
      return true;
    };
    setImmediate(() => {
      if (run.errno) {
        child.emit(
          'error',
          Object.assign(new Error(`spawn ${file} ${run.errno}`), { code: run.errno }),
        );
        return;
      }
      if (run.stdout) child.stdout.write(run.stdout);
      if (run.stderr) child.stderr.write(run.stderr);
      if (run.hang) return;
      child.stdout.end();
      child.stderr.end();
      child.emit('close', run.code === undefined ? 0 : run.code);
    });
    return child as unknown as ChildProcess;
  }) as unknown as SpawnFn;
  return { spawn, calls, kills };
}

export function versionBanner(version: string): string {
  return `mongodump version: ${version}\ngit version: abc123\nGo version: go1.23.8\n   os: linux\n   arch: amd64\n   compiler: gc\n`;
}

describe('probeTools', () => {
  it('runs mongodump --version with a minimal environment and reads the banner', async () => {
    const { spawn, calls } = fakeSpawn(() => ({ stdout: versionBanner('100.19.1') }));
    const result = await probeTools('/tools/bin', spawn, 'linux', { env: { PATH: '/usr/bin' } });
    expect(result).toEqual({
      ok: true,
      version: '100.19.1',
      gitVersion: 'abc123',
      goVersion: 'go1.23.8',
    });
    expect(calls[0]?.file).toBe(join('/tools/bin', 'mongodump'));
    expect(calls[0]?.args).toEqual(['--version']);
    expect(calls[0]?.options).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin' },
    });
  });

  it('runs mongodump.exe on Windows', async () => {
    const { spawn, calls } = fakeSpawn(() => ({ stdout: versionBanner('100.19.1') }));
    await probeTools('C:\\tools\\bin', spawn, 'win32');
    expect(calls[0]?.file.endsWith('mongodump.exe')).toBe(true);
  });

  it('names the missing shared library and the Kerberos packages', async () => {
    const { spawn } = fakeSpawn(() => ({
      stderr:
        'mongodump: error while loading shared libraries: libgssapi_krb5.so.2: cannot open shared object file: No such file or directory\n',
      code: 127,
    }));
    const result = await probeTools('/tools/bin', spawn, 'linux');
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message:
          'mongodump needs libgssapi_krb5.so.2. Install libgssapi-krb5-2 (Debian, Ubuntu) or krb5-libs (Fedora, RHEL).',
      },
    });
  });

  it('treats exit code 127 without a library name as a missing library', async () => {
    const { spawn } = fakeSpawn(() => ({ code: 127 }));
    const result = await probeTools('/tools/bin', spawn, 'linux');
    expect(result.ok === false && result.error.code).toBe('NOT_FOUND');
  });

  it.each(['ENOENT', 'EACCES'])('maps %s to NOT_FOUND', async (errno) => {
    const { spawn } = fakeSpawn(() => ({ errno }));
    const result = await probeTools('/tools/bin', spawn, 'linux');
    expect(result.ok === false && result.error.code).toBe('NOT_FOUND');
  });

  it('reports a non-zero exit and output without a version', async () => {
    const failed = await probeTools(
      '/b',
      fakeSpawn(() => ({ code: 2, stderr: 'boom' })).spawn,
      'linux',
    );
    expect(failed).toEqual({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'mongodump --version failed with exit code 2.',
        detail: 'boom',
      },
    });
    const garbled = await probeTools('/b', fakeSpawn(() => ({ stdout: 'hello' })).spawn, 'linux');
    expect(garbled.ok === false && garbled.error.message).toBe(
      'mongodump --version printed no version.',
    );
  });

  it('kills a probe that does not answer in time', async () => {
    vi.useFakeTimers();
    try {
      const { spawn, kills } = fakeSpawn(() => ({ hang: true }));
      const pending = probeTools('/b', spawn, 'linux');
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(kills).toEqual(['SIGKILL']);
      expect(result.ok === false && result.error.code).toBe('COMMAND_FAILED');
    } finally {
      vi.useRealTimers();
    }
  });
});
