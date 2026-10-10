import type { ConnectionStatus } from '@mongo-gui/core';

export type ShardingAvailability =
  { readonly available: true } | { readonly available: false; readonly reason: string };

/** Sharding tools need a connected mongos. Anything else says why they are off. */
export function shardingAvailability(status: ConnectionStatus | undefined): ShardingAvailability {
  if (status?.state !== 'connected') {
    return { available: false, reason: 'Connect first' };
  }
  if (status.topology !== 'sharded') {
    return { available: false, reason: 'Not a sharded cluster' };
  }
  return { available: true };
}
