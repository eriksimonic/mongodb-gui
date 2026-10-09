import { describe, expect, it, vi } from 'vitest';
import { AppErrorException, type AppError } from '../domain/errors';
import { createEventSource, createRpcClient, type PreloadBridge, type RpcResult } from './bridge';

interface FakeBridge extends PreloadBridge {
  readonly invoke: ReturnType<typeof vi.fn<(method: string, input: unknown) => Promise<RpcResult>>>;
  emit(event: unknown): void;
}

function fakeBridge(result: RpcResult | (() => Promise<RpcResult>)): FakeBridge {
  const listeners = new Set<(event: unknown) => void>();
  const invoke = vi.fn<(method: string, input: unknown) => Promise<RpcResult>>(() =>
    typeof result === 'function' ? result() : Promise.resolve(result),
  );
  return {
    invoke,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

const CONNECTION_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';

describe('createRpcClient', () => {
  it('sends the namespaced method and returns the validated value', async () => {
    const bridge = fakeBridge({ ok: true, value: { state: 'uninitialised' } });
    const client = createRpcClient(bridge);

    await expect(client.vault.status(undefined)).resolves.toEqual({ state: 'uninitialised' });
    expect(bridge.invoke).toHaveBeenCalledWith('vault.status', undefined);
  });

  it('passes the input through for calls that take one', async () => {
    const bridge = fakeBridge({ ok: true, value: undefined });
    const client = createRpcClient(bridge);

    await client.connections.disconnect({ id: CONNECTION_ID });
    expect(bridge.invoke).toHaveBeenCalledWith('connections.disconnect', { id: CONNECTION_ID });
  });

  it('throws AppErrorException carrying the error from an ok false result', async () => {
    const error: AppError = { code: 'VAULT_LOCKED', message: 'The vault is locked.' };
    const client = createRpcClient(fakeBridge({ ok: false, error }));

    const failure = await client.vault.lock(undefined).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(AppErrorException);
    expect(failure).toHaveProperty('error', error);
  });

  it('throws INTERNAL with the method name when the value fails the output schema', async () => {
    const client = createRpcClient(fakeBridge({ ok: true, value: { state: 'exploded' } }));

    const failure = await client.vault.status(undefined).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(AppErrorException);
    expect(failure).toHaveProperty('error', {
      code: 'INTERNAL',
      message: 'The response did not match the expected shape.',
      detail: 'vault.status',
    });
  });

  it('throws INTERNAL when the bridge result is not an RpcResult', async () => {
    const client = createRpcClient(fakeBridge({ ok: 'yes' } as unknown as RpcResult));

    const failure = await client.vault.status(undefined).catch((caught: unknown) => caught);
    expect(failure).toHaveProperty('error.code', 'INTERNAL');
  });

  it('throws INTERNAL when the bridge invoke rejects', async () => {
    const client = createRpcClient(fakeBridge(() => Promise.reject(new Error('ipc closed'))));

    const failure = await client.vault.status(undefined).catch((caught: unknown) => caught);
    expect(failure).toHaveProperty('error', {
      code: 'INTERNAL',
      message: 'The bridge call failed.',
      detail: 'vault.status',
    });
  });
});

describe('createEventSource', () => {
  it('forwards valid events and drops invalid ones', () => {
    const bridge = fakeBridge({ ok: true, value: undefined });
    const subscribe = createEventSource(bridge);
    const received: unknown[] = [];
    subscribe((event) => received.push(event));

    bridge.emit({ type: 'vault:locked' });
    bridge.emit({ type: 'vault:opened' });
    bridge.emit('not an event');

    expect(received).toEqual([{ type: 'vault:locked' }]);
  });

  it('stops forwarding after the returned unsubscribe runs', () => {
    const bridge = fakeBridge({ ok: true, value: undefined });
    const subscribe = createEventSource(bridge);
    const received: unknown[] = [];
    const unsubscribe = subscribe((event) => received.push(event));

    unsubscribe();
    bridge.emit({ type: 'vault:locked' });

    expect(received).toEqual([]);
  });
});
