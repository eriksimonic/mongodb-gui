import { rpcContract, type RpcEvent } from '@mongo-gui/core';
import {
  addShardToZone,
  clearBalancerWindow,
  describeShardCollection,
  enableSharding,
  getShardDistribution,
  getShardingOverview,
  moveChunk,
  removeShardFromZone,
  removeShardStatus,
  setBalancerWindow,
  shardCollection,
  startBalancer,
  stopBalancer,
  updateZoneKeyRange,
} from '@mongo-gui/mongo-adapter';
import { connectionCalls, driverCall, entry, type Operation } from './operation';

/** The client a sharding call runs against. */
type ShardingClient = Parameters<typeof getShardingOverview>[0];

export interface ShardingDeps {
  getClient: (connectionId: string) => ShardingClient;
  emit: (event: RpcEvent) => void;
}

/**
 * Sharding calls. Each one runs against the connection's mongos. The adapter validates the
 * input and the server refuses what it must. Enabling sharding and sharding a collection
 * report a catalog change, so the tree refreshes. Balancer and zone calls change server
 * settings but not the database or collection tree, so they report no catalog change.
 */
export function shardingOperations(deps: ShardingDeps): [string, Operation][] {
  const { managed, readOnly } = connectionCalls(deps.getClient, deps.emit);
  const s = rpcContract.sharding;
  return [
    readOnly('sharding.overview', s.overview, (client) => getShardingOverview(client)),
    readOnly('sharding.collectionDistribution', s.collectionDistribution, (client, input) =>
      getShardDistribution(client, input.namespace),
    ),
    readOnly('sharding.setBalancer', s.setBalancer, (client, input) =>
      input.enabled ? startBalancer(client) : stopBalancer(client),
    ),
    readOnly('sharding.setBalancerWindow', s.setBalancerWindow, (client, input) =>
      setBalancerWindow(client, input),
    ),
    readOnly('sharding.clearBalancerWindow', s.clearBalancerWindow, (client) =>
      clearBalancerWindow(client),
    ),
    managed(
      'sharding.enableSharding',
      s.enableSharding,
      (client, input) => enableSharding(client, input),
      (input) => ({ database: input.database }),
    ),
    entry('sharding.shardCollection', s.shardCollection, (input) =>
      driverCall(async () => {
        const client = deps.getClient(input.connectionId);
        const summary = await describeShardCollection(client, input);
        if (!input.confirmed) {
          return { applied: false, summary };
        }
        await shardCollection(client, input);
        deps.emit({
          type: 'catalog:changed',
          connectionId: input.connectionId,
          database: input.database,
          collection: input.collection,
        });
        return { applied: true, summary };
      }),
    ),
    readOnly('sharding.moveChunk', s.moveChunk, (client, input) => moveChunk(client, input)),
    readOnly('sharding.addShardToZone', s.addShardToZone, (client, input) =>
      addShardToZone(client, input),
    ),
    readOnly('sharding.removeShardFromZone', s.removeShardFromZone, (client, input) =>
      removeShardFromZone(client, input),
    ),
    readOnly('sharding.updateZoneKeyRange', s.updateZoneKeyRange, (client, input) =>
      updateZoneKeyRange(client, input),
    ),
    readOnly('sharding.removeShard', s.removeShard, (client, input) =>
      removeShardStatus(client, input),
    ),
  ];
}
