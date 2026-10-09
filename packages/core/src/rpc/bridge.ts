import { z } from 'zod';
import { AppErrorException, appError, type AppError } from '../domain/errors';
import { AppErrorSchema } from '../schemas/errors';
import { RpcEventSchema } from '../schemas/events';
import type { RpcEvent } from './events';
import type { RpcClient } from './client';
import { rpcContract } from './contract';
import type { RpcCall } from './define';

export const RpcResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: AppErrorSchema }),
]);

export type RpcResult = { ok: true; value: unknown } | { ok: false; error: AppError };

/** The parsed input type of a contract call. */
export type CallInput<C extends RpcCall> = z.output<C['input']>;

/** The object the preload script exposes as window.mongoGui. */
export interface PreloadBridge {
  invoke(method: string, input: unknown): Promise<RpcResult>;
  onEvent(listener: (event: unknown) => void): () => void;
}

/**
 * Builds a typed client over the bridge. Each call sends "<namespace>.<call>" and
 * validates the returned value with the call's output schema. Input is validated in main.
 */
export function createRpcClient(bridge: PreloadBridge): RpcClient {
  const client: Record<string, Record<string, (input: unknown) => Promise<unknown>>> = {};
  for (const [namespace, calls] of Object.entries(rpcContract)) {
    const group: Record<string, (input: unknown) => Promise<unknown>> = {};
    for (const [name, call] of Object.entries(calls)) {
      const method = `${namespace}.${name}`;
      group[name] = (input: unknown) => invokeCall(bridge, method, call, input);
    }
    client[namespace] = group;
  }
  // The runtime object has one function per contract call. The generic record above
  // cannot express the per-call input and output types, so the cast is confined here.
  return client as unknown as RpcClient;
}

async function invokeCall(
  bridge: PreloadBridge,
  method: string,
  call: RpcCall,
  input: unknown,
): Promise<unknown> {
  const result = await bridgeInvoke(bridge, method, input);
  if (!result.ok) {
    throw new AppErrorException(result.error);
  }
  const value = call.output.safeParse(result.value);
  if (!value.success) {
    throw new AppErrorException(
      appError('INTERNAL', 'The response did not match the expected shape.', method),
    );
  }
  return value.data;
}

async function bridgeInvoke(
  bridge: PreloadBridge,
  method: string,
  input: unknown,
): Promise<RpcResult> {
  let raw: unknown;
  try {
    raw = await bridge.invoke(method, input);
  } catch {
    throw new AppErrorException(appError('INTERNAL', 'The bridge call failed.', method));
  }
  const parsed = RpcResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppErrorException(
      appError('INTERNAL', 'The response was not a valid result.', method),
    );
  }
  return parsed.data;
}

/**
 * Subscribes a listener to main-process events. Events that fail RpcEventSchema are dropped.
 * Returns the unsubscribe function from the bridge.
 */
export function createEventSource(
  bridge: PreloadBridge,
): (listener: (event: RpcEvent) => void) => () => void {
  return (listener) =>
    bridge.onEvent((raw) => {
      const parsed = RpcEventSchema.safeParse(raw);
      if (parsed.success) {
        listener(parsed.data);
      }
    });
}
