import type { ChildProcess } from 'node:child_process';
import { pipeline, type Readable, type Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  appError,
  AppErrorException,
  parseToolLine,
  type AppError,
  type ToolLogLine,
} from '@mongo-gui/core';
import { redactPassword } from '@mongo-gui/mongo-adapter';
import { redactText } from '../redact';
import type { SpawnFn } from '../tools/probe';

export interface RunToolOptions {
  spawn: SpawnFn;
  binary: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string;
  // Piped into the child's stdin (archive restore).
  stdin?: Readable;
  // Receives the child's stdout (archive dump). The run resolves after this stream finishes.
  stdout?: Writable;
  // Strings masked in every line and error, on top of URI password redaction.
  secrets: readonly string[];
  // Gets each stderr line after redaction, parsed and as text.
  onLine: (parsed: ToolLogLine, redactedText: string) => void;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  // Time between SIGINT and SIGKILL on cancel.
  killGraceMs?: number;
  // A tool that prints nothing for this long after it starts is killed. A tool that cannot reach
  // the server ignores SIGINT and waits for ever, and it prints its first line only once it connects.
  startupTimeoutMs?: number;
}

export interface ToolRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  // The reason from the last `Failed:` line, redacted.
  lastFailed?: string;
  // The last stderr lines, redacted.
  tail: string[];
}

const LINE_CAP = 2000;
const TAIL_LINES = 5;
const KILL_GRACE_MS = 5000;
const STARTUP_TIMEOUT_MS = 120_000;
// Write errors on the child's stdin once it has exited. The exit code explains the failure.
const CLOSED_PIPE_CODES = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

/**
 * Runs mongodump or mongorestore. Resolves when the tool exits with code 0 and printed no
 * `Failed:` line. Otherwise rejects with an AppErrorException: NOT_FOUND when the binary cannot
 * start, CANCELLED after the signal aborts, COMMAND_FAILED for a failed run, INTERNAL when a
 * piped stream fails. stderr lines go only to onLine, never to the app log, because they can
 * hold key values from the data.
 */
