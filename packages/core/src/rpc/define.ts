import type { z } from 'zod';

export interface RpcCall<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  readonly input: I;
  readonly output: O;
}

export type RpcContract = {
  readonly [namespace: string]: { readonly [call: string]: RpcCall };
};

export function defineCall<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
): RpcCall<I, O> {
  return { input, output };
}
