import { AppErrorException, appError, rpcContract } from '@mongo-gui/core';
import { SpillError } from '@mongo-gui/storage/spill';
import type { ForkFunction } from '../shell/child';
import type { RuntimeSupervisor } from '../shell/supervisor';
import type { SpillRoot } from '../spill/spill-root';
import { entry, type Operation } from './operation';

/** The subset of RuntimeSupervisor that the router uses. The real class satisfies it. */
export type ShellRegistry = Pick<
  RuntimeSupervisor,
  | 'evaluate'
  | 'next'
  | 'cancel'
  | 'complete'
  | 'sampleSchema'
  | 'restart'
  | 'state'
  | 'stop'
  | 'stopAll'
  | 'onEvent'
>;

export interface ShellServiceDeps {
  /** One runtime process per connection. Without it every shell call fails with INTERNAL. */
  readonly shell?: ShellRegistry;
  /** Where the shell's encrypted spill files are read and freed. Without it a spilled document is not found. */
  readonly spill?: Pick<SpillRoot, 'read' | 'release'>;
  /** Whether the connection is open. A shell call on any other connection is refused. */
  readonly isConnected: (connectionId: string) => boolean;
}

export interface ShellService {
  operations(): [string, Operation][];
  /** Runs an action on the connection's runtime. Schema sampling and explain share it. */
  shellCall<T>(connectionId: string, action: (shell: ShellRegistry) => Promise<T>): Promise<T>;
}

export const refuseFork: ForkFunction = () => {
  throw new Error('no shell runtime is configured');
};

export function createShellService(deps: ShellServiceDeps): ShellService {
  /**
   * Runs a shell call for an open connection. A connection that is not open is refused before
   * any runtime process starts.
   */
  async function shellCall<T>(
    connectionId: string,
    action: (shell: ShellRegistry) => Promise<T>,
  ): Promise<T> {
    const shell = deps.shell;
    if (shell === undefined) {
      throw new AppErrorException(appError('INTERNAL', 'The shell is not available.'));
    }
    if (!deps.isConnected(connectionId)) {
      throw new AppErrorException(appError('NOT_CONNECTED', 'Connect to the server first.'));
    }
    return action(shell);
  }

  return {
    operations: () => [
      entry('shell.evaluate', rpcContract.shell.evaluate, (input) =>
        shellCall(input.connectionId, (shell) => shell.evaluate(input)),
      ),
      entry('shell.next', rpcContract.shell.next, (input) =>
        shellCall(input.connectionId, (shell) => shell.next(input)),
      ),
      entry('shell.readDocument', rpcContract.shell.readDocument, (input) => {
        try {
          if (deps.spill !== undefined) {
            return deps.spill.read(input.ref);
          }
        } catch (error) {
          if (!(error instanceof SpillError)) {
            throw error;
          }
        }
        throw new AppErrorException(
          appError('NOT_FOUND', 'The full document is no longer available. Run the query again.'),
        );
      }),
      entry('shell.releaseResult', rpcContract.shell.releaseResult, (input) => {
        deps.spill?.release(input.requestId);
      }),
      entry('shell.cancel', rpcContract.shell.cancel, async (input) => {
        // Nothing runs on a connection that is not open, so cancel needs no connection check.
        await deps.shell?.cancel(input.connectionId, input.requestId);
      }),
      entry('shell.complete', rpcContract.shell.complete, (input) =>
        shellCall(input.connectionId, (shell) => shell.complete(input)),
      ),
      entry('shell.sampleSchema', rpcContract.shell.sampleSchema, (input) =>
        shellCall(input.connectionId, (shell) => shell.sampleSchema(input)),
      ),
      entry('shell.restart', rpcContract.shell.restart, (input) =>
        shellCall(input.connectionId, (shell) => shell.restart(input.connectionId)),
      ),
      entry('shell.state', rpcContract.shell.state, (input) => ({
        state: deps.shell?.state(input.connectionId) ?? 'stopped',
      })),
    ],
    shellCall,
  };
}
