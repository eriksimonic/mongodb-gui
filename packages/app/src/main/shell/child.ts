import type { ChildProcess } from 'node:child_process';
import type { UtilityProcess } from 'electron';
import type { ShellRequest } from '@mongo-gui/core';

// The parts of a runtime process the supervisor uses. An Electron utility process and a forked
// Node child both satisfy it through the adapters below, so the supervisor and its tests see one
// interface.
export interface RuntimeChild {
  send(message: ShellRequest): void;
  onMessage(listener: (raw: unknown) => void): void;
  onExit(listener: (exitCode: number | null) => void): void;
  // Hard stop. The process ends without a chance to finish its work.
  kill(): void;
  // Sends SIGINT where POSIX signals exist. It interrupts a synchronous loop in the script.
  interrupt(): void;
}

export interface ForkRequest {
  readonly entryPath: string;
  readonly execArgv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly serviceName: string;
}

export type ForkFunction = (request: ForkRequest) => RuntimeChild;

// Variables the runtime may read. It never receives the rest of the main process environment.
const PASSTHROUGH_NAMES: readonly string[] = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LANGUAGE'];
const PASSTHROUGH_PREFIXES: readonly string[] = ['LC_'];

export function minimalEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = { USE_NEW_AUTOCOMPLETE: '0' };
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    const passes =
      PASSTHROUGH_NAMES.includes(name) ||
      PASSTHROUGH_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (passes) {
      env[name] = value;
    }
  }
  return env;
}

// Wraps an Electron utility process. Its messages arrive as data, and SIGINT goes to its pid.
export function fromUtilityProcess(proc: UtilityProcess): RuntimeChild {
  return {
    send(message) {
      proc.postMessage(message);
    },
    onMessage(listener) {
      proc.on('message', (raw: unknown) => {
        listener(raw);
      });
    },
    onExit(listener) {
      proc.on('exit', (exitCode: number) => {
        listener(exitCode);
      });
    },
    kill() {
      proc.kill();
    },
    interrupt() {
      if (process.platform !== 'win32' && proc.pid !== undefined) {
        process.kill(proc.pid, 'SIGINT');
      }
    },
  };
}

// Wraps a forked Node child, such as the one the integration tests start.
export function fromChildProcess(child: ChildProcess): RuntimeChild {
  return {
    send(message) {
      child.send(message);
    },
    onMessage(listener) {
      child.on('message', (raw: unknown) => {
        listener(raw);
      });
    },
    onExit(listener) {
      child.on('exit', (exitCode: number | null) => {
        listener(exitCode);
      });
      child.on('error', () => {
        listener(null);
      });
    },
    kill() {
      child.kill('SIGKILL');
    },
    interrupt() {
      if (process.platform !== 'win32') {
        child.kill('SIGINT');
      }
    },
  };
}
