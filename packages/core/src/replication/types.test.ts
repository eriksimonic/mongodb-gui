import { describe, expect, it } from 'vitest';
import {
  AddMemberInputSchema,
  FreezeInputSchema,
  InitiateInputSchema,
  ReconfigChangeSchema,
  ReconfigPlanSchema,
  RemoveMemberInputSchema,
  ReplicaSetConfigSchema,
  ReplicaSetMemberPatchSchema,
  ReplicaSetStatusSchema,
  StepDownInputSchema,
  UpdateMemberInputSchema,
} from './types';

const member = {
  id: 0,
  host: 'mongo0:27017',
  priority: 1,
  votes: 1,
  hidden: false,
  arbiterOnly: false,
  buildIndexes: true,
  secondaryDelaySecs: 0,
  tags: {},
};

const config = {
  id: 'rs0',
  version: 1,
  members: [member],
  settingsEjson: '{}',
};

describe('ReplicaSetConfigSchema', () => {
  it('accepts a minimal configuration', () => {
    expect(ReplicaSetConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects a version of zero', () => {
    expect(ReplicaSetConfigSchema.safeParse({ ...config, version: 0 }).success).toBe(false);
  });

  it('rejects votes other than 0 or 1', () => {
    const members = [{ ...member, votes: 2 }];
    expect(ReplicaSetConfigSchema.safeParse({ ...config, members }).success).toBe(false);
  });

  it('rejects member ids above 255', () => {
    const members = [{ ...member, id: 256 }];
    expect(ReplicaSetConfigSchema.safeParse({ ...config, members }).success).toBe(false);
  });
});

describe('ReplicaSetStatusSchema', () => {
  const status = {
    setName: 'rs0',
    myState: 1,
    members: [
      {
        id: 0,
        name: 'mongo0:27017',
        state: 'PRIMARY',
        stateCode: 1,
        health: 1,
        self: true,
        priority: 1,
        votes: 1,
        hidden: false,
        arbiterOnly: false,
        buildIndexes: true,
        secondaryDelaySecs: 0,
        tags: {},
      },
    ],
  };

  it('accepts a primary without lag', () => {
    expect(ReplicaSetStatusSchema.safeParse(status).success).toBe(true);
  });

  it('rejects a negative lag', () => {
    const members = [{ ...status.members[0], lagSeconds: -1 }];
    expect(ReplicaSetStatusSchema.safeParse({ ...status, members }).success).toBe(false);
  });

  it('rejects an oplog window with a non-ISO timestamp', () => {
    const oplog = { firstTs: 'yesterday', lastTs: 'today', windowSeconds: 10 };
    expect(ReplicaSetStatusSchema.safeParse({ ...status, oplog }).success).toBe(false);
  });
});

describe('member inputs', () => {
  it('accepts an add with only a host', () => {
    expect(AddMemberInputSchema.safeParse({ host: 'mongo3:27017' }).success).toBe(true);
  });

  it('rejects an empty host and a host with a space', () => {
    expect(AddMemberInputSchema.safeParse({ host: '' }).success).toBe(false);
    expect(AddMemberInputSchema.safeParse({ host: 'mongo 3' }).success).toBe(false);
  });

  it('rejects votes of 2 and a negative delay', () => {
    expect(AddMemberInputSchema.safeParse({ host: 'a:1', votes: 2 }).success).toBe(false);
    expect(AddMemberInputSchema.safeParse({ host: 'a:1', secondaryDelaySecs: -1 }).success).toBe(
      false,
    );
  });

  it('rejects a priority above 1000', () => {
    expect(AddMemberInputSchema.safeParse({ host: 'a:1', priority: 1001 }).success).toBe(false);
  });

  it('accepts a remove by member id and rejects an id above 255', () => {
    expect(RemoveMemberInputSchema.safeParse({ memberId: 2 }).success).toBe(true);
    expect(RemoveMemberInputSchema.safeParse({ memberId: 256 }).success).toBe(false);
  });

  it('accepts an update patch that repeats the host', () => {
    const result = UpdateMemberInputSchema.safeParse({
      memberId: 1,
      patch: { host: 'mongo1:27017', priority: 0, votes: 0 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a patch with tags and rejects empty tag values as non-strings', () => {
    expect(ReplicaSetMemberPatchSchema.safeParse({ tags: { dc: 'east' } }).success).toBe(true);
    expect(ReplicaSetMemberPatchSchema.safeParse({ tags: { dc: 1 } }).success).toBe(false);
  });

  it('discriminates the reconfig change kinds', () => {
    expect(ReconfigChangeSchema.safeParse({ kind: 'add', member: { host: 'a:1' } }).success).toBe(
      true,
    );
    expect(ReconfigChangeSchema.safeParse({ kind: 'remove', memberId: 1 }).success).toBe(true);
    expect(ReconfigChangeSchema.safeParse({ kind: 'update', memberId: 1, patch: {} }).success).toBe(
      true,
    );
    expect(ReconfigChangeSchema.safeParse({ kind: 'rename', memberId: 1 }).success).toBe(false);
  });
});

describe('StepDownInputSchema', () => {
  it('defaults stepDownSeconds to 60', () => {
    const parsed = StepDownInputSchema.parse({});
    expect(parsed.stepDownSeconds).toBe(60);
  });

  it('rejects a connectionId', () => {
    expect(StepDownInputSchema.safeParse({ connectionId: 'abc' }).success).toBe(false);
  });

  it('rejects a negative step-down period', () => {
    expect(StepDownInputSchema.safeParse({ stepDownSeconds: -1 }).success).toBe(false);
  });
});

describe('FreezeInputSchema', () => {
  it('accepts zero, which unfreezes a member', () => {
    expect(FreezeInputSchema.safeParse({ seconds: 0 }).success).toBe(true);
  });

  it('rejects fractional seconds', () => {
    expect(FreezeInputSchema.safeParse({ seconds: 1.5 }).success).toBe(false);
  });
});

describe('InitiateInputSchema', () => {
  it('accepts one member', () => {
    const result = InitiateInputSchema.safeParse({
      setName: 'rs0',
      members: [{ host: 'localhost:27017' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty member list', () => {
    expect(InitiateInputSchema.safeParse({ setName: 'rs0', members: [] }).success).toBe(false);
  });

  it('rejects duplicate hosts', () => {
    const members = [{ host: 'a:1' }, { host: 'a:1' }];
    expect(InitiateInputSchema.safeParse({ setName: 'rs0', members }).success).toBe(false);
  });
});

describe('ReconfigPlanSchema', () => {
  it('accepts a refused plan with its reason', () => {
    const result = ReconfigPlanSchema.safeParse({
      current: config,
      next: config,
      changes: [],
      warnings: [],
      refused: 'The primary cannot be removed.',
    });
    expect(result.success).toBe(true);
  });
});
