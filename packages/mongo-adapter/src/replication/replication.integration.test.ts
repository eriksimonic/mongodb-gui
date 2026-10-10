import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppErrorException, ReplicaSetStatusSchema, type ReplicaSetStatus } from '@mongo-gui/core';
import { CONTAINER_STARTUP_TIMEOUT_MS } from '../test/mongo-container';
import {
  connectTo,
  DEFAULT_WAIT_MS,
  startMongoNode,
  startReplicaSet,
  waitUntil,
  withClient,
  type MongoNode,
  type ReplicaSetHarness,
} from '../test/replica-set';
import { addMember, applyReconfig, planReconfig, removeMember, updateMember } from './reconfig';
import { freeze, initiate, stepDown } from './operations';
import { getReplicaSetConfig, getReplicaSetStatus, isReplicaSet } from './status';

const IMAGES = ['mongo:8.0.17', 'mongo:6.0'] as const;
const SUITE_TIMEOUT_MS = CONTAINER_STARTUP_TIMEOUT_MS * 2;
const TEST_TIMEOUT_MS = 90_000;
const NEW_MEMBER_TIMEOUT_MS = 60_000;
const STEP_DOWN_TIMEOUT_MS = 30_000;

// Puts the server's detail into the failure message, so a failed run shows the cause.
function rethrowWithDetail(error: unknown): never {
  if (error instanceof AppErrorException) {
    throw new Error(`${error.message} (${error.error.detail ?? 'no detail'})`);
  }
  throw error;
}

// Reads the member states straight from the server, so the set-up does not depend on the adapter.
async function rawStates(uri: string): Promise<string[]> {
  return withClient(uri, async (client) => {
    const reply: unknown = await client.db('admin').command({ replSetGetStatus: 1 });
    const members =
      typeof reply === 'object' && reply !== null && 'members' in reply ? reply.members : [];
    return Array.isArray(members)
      ? members.map((member: unknown) =>
          typeof member === 'object' && member !== null && 'stateStr' in member
            ? String(member.stateStr)
            : '',
        )
      : [];
  });
}

