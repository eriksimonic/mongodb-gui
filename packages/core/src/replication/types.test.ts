import { describe, expect, it } from 'vitest';
import {
  AddMemberInputSchema,
  FreezeInputSchema,
  InitiateInputSchema,
  ReconfigChangeSchema,
  ReconfigPlanSchema,
  RemoveMemberInputSchema,
  ReplicaSetConfigSchema,
  ReplicaSetMemberConfigSchema,
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
  extraEjson: '{}',
};

const config = {
  id: 'rs0',
  version: 1,
  members: [member],
  settingsEjson: '{}',
  extraEjson: '{}',
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

  it('accepts host:port and a bracketed IPv6 address with a port', () => {
    for (const host of [
      'db4.example.net:27017',
      'localhost:27018',
      '10.0.0.5:1',
      '[::1]:27017',
      '[2001:db8::7334]:65535',
      '[::ffff:10.0.0.5]:27017',
    ]) {
      expect(AddMemberInputSchema.safeParse({ host }).success, host).toBe(true);
    }
  });

  it('refuses credentials, an options query, a path and a space', () => {
    for (const host of [
      'user:pass@db4:27017',
      'db4:27017?authSource=admin',
      'db4:27017/admin',
      'db 4:27017',
      'db4:27017 ',
    ]) {
      expect(AddMemberInputSchema.safeParse({ host }).success, host).toBe(false);
    }
  });

  it('refuses a second colon outside brackets and an IPv6 address without brackets', () => {
    for (const host of ['db4:27017:1', '::1:27017', '2001:db8::1:27017', 'db4:']) {
      expect(AddMemberInputSchema.safeParse({ host }).success, host).toBe(false);
    }
  });

  it('refuses a missing port and a port outside 1 to 65535', () => {
    for (const host of ['db4', 'db4:0', 'db4:65536', 'db4:port', '[::1]', '[::1]:0']) {
      expect(AddMemberInputSchema.safeParse({ host }).success, host).toBe(false);
    }
  });

  it('refuses a hostname with characters other than letters, digits, dots and hyphens', () => {
    for (const host of ['db_4:27017', 'db4..net:27017', '.db4:27017', 'db4$:27017']) {
      expect(AddMemberInputSchema.safeParse({ host }).success, host).toBe(false);
    }
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

describe('host schemas for server reads and user input', () => {
  const longName = `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(61)}`;

  it('reads a member host the server names, such as a Docker Compose name with an underscore', () => {
    const parsed = ReplicaSetConfigSchema.safeParse({
      id: 'rs0',
      version: 1,
      members: [
        {
          id: 0,
          host: 'mongo_1:27017',
          priority: 1,
          votes: 1,
          hidden: false,
          arbiterOnly: false,
          buildIndexes: true,
          secondaryDelaySecs: 0,
          tags: {},
          extraEjson: '{}',
        },
      ],
      settingsEjson: '{}',
      extraEjson: '{}',
    });
    expect(parsed.success).toBe(true);
  });

  it('still refuses a server-read host that carries credentials or a query', () => {
    expect(ReplicaSetMemberConfigSchema.safeParse({ ...member, host: 'u:p@h:1' }).success).toBe(
      false,
    );
    expect(ReplicaSetMemberConfigSchema.safeParse({ ...member, host: 'h:1?x=1' }).success).toBe(
      false,
    );
  });

  it('refuses an input host with an underscore, which the hostname rule does not allow', () => {
    expect(AddMemberInputSchema.safeParse({ host: 'mongo_1:27017' }).success).toBe(false);
  });

  it('accepts a hostname of 253 characters and refuses 254', () => {
    expect(AddMemberInputSchema.safeParse({ host: `${longName}:27017` }).success).toBe(true);
    expect(AddMemberInputSchema.safeParse({ host: `${longName}a:27017` }).success).toBe(false);
  });

  it('refuses labels that start or end with a hyphen, and a lone hyphen', () => {
    for (const host of ['-:1', 'a-.example:1', '-a.example:1', 'a.-b:1']) {
      expect(AddMemberInputSchema.safeParse({ host }).success, host).toBe(false);
    }
  });

  it('refuses an IPv6 address without a hex digit or without two colons', () => {
    for (const host of ['[:]:1', '[::]:1', '[1]:1']) {
      expect(AddMemberInputSchema.safeParse({ host }).success, host).toBe(false);
    }
  });

  it('refuses a port with leading zeros', () => {
    for (const host of ['h:00001', 'h:027017', 'h:01']) {
      expect(AddMemberInputSchema.safeParse({ host }).success, host).toBe(false);
    }
    expect(AddMemberInputSchema.safeParse({ host: 'h:1' }).success).toBe(true);
  });
});