export function runTool(options: RunToolOptions): Promise<ToolRunResult> {
  const platform = options.platform ?? process.platform;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  // The tool name for messages. Split on both separators so a Windows path works on any host.
  const tool = (options.binary.split(/[\\/]/).pop() ?? options.binary).replace(/\.exe$/i, '');
  const secrets = [...options.secrets].sort((a, b) => b.length - a.length);
  const mask = (text: string): string =>
    secrets.reduce((value, secret) => redactPassword(value, secret), redactPassword(text));

  if (options.signal?.aborted) {
    return Promise.reject(cancelledError(tool));
  }

  return new Promise<ToolRunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = options.spawn(options.binary, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        stdio: [options.stdin ? 'pipe' : 'ignore', options.stdout ? 'pipe' : 'ignore', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      reject(new AppErrorException(spawnFailure(error, tool)));
      return;
    }

    const tail: string[] = [];
    let lastFailed: string | undefined;
    let aborted = false;
    let streamError: unknown;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const pending: Promise<void>[] = [];
    let stalled = false;
    const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    let startupTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      startupTimer = undefined;
      stalled = true;
      destroyPipes();
      child.kill('SIGKILL');
    }, startupTimeoutMs);
    const clearStartupTimer = (): void => {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    };

    const emitLine = (raw: string): void => {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.trim() === '') return;
      const text = mask(redactText(line.slice(0, LINE_CAP)));
      const parsed = parseToolLine(text);
      if (parsed.kind === 'failed') lastFailed = parsed.reason;
      tail.push(text);
      if (tail.length > TAIL_LINES) tail.shift();
      options.onLine(parsed, text);
    };

    // stderr arrives in chunks that can split a line or a UTF-8 character. A partial line is
    // held until its newline arrives, and only its first LINE_CAP characters are kept.
    const decoder = new StringDecoder('utf8');
    let partial = '';
    const take = (text: string): void => {
      const parts = (partial + text).split('\n');
      partial = (parts.pop() ?? '').slice(0, LINE_CAP + 1);
      for (const part of parts) emitLine(part);
    };
    const flush = (): void => {
      take(decoder.end());
      if (partial !== '') emitLine(partial);
      partial = '';
    };
    child.stderr?.on('data', (chunk: Buffer | string) => {
      clearStartupTimer();
      take(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    });

    const track = (source: Readable, target: Writable, ignore: (error: unknown) => boolean) => {
      pending.push(
        new Promise<void>((done) => {
          pipeline(source, target, (error) => {
            if (error && !aborted && !ignore(error)) streamError ??= error;
            done();
          });
        }),
      );
    };
    if (options.stdin && child.stdin) {
      track(options.stdin, child.stdin, (error) =>
        CLOSED_PIPE_CODES.has((error as NodeJS.ErrnoException).code ?? ''),
      );
    }
    if (options.stdout && child.stdout) {
      track(child.stdout, options.stdout, () => false);
    }

    const destroyPipes = (): void => {
      child.stdin?.destroy();
      child.stdout?.destroy();
    };

    const onAbort = (): void => {
      if (settled || aborted) return;
      aborted = true;
      destroyPipes();
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (platform === 'win32') {
        child.kill();
        return;
      }
      child.kill('SIGINT');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (outcome: { result: ToolRunResult } | { error: AppError }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearStartupTimer();
      options.signal?.removeEventListener('abort', onAbort);
      if ('result' in outcome) resolve(outcome.result);
      else reject(new AppErrorException(outcome.error));
    };

    child.on('error', (error) => {
      // A child that never got a pid failed to start. Later errors (a failed kill) leave the
      // outcome to the close event.
      if (child.pid !== undefined) return;
      destroyPipes();
      settle({ error: spawnFailure(error, tool) });
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      flush();
      void Promise.all(pending).then(() => {
        const result: ToolRunResult = {
          exitCode: code,
          signal,
          ...(lastFailed === undefined ? {} : { lastFailed }),
          tail: [...tail],
        };
        if (aborted) {
          settle({ error: cancelledError(tool).error });
        } else if (stalled) {
          settle({ error: stalledError(tool, startupTimeoutMs) });
        } else if (streamError !== undefined && code === 0) {
          settle({ error: streamFailure(streamError, tool, mask) });
        } else if (code === 0 && lastFailed === undefined) {
          settle({ result });
        } else {
          settle({ error: commandFailure(tool, result) });
        }
      });
    });
  });
}

function cancelledError(tool: string): AppErrorException {
  return new AppErrorException(appError('CANCELLED', `The ${tool} run was cancelled.`));
}

function stalledError(tool: string, timeoutMs: number): AppError {
  return appError(
    'COMMAND_FAILED',
    `${tool} printed nothing for ${Math.round(timeoutMs / 1000)} seconds and was stopped.`,
    'It probably could not reach the server. Check the host, the port and the network.',
  );
}

function commandFailure(tool: string, result: ToolRunResult): AppError {
  const message =
    result.exitCode === 0
      ? `${tool} reported a failure.`
      : result.exitCode !== null
        ? `${tool} failed with exit code ${result.exitCode}.`
        : `${tool} was stopped by ${result.signal ?? 'a signal'}.`;
  const detail = result.lastFailed ?? result.tail.join('\n');
  return appError('COMMAND_FAILED', message, detail === '' ? undefined : detail);
}

function streamFailure(error: unknown, tool: string, mask: (text: string) => string): AppError {
  const message = error instanceof Error ? error.message : String(error);
  return appError('INTERNAL', `Streaming data for ${tool} failed.`, mask(redactText(message)));
}

function spawnFailure(error: unknown, tool: string): AppError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'EACCES') {
    return appError('NOT_FOUND', `The ${tool} binary is missing or not executable.`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return appError('INTERNAL', `${tool} could not start: ${message}`);
}
