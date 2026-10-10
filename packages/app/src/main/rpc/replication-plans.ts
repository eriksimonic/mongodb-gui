import { randomUUID } from 'node:crypto';
import { AppErrorException, appError, type ReconfigPlan } from '@mongo-gui/core';

const PLAN_TTL_MS = 10 * 60_000;
const MAX_PLANS = 20;

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
