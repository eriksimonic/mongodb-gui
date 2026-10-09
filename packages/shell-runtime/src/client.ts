import { randomUUID } from 'node:crypto';
import {
  appError,
  PROCESS_MESSAGE_ID,
  ShellResponseSchema,
  type AppError,
  type ShellRequest,
  type ShellResponse,
} from '@mongo-gui/core';

// The parts of a Node ChildProcess the client uses. A fork of the built runtime satisfies it.
export interface ShellChild {
  send(message: unknown): unknown;
  kill(): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export type ForkFunction = () => ShellChild;

type Result = IteratorResult<ShellResponse, undefined>;

// Responses for one request id, buffered until the consumer reads them.
class ResponseQueue {
  private readonly items: ShellResponse[] = [];
  private waiter: ((result: Result) => void) | null = null;
  private closed = false;

  push(message: ShellResponse): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiter;
    if (waiter === null) {
      this.items.push(message);
      return;
    }
    this.waiter = null;
    waiter({ value: message, done: false });
  }

  close(): void {
    this.closed = true;
    const waiter = this.waiter;
    if (waiter !== null && this.items.length === 0) {
      this.waiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  iterable(): AsyncIterable<ShellResponse> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this.next(),
      }),
    };
  }

  private next(): Promise<Result> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ value: item, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

// Parent side of the shell runtime protocol. It owns one child process and routes each response
// to the request that has the same id.
export class ShellProcessClient {
  private child: ShellChild | null = null;
  private readonly pending = new Map<string, ResponseQueue>();
  private readyWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private ready = false;
  private terminated = false;
  private processError: AppError | undefined;

  // Starts the child and resolves once it reports ready. Rejects if it exits first.
  spawn(fork: ForkFunction): Promise<void> {
    if (this.child !== null || this.terminated) {
      return Promise.reject(new Error('the client already owns a child process'));
    }
    const child = fork();
    this.child = child;
    child.on('message', (raw) => {
      this.route(raw);
    });
    child.on('exit', () => {
      this.terminate('The shell process exited');
    });
    child.on('error', () => {
      this.terminate('The shell process failed');
    });
    // The IPC channel can close before the process exits. Pending requests end either way.
    child.on('disconnect', () => {
      this.terminate('The shell process disconnected');
    });
    child.on('close', () => {
      this.terminate('The shell process closed');
    });
    return new Promise<void>((resolve, reject) => {
      if (this.ready) {
        resolve();
        return;
      }
      this.readyWaiter = { resolve, reject };
    });
  }

  // Sends a request and yields each response with its id, including the final done. The iterable
  // ends after done. A request sent to a process that is not running yields an error and done.
  request(request: ShellRequest): AsyncIterable<ShellResponse> {
    const queue = new ResponseQueue();
    const child = this.child;
    if (child === null || this.pending.has(request.id)) {
      const reason =
        child === null ? 'The shell process is not running' : 'The request id is already in use';
      failQueue(queue, request.id, appError('INTERNAL', reason));
      return queue.iterable();
    }
    this.pending.set(request.id, queue);
    child.send(request);
    return queue.iterable();
  }

  // Asks the runtime to cancel the request with targetId and waits for the cancel to finish.
  async cancel(targetId: string): Promise<void> {
    const cancel = this.request({ id: `cancel-${randomUUID()}`, kind: 'cancel', targetId });
    for await (const message of cancel) {
      void message;
    }
  }

  // Kills the child. Pending requests end with an error.
  dispose(): void {
    const child = this.child;
    this.terminate('The shell process was disposed');
    child?.kill();
  }

  private route(raw: unknown): void {
    const parsed = ShellResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.id === PROCESS_MESSAGE_ID) {
      this.routeProcessMessage(message);
      return;
    }
    const queue = this.pending.get(message.id);
    if (queue === undefined) {
      return;
    }
    queue.push(message);
    if (message.kind === 'done') {
      queue.close();
      this.pending.delete(message.id);
    }
  }

  private routeProcessMessage(message: ShellResponse): void {
    if (message.kind === 'ready') {
      this.ready = true;
      const waiter = this.readyWaiter;
      this.readyWaiter = null;
      waiter?.resolve();
    } else if (message.kind === 'error') {
      this.processError = message.error;
    }
  }

  private terminate(reason: string): void {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.child = null;
    const waiter = this.readyWaiter;
    this.readyWaiter = null;
    waiter?.reject(new Error(reason));
    const detail = this.processError?.message ?? reason;
    for (const [id, queue] of this.pending) {
      failQueue(queue, id, appError('INTERNAL', detail));
    }
    this.pending.clear();
  }
}

function failQueue(queue: ResponseQueue, id: string, error: AppError): void {
  queue.push({ id, kind: 'error', error });
  queue.push({ id, kind: 'done' });
  queue.close();
}
