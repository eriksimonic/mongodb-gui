import { rpcContract, type CopyOptions, type RpcEvent } from '@mongo-gui/core';
import { entry, type Operation } from './operation';

/** The copy job service the copy calls use. The router builds it. */
export interface CopyService {
  /** Starts a copy job and returns its id. */
  start(options: CopyOptions): Promise<string>;
  /** Stops a job. An unknown id does nothing. */
  cancel(jobId: string): void;
}

/** What the router gives the copy service: its event sink. */
export interface CopyWiring {
  readonly emit: (event: RpcEvent) => void;
}

export interface CopyOperationDeps {
  /** The copy service. Throws INTERNAL when the router was built without one. */
  readonly copy: () => CopyService;
  /** Checks that a connection profile exists. */
  readonly requireConnectionProfile: (connectionId: string) => void;
}

/** The copy calls. Each job reports through copy:progress events. */
export function copyOperations(deps: CopyOperationDeps): [string, Operation][] {
  return [
    entry('copy.start', rpcContract.copy.start, async (input) => {
      deps.requireConnectionProfile(input.sourceConnectionId);
      deps.requireConnectionProfile(input.targetConnectionId);
      return { jobId: await deps.copy().start(input) };
    }),
    entry('copy.cancel', rpcContract.copy.cancel, (input) => {
      deps.copy().cancel(input.jobId);
    }),
  ];
}
