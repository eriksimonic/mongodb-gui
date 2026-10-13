import { randomUUID } from 'node:crypto';
import { AppErrorException, appError, rpcContract, type ReconfigPlan } from '@mongo-gui/core';
import {
  applyReconfig,
  freeze,
  getReplicaSetConfig,
  getReplicaSetStatus,
  getSelfHost,
  initiate,
  planReconfig,
  stepDown,
} from '@mongo-gui/mongo-adapter';
import { driverCall, entry, type Operation } from './operation';

const PLAN_TTL_MS = 10 * 60_000;
const MAX_PLANS = 20;
// The server's default secondary catch-up period, in seconds.
const DEFAULT_CATCH_UP_SECONDS = 10;

/** The client a replica set call runs against. */
type ReplicationClient = Parameters<typeof getReplicaSetStatus>[0];

export interface ReplicationDeps {
  getClient: (connectionId: string) => ReplicationClient;
}

export interface ReplicationService {
  /** The replication calls. Plans stay in this service, so each call sees the plans it made. */
  operations(): [string, Operation][];
  /** Drops every stored plan. Called when the renderer resets. */
  clear(): void;
}

interface StoredPlan {
  readonly connectionId: string;
  readonly plan: ReconfigPlan;
  readonly expiresAt: number;
}

export interface ReplicationPlans {
  /** Keeps a plan made for a connection and returns its id. */
  store(connectionId: string, plan: ReconfigPlan): string;
  /**
   * Returns the plan and removes it, so a plan applies at most once. Refuses a plan that is
   * unknown, expired, made for another connection, or made from another configuration version.
   */
  take(connectionId: string, planId: string, expectedVersion: number): ReconfigPlan;
  /** Drops every plan. Runs when the renderer resets, so a page never applies a plan it made. */
  clear(): void;
}

/**
 * Plans live in the main process. The renderer gets the plan for display and sends back only its
 * id, so it cannot apply a configuration the planner did not produce.
 */
export function createReplicationPlans(now: () => number = Date.now): ReplicationPlans {
  const plans = new Map<string, StoredPlan>();

  function prune(): void {
    const current = now();
    for (const [id, stored] of plans) {
      if (stored.expiresAt <= current) {
        plans.delete(id);
      }
    }
    // Drops the oldest plans first when the cap is reached. Map keeps insertion order.
    while (plans.size >= MAX_PLANS) {
      const oldest = plans.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      plans.delete(oldest);
    }
  }

  return {
    store(connectionId, plan) {
      prune();
      const planId = randomUUID();
      plans.set(planId, { connectionId, plan, expiresAt: now() + PLAN_TTL_MS });
      return planId;
    },
    clear() {
      plans.clear();
    },
    take(connectionId, planId, expectedVersion) {
      const stored = plans.get(planId);
      plans.delete(planId);
      if (
        stored === undefined ||
        stored.expiresAt <= now() ||
        stored.connectionId !== connectionId
      ) {
        throw new AppErrorException(
          appError('VALIDATION', 'The plan is no longer available. Plan the change again.'),
        );
      }
      if (stored.plan.current.version !== expectedVersion) {
        throw new AppErrorException(
          appError(
            'VALIDATION',
            `The plan was made for configuration version ${stored.plan.current.version}, not ${expectedVersion}. Plan the change again.`,
          ),
        );
      }
      return stored.plan;
    },
  };
}

/** Replication calls. Each one runs against the connection's client. */
export function createReplicationService(deps: ReplicationDeps): ReplicationService {
  const plans = createReplicationPlans();
  return {
    clear: () => plans.clear(),
    operations: () => [
      entry('replication.getStatus', rpcContract.replication.getStatus, (input) =>
        driverCall(() => getReplicaSetStatus(deps.getClient(input.connectionId))),
      ),
      entry('replication.getConfig', rpcContract.replication.getConfig, (input) =>
        driverCall(() => getReplicaSetConfig(deps.getClient(input.connectionId))),
      ),
      entry('replication.selfHost', rpcContract.replication.selfHost, (input) =>
        driverCall(async () => ({
          host: (await getSelfHost(deps.getClient(input.connectionId))) ?? null,
        })),
      ),
      entry('replication.planReconfig', rpcContract.replication.planReconfig, (input) =>
        driverCall(async () => {
          const client = deps.getClient(input.connectionId);
          const status = await getReplicaSetStatus(client);
          const config = await getReplicaSetConfig(client);
          const plan = planReconfig(config, input.change, status);
          return { planId: plans.store(input.connectionId, plan), plan };
        }),
      ),
      entry('replication.applyReconfig', rpcContract.replication.applyReconfig, (input) =>
        driverCall(async () => {
          const plan = plans.take(input.connectionId, input.planId, input.expectedVersion);
          await applyReconfig(deps.getClient(input.connectionId), plan);
        }),
      ),
      entry('replication.stepDown', rpcContract.replication.stepDown, (input) =>
        driverCall(async () => ({
          // The server needs the step-down longer than the catch-up period. The UI's minimum leaves
          // room for the default 10 seconds of catch-up.
          primary: await stepDown(deps.getClient(input.connectionId), {
            stepDownSeconds: input.stepDownSeconds,
            secondaryCatchUpSeconds: Math.min(DEFAULT_CATCH_UP_SECONDS, input.stepDownSeconds - 1),
          }),
        })),
      ),
      entry('replication.freeze', rpcContract.replication.freeze, (input) =>
        driverCall(() => freeze(deps.getClient(input.connectionId), input.seconds)),
      ),
      entry('replication.initiate', rpcContract.replication.initiate, (input) =>
        driverCall(() =>
          initiate(deps.getClient(input.connectionId), {
            setName: input.setName,
            members: input.members,
          }),
        ),
      ),
    ],
  };
}
