import type { ShellResponse } from '@mongo-gui/core';

export type Transport = {
  send(msg: ShellResponse): void;
  onMessage(cb: (raw: unknown) => void): void;
  onClose(cb: () => void): void;
};

// The Electron utility process port. Only the members this package uses are declared.
export interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

// The parts of a Node child process (process.send and process.on) this package uses.
export interface ForkedProcessLike {
  send?: (message: unknown) => unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

// Picks the transport at startup. It uses the Electron utility process port when one exists, and
// otherwise the IPC channel of a forked Node child process.
export function chooseTransport(proc: object & ForkedProcessLike): Transport {
  const port = findParentPort(proc);
  return port === undefined ? processSendTransport(proc) : parentPortTransport(port);
}

export function parentPortTransport(port: ParentPortLike): Transport {
  return {
    send(msg) {
      port.postMessage(msg);
    },
    onMessage(cb) {
      port.on('message', (event) => {
        cb(event.data);
      });
    },
    // A utility process port has no close event. The process ends when the main process kills it.
    onClose() {},
  };
}

export function processSendTransport(proc: ForkedProcessLike): Transport {
  if (proc.send === undefined) {
    throw new Error('processSendTransport requires a forked child with an IPC channel');
  }
  return {
    send(msg) {
      proc.send?.(msg);
    },
    onMessage(cb) {
      proc.on('message', (raw) => {
        cb(raw);
      });
    },
    onClose(cb) {
      proc.on('disconnect', () => {
        cb();
      });
    },
  };
}

export function findParentPort(proc: object): ParentPortLike | undefined {
  const candidate: unknown = 'parentPort' in proc ? proc.parentPort : undefined;
  return isParentPortLike(candidate) ? candidate : undefined;
}

function isParentPortLike(value: unknown): value is ParentPortLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'on' in value &&
    typeof value.on === 'function' &&
    'postMessage' in value &&
    typeof value.postMessage === 'function'
  );
}
