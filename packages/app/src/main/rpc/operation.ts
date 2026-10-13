import { AppErrorException, type CallInput, type RpcCall, type RpcEvent } from '@mongo-gui/core';
import { mapDriverError } from '@mongo-gui/mongo-adapter';

export interface Operation {
  readonly call: RpcCall;
  run(input: unknown): Promise<unknown>;
}

export function entry<C extends RpcCall>(
  method: string,
  call: C,
  run: (input: CallInput<C>) => unknown,
): [string, Operation] {
  return [
    method,
    {
      call,
      // The router parses the input with this call's schema before it calls run.
      run: async (input) => run(input as CallInput<C>),
    },
  ];
}

/** Runs a driver call. Driver failures become AppErrors. AppErrors pass through unchanged. */
export async function driverCall<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AppErrorException) {
      throw error;
    }
    throw new AppErrorException(mapDriverError(error));
  }
}

/** Every connection-scoped input names the connection it runs against. */
interface ConnectionScoped {
  readonly connectionId: string;
}

/** The part of the catalog a mutation touched. Sent with catalog:changed. */
export type CatalogScope = Omit<
  Extract<RpcEvent, { type: 'catalog:changed' }>,
  'type' | 'connectionId'
>;

/**
 * Builds the two kinds of call that run against a connection's client: `managed` changes the
 * server and, after success, tells the UI which database or collection changed. `readOnly` reports
 * no change.
 */
export function connectionCalls<Client>(
  getClient: (connectionId: string) => Client,
  emit: (event: RpcEvent) => void,
) {
  function managed<C extends RpcCall>(
    method: string,
    call: C,
    run: (client: Client, input: CallInput<C>) => Promise<unknown>,
    scope: (input: CallInput<C>) => CatalogScope,
  ): [string, Operation] {
    return entry(method, call, async (input) => {
      const { connectionId } = input as ConnectionScoped;
      const value = await driverCall(() => run(getClient(connectionId), input));
      emit({ type: 'catalog:changed', connectionId, ...scope(input) });
      return value;
    });
  }

  function readOnly<C extends RpcCall>(
    method: string,
    call: C,
    run: (client: Client, input: CallInput<C>) => Promise<unknown>,
  ): [string, Operation] {
    return entry(method, call, (input) =>
      driverCall(() => run(getClient((input as ConnectionScoped).connectionId), input)),
    );
  }

  return { managed, readOnly };
}
