import type { z } from 'zod';
import type { RpcCall } from './define';
import type { rpcContract } from './contract';

type ContractShape = typeof rpcContract;

type ClientMethod<C> =
  C extends RpcCall<infer I extends z.ZodType, infer O extends z.ZodType>
    ? (input: z.input<I>) => Promise<z.output<O>>
    : never;

export type RpcClient = {
  readonly [N in keyof ContractShape]: {
    readonly [K in keyof ContractShape[N]]: ClientMethod<ContractShape[N][K]>;
  };
};
