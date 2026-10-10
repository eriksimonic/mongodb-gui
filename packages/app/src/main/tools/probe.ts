import type { ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { appError, parseToolsVersionOutput, type AppError } from '@mongo-gui/core';
import { binaryName } from './paths';
import { toolEnv } from './tool-env';

export type SpawnFn = typeof spawn;

export type ProbeResult =
  | { ok: true; version: string; gitVersion?: string; goVersion?: string }
  | { ok: false; error: AppError };

export interface ProbeOptions {
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
}

const PROBE_TIMEOUT_MS = 10_000;
// A version banner is a few hundred bytes. Anything past this is noise.
const OUTPUT_CAP = 64 * 1024;
const MISSING_LIBRARY = /error while loading shared libraries: ([^\s:]+)/;
const KERBEROS_HINT = 'Install libgssapi-krb5-2 (Debian, Ubuntu) or krb5-libs (Fedora, RHEL).';

// Runs `mongodump --version` from binDir and reads the version banner. Never throws: every failure
// comes back as an AppError so the registry can list the install as broken.
export function probeTools(
  binDir: string,
  spawnFn: SpawnFn,
  platform: NodeJS.Platform,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const binary = join(binDir, binaryName('mongodump', platform));
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(binary, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env ?? toolEnv(process.env, platform),
        windowsHide: true,
      });
    } catch (error) {
      resolve(spawnFailure(error, binDir));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        error: appError('COMMAND_FAILED', 'mongodump --version did not answer within 10 seconds.'),
      });
    }, options.timeoutMs ?? PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(spawnFailure(error, binDir)));
    child.on('close', (code: number | null) => finish(interpret(code, stdout, stderr)));
  });
}

function interpret(code: number | null, stdout: string, stderr: string): ProbeResult {
  const library = MISSING_LIBRARY.exec(stderr)?.[1];
  if (library) {
    return {
      ok: false,
      error: appError('NOT_FOUND', `mongodump needs ${library}. ${KERBEROS_HINT}`),
    };
  }
  if (code === 127) {
    return {
      ok: false,
      error: appError(
        'NOT_FOUND',
        `mongodump needs a shared library that is missing. ${KERBEROS_HINT}`,
      ),
    };
  }
  if (code !== 0) {
    const detail = stderr.trim().slice(0, 1000);
    const message =
      code === null
        ? 'mongodump --version was stopped by a signal.'
        : `mongodump --version failed with exit code ${code}.`;
    return { ok: false, error: appError('COMMAND_FAILED', message, detail || undefined) };
  }
  const parsed = parseToolsVersionOutput(stdout);
  if (!parsed) {
    return {
      ok: false,
      error: appError(
        'COMMAND_FAILED',
        'mongodump --version printed no version.',
        stdout.trim().slice(0, 1000) || undefined,
      ),
    };
  }
  return { ok: true, ...parsed };
}

function spawnFailure(error: unknown, binDir: string): ProbeResult {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return { ok: false, error: appError('NOT_FOUND', `mongodump was not found in ${binDir}.`) };
  }
  if (code === 'EACCES') {
    return { ok: false, error: appError('NOT_FOUND', `mongodump in ${binDir} is not executable.`) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: appError('INTERNAL', `mongodump could not start: ${message}`) };
}
