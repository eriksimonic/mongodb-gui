import { describe, expect, it } from 'vitest';
import { AppErrorException, type ReconfigPlan, type ReplicaSetConfig } from '@mongo-gui/core';
import { createReplicationPlans } from './replication-plans';

const CONNECTION = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const OTHER = '7d1e9f04-2b3c-4d5e-8f60-a1b2c3d4e5f6';

function planAt(version: number): ReconfigPlan {
  const config: ReplicaSetConfig = {
    id: 'rs0',
    version,
    members: [],
    settingsEjson: '{}',
    extraEjson: '{}',
  };
  return {
    current: config,
    next: { ...config, version: version + 1 },
    changes: ['x'],
    warnings: [],
  };
}

function refusalOf(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof AppErrorException ? error.error.message : 'not an AppError';
  }
}

describe('replication plans', () => {
  it('applies a stored plan once', () => {
    const plans = createReplicationPlans(() => 0);
    const planId = plans.store(CONNECTION, planAt(4));
    expect(plans.take(CONNECTION, planId, 4).current.version).toBe(4);
    expect(refusalOf(() => plans.take(CONNECTION, planId, 4))).toMatch(/no longer available/);
  });

  it('consumes a plan that another connection tries to apply', () => {
    const plans = createReplicationPlans(() => 0);
    const planId = plans.store(CONNECTION, planAt(4));
    expect(refusalOf(() => plans.take(OTHER, planId, 4))).toMatch(/no longer available/);
    expect(refusalOf(() => plans.take(CONNECTION, planId, 4))).toMatch(/no longer available/);
  });

  it('refuses a plan made from another configuration version', () => {
    const plans = createReplicationPlans(() => 0);
    const planId = plans.store(CONNECTION, planAt(4));
    expect(refusalOf(() => plans.take(CONNECTION, planId, 5))).toMatch(/version 4, not 5/);
  });

  it('expires a plan after ten minutes', () => {
    let clock = 0;
    const plans = createReplicationPlans(() => clock);
    const planId = plans.store(CONNECTION, planAt(4));
    clock = 10 * 60_000;
    expect(refusalOf(() => plans.take(CONNECTION, planId, 4))).toMatch(/no longer available/);
  });
});
