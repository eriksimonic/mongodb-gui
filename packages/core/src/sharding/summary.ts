import { appError, AppErrorException } from '../domain/errors';
import type { ShardCollectionSummary, ShardKey } from './types';

export interface ShardCollectionPlan {
  readonly database: string;
  readonly collection: string;
  readonly key: ShardKey;
  readonly unique?: boolean | undefined;
  readonly presplitHashedZones?: boolean | undefined;
  readonly numInitialChunks?: number | undefined;
}

/** Shows the key the way mongosh shows it: { customerId: "hashed", region: 1 }. */
export function shardKeyText(key: Readonly<Record<string, unknown>>): string {
  const fields = Object.entries(key).map(([field, value]) => {
    const shown = value === 'hashed' ? '"hashed"' : String(value);
    return `${field}: ${shown}`;
  });
  return `{ ${fields.join(', ')} }`;
}

/**
 * Describes what shardCollection will do, without touching the server. It refuses the rules
 * the server would refuse, so the dry run names the problem before any write.
 */
export function summarizeShardCollection(plan: ShardCollectionPlan): ShardCollectionSummary {
  const hashed = Object.values(plan.key).includes('hashed');
  const unique = plan.unique === true;
  const presplit = plan.presplitHashedZones === true;
  if (unique && hashed) {
    throw refusal('A hashed shard key cannot be unique. Choose a ranged key or drop unique.');
  }
  if (presplit && !hashed) {
    throw refusal('Presplitting zones applies only to a hashed shard key.');
  }
  if (plan.numInitialChunks !== undefined && !hashed) {
    throw refusal('The number of initial chunks applies only to a hashed shard key.');
  }
  const namespace = `${plan.database}.${plan.collection}`;
  const steps = [`Shards ${namespace} on the key ${shardKeyText(plan.key)}.`];
  if (hashed) {
    steps.push(
      'A hashed key spreads documents evenly across shards. Range queries on the key reach every shard.',
    );
  } else {
    steps.push(
      'A ranged key keeps nearby values together, so chunks can grow uneven as data arrives.',
    );
  }
  if (unique) {
    steps.push(
      'Every document must have a distinct key value, and MongoDB enforces it with a unique index.',
    );
  }
  if (presplit) {
    steps.push('Chunks are presplit for the zone ranges before data arrives.');
  }
  if (plan.numInitialChunks !== undefined) {
    steps.push(`MongoDB creates ${plan.numInitialChunks} initial chunks.`);
  }
  steps.push('The balancer moves chunks between shards in the background after sharding.');
  return {
    namespace,
    key: plan.key,
    keyText: shardKeyText(plan.key),
    unique,
    presplitHashedZones: presplit,
    ...(plan.numInitialChunks === undefined ? {} : { numInitialChunks: plan.numInitialChunks }),
    steps,
  };
}

function refusal(message: string): AppErrorException {
  return new AppErrorException(appError('VALIDATION', message));
}