// The tests share one set and run in order. Each test leaves the set healthy for the next one,
// except the majority test, which stops a voter and restarts it before the last removal.
describe.each(IMAGES)('replica set administration on %s', (image) => {
  let set: ReplicaSetHarness;
  let standalone: MongoNode;
  let single: MongoNode;
  let setClient: MongoClient;
  let standaloneClient: MongoClient;
  let singleClient: MongoClient;
  let demotedId: number | undefined;
  let addedNode: MongoNode | undefined;
  let addedId: number | undefined;

  // Runs fn with a client connected to whichever member is primary right now.
  async function withPrimary<T>(fn: (client: MongoClient) => Promise<T>): Promise<T> {
    const primary = await set.findPrimary();
    if (primary === undefined) {
      throw new Error('the set has no primary');
    }
    return withClient(primary.directUri, fn);
  }

  beforeAll(async () => {
    [set, standalone, single] = await Promise.all([
      startReplicaSet(image, 3),
      startMongoNode(image, { replSet: false }),
      startMongoNode(image, { replSet: true }),
    ]);
    const primary = await set.findPrimary();
    if (primary === undefined) {
      throw new Error('the set has no primary');
    }
    setClient = await connectTo(primary.directUri);
    standaloneClient = await connectTo(standalone.directUri);
    singleClient = await connectTo(single.directUri);
    await waitUntil(
      async () => {
        const states = await rawStates(primary.directUri);
        return states.filter((state) => state === 'SECONDARY').length === 2;
      },
      DEFAULT_WAIT_MS,
      'two secondaries',
    );
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await Promise.all(
        [setClient, standaloneClient, singleClient].map((client) => client?.close()),
      );
    } finally {
      await set?.stop();
      await standalone?.container.stop();
      await single?.container.stop();
    }
  }, SUITE_TIMEOUT_MS);

  it(
    'reports one primary, two secondaries with lag, and an oplog window',
    async () => {
      const status = await getReplicaSetStatus(setClient);
      expect(ReplicaSetStatusSchema.safeParse(status).success).toBe(true);
      expect(status.setName).toBe('rs0');
      expect(status.members).toHaveLength(3);
      expect(status.members.filter((member) => member.state === 'PRIMARY')).toHaveLength(1);
      expect(status.members.filter((member) => member.state === 'SECONDARY')).toHaveLength(2);
      expect(status.members.filter((member) => member.self)).toHaveLength(1);
      const primary = status.members.find((member) => member.state === 'PRIMARY');
      expect(status.primary).toBe(primary?.name);
      for (const member of status.members.filter((entry) => entry.state === 'SECONDARY')) {
        expect(typeof member.lagSeconds).toBe('number');
        expect(member.lagSeconds).toBeGreaterThanOrEqual(0);
      }
      expect(status.oplog?.windowSeconds).toBeGreaterThanOrEqual(0);
      expect(status.oplog?.sizeMb).toBeGreaterThan(0);
      expect(await isReplicaSet(setClient)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reads a configuration with three members at priority 1 and votes 1',
    async () => {
      const config = await getReplicaSetConfig(setClient);
      expect(config.id).toBe('rs0');
      expect(config.version).toBeGreaterThanOrEqual(1);
      expect(config.members).toHaveLength(3);
      for (const member of config.members) {
        expect(member).toMatchObject({ priority: 1, votes: 1, hidden: false, arbiterOnly: false });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'applies a planned update that sets priority 0 and votes 0 on a secondary',
    async () => {
      const status = await getReplicaSetStatus(setClient);
      const config = await getReplicaSetConfig(setClient);
      const target = status.members.find((member) => member.state === 'SECONDARY');
      if (target === undefined) {
        throw new Error('no secondary to demote');
      }
      demotedId = target.id;
      const plan = planReconfig(
        config,
        { kind: 'update', memberId: target.id, patch: { priority: 0, votes: 0 } },
        status,
      );
      expect(plan.refused).toBeUndefined();
      await applyReconfig(setClient, plan);
      const after = await getReplicaSetStatus(setClient);
      expect(after.members.find((member) => member.id === target.id)).toMatchObject({
        priority: 0,
        votes: 0,
      });
      expect((await getReplicaSetConfig(setClient)).version).toBe(config.version + 1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'adds a fourth member that reaches SECONDARY within 60 seconds',
    async () => {
      addedNode = await set.addNode('added');
      const node = addedNode;
      const plan = await addMember(setClient, { host: node.host }).catch(rethrowWithDetail);
      expect(plan.refused).toBeUndefined();
      addedId = plan.next.members.find((member) => member.host === node.host)?.id;
      expect(addedId).toBe(3);
      await waitUntil(
        async () => {
          const status = await getReplicaSetStatus(setClient);
          return status.members.some(
            (member) => member.name === node.host && member.state === 'SECONDARY',
          );
        },
        NEW_MEMBER_TIMEOUT_MS,
        'the added member to reach SECONDARY',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to remove the primary and leaves the configuration alone',
    async () => {
      const status = await getReplicaSetStatus(setClient);
      const primary = status.members.find((member) => member.state === 'PRIMARY');
      if (primary === undefined) {
        throw new Error('no primary');
      }
      const before = await getReplicaSetConfig(setClient);
      await expect(removeMember(setClient, { memberId: primary.id })).rejects.toThrow(
        'is the primary',
      );
      expect((await getReplicaSetConfig(setClient)).version).toBe(before.version);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'removes the demoted secondary',
    async () => {
      if (demotedId === undefined) {
        throw new Error('no demoted member from the earlier test');
      }
      const plan = await removeMember(setClient, { memberId: demotedId });
      expect(plan.refused).toBeUndefined();
      expect(plan.warnings).toEqual([]);
      const status = await getReplicaSetStatus(setClient);
      expect(status.members.map((member) => member.id)).not.toContain(demotedId);
      expect(status.members).toHaveLength(3);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'steps the primary down and elects another member within 30 seconds',
    async () => {
      const before = await getReplicaSetStatus(setClient);
      const oldPrimary = before.primary;
      const started = Date.now();
      const newPrimary = await stepDown(setClient, { stepDownSeconds: 60 });
      expect(Date.now() - started).toBeLessThan(STEP_DOWN_TIMEOUT_MS);
      expect(newPrimary).not.toBe(oldPrimary);
      // The client reconnects on the next call, so the status read succeeds on the same client.
      const after = await getReplicaSetStatus(setClient);
      expect(after.primary).toBe(newPrimary);
      expect(after.members.filter((member) => member.state === 'PRIMARY')).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'freezes the member the client is connected to, now a secondary',
    async () => {
      const status: ReplicaSetStatus = await getReplicaSetStatus(setClient);
      expect(status.members.find((member) => member.self)?.state).toBe('SECONDARY');
      await expect(freeze(setClient, 30)).resolves.toBeUndefined();
      await expect(freeze(setClient, 0)).resolves.toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'updates a member through the one-call wrapper',
    async () => {
      await withPrimary(async (client) => {
        const status = await getReplicaSetStatus(client);
        const target = status.members.find(
          (member) => member.state === 'SECONDARY' && member.health === 1,
        );
        if (target === undefined) {
          throw new Error('no healthy secondary');
        }
        const plan = await updateMember(client, {
          memberId: target.id,
          patch: { tags: { region: 'test' } },
        });
        expect(plan.refused).toBeUndefined();
        const after = await getReplicaSetStatus(client);
        expect(after.members.find((member) => member.id === target.id)?.tags).toEqual({
          region: 'test',
        });
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a removal that would leave the voters without a majority',
    async () => {
      // Stop one voting secondary, then try to remove the other voting secondary. Two voters
      // would remain, and only the primary would be reachable.
      const status = await getReplicaSetStatus(setClient);
      const candidates = status.members.filter(
        (member) => member.state === 'SECONDARY' && member.votes > 0,
      );
      const down = candidates[0];
      const victim = candidates[1];
      if (down === undefined || victim === undefined) {
        throw new Error('the set needs two voting secondaries for this test');
      }
      const downNode = set.nodes.find((node) => node.host === down.name);
      if (downNode === undefined) {
        throw new Error(`no container for ${down.name}`);
      }
      // Keep the stopped container, so it can restart later.
      await downNode.container.stop({ remove: false });
      await waitUntil(
        async () =>
          withPrimary(async (client) => {
            const current = await getReplicaSetStatus(client);
            return current.members.some((member) => member.id === down.id && member.health === 0);
          }),
        DEFAULT_WAIT_MS,
        'the stopped member to show as unreachable',
      );
      await withPrimary(async (client) => {
        const before = await getReplicaSetConfig(client);
        await expect(removeMember(client, { memberId: victim.id })).rejects.toThrow(
          'Only 1 of 2 voting members would be reachable',
        );
        expect((await getReplicaSetConfig(client)).version).toBe(before.version);
      });
      // Restart the stopped member, so the set is whole for the removal below.
      await downNode.container.restart();
      await waitUntil(
        async () =>
          withPrimary(async (client) => {
            const current = await getReplicaSetStatus(client);
            return current.members.some((member) => member.id === down.id && member.health === 1);
          }),
        NEW_MEMBER_TIMEOUT_MS,
        'the restarted member to rejoin',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'removes the fourth member at the end of the set tests',
    async () => {
      if (addedId === undefined || addedNode === undefined) {
        throw new Error('the fourth member was not added');
      }
      const node = addedNode;
      const id = addedId;
      const primaryIsAdded = await withPrimary(async (client) => {
        const status = await getReplicaSetStatus(client);
        return status.primary === node.host;
      });
      if (primaryIsAdded) {
        await withPrimary((client) => stepDown(client, { stepDownSeconds: 60 }));
      }
      await withPrimary(async (client) => {
        const plan = await removeMember(client, { memberId: id });
        expect(plan.refused).toBeUndefined();
      });
      const status = await withPrimary((client) => getReplicaSetStatus(client));
      expect(status.members.map((member) => member.name)).not.toContain(node.host);
      expect(status.members).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports that a standalone server is not a replica set',
    async () => {
      expect(await isReplicaSet(standaloneClient)).toBe(false);
      const error: unknown = await getReplicaSetStatus(standaloneClient).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(AppErrorException);
      const appError = error instanceof AppErrorException ? error.error : undefined;
      expect(appError?.code).toBe('COMMAND_FAILED');
      expect(appError?.detail).toMatch(/replSet/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'initiates a single-member set that reaches PRIMARY',
    async () => {
      await initiate(singleClient, { setName: 'rs0', members: [{ host: single.host }] });
      await waitUntil(
        async () => {
          const status = await getReplicaSetStatus(singleClient);
          return status.members.some((member) => member.state === 'PRIMARY');
        },
        DEFAULT_WAIT_MS,
        'the single member to reach PRIMARY',
      );
    },
    TEST_TIMEOUT_MS,
  );
});
