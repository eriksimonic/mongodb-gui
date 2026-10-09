import type { RpcEvent } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { localConnectionId } from './mock-fixtures';
import { createMockUiApi } from './mock-rpc-client';
import type { UiApi } from './ui-api';

const SHOP = 'shop';
const ORDERS = 'orders';

async function connectedApi(): Promise<{ api: UiApi; events: RpcEvent[] }> {
  const api = createMockUiApi({ preset: 'unlocked' });
  const events: RpcEvent[] = [];
  api.onEvent((event) => events.push(event));
  await api.rpc.connections.connect({ id: localConnectionId });
  return { api, events };
}

async function collectionNames(api: UiApi, database: string): Promise<string[]> {
  const list = await api.rpc.collections.list({ connectionId: localConnectionId, database });
  return list.map((item) => item.name);
}

describe('mock management calls', () => {
  it('refuses management calls on a connection that is not connected', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await expect(
      api.rpc.management.dropCollection({
        connectionId: localConnectionId,
        database: SHOP,
        name: ORDERS,
      }),
    ).rejects.toMatchObject({ error: { code: 'NOT_CONNECTED' } });
  });

  it('creates a collection, lists it, and reports the change', async () => {
    const { api, events } = await connectedApi();
    const created = await api.rpc.management.createCollection({
      connectionId: localConnectionId,
      database: SHOP,
      name: 'refunds',
      capped: { sizeBytes: 4096 },
    });

    expect(created).toMatchObject({
      name: 'refunds',
      type: 'collection',
      options: { capped: true },
    });
    expect(await collectionNames(api, SHOP)).toContain('refunds');
    expect(events).toContainEqual({
      type: 'catalog:changed',
      connectionId: localConnectionId,
      database: SHOP,
      collection: 'refunds',
    });
  });

  it('refuses a collection name that exists and creates a database with its first collection', async () => {
    const { api } = await connectedApi();
    await expect(
      api.rpc.management.createCollection({
        connectionId: localConnectionId,
        database: SHOP,
        name: ORDERS,
      }),
    ).rejects.toMatchObject({ error: { code: 'COMMAND_FAILED' } });

    await api.rpc.management.createDatabase({
      connectionId: localConnectionId,
      database: 'marketing',
      initialCollection: 'campaigns',
    });
    const databases = await api.rpc.databases.list({ connectionId: localConnectionId });
    expect(databases.map((item) => item.name)).toContain('marketing');
  });

  it('renames a collection and drops the target only when asked', async () => {
    const { api } = await connectedApi();
    await expect(
      api.rpc.management.renameCollection({
        connectionId: localConnectionId,
        database: SHOP,
        name: ORDERS,
        newName: 'customers',
      }),
    ).rejects.toMatchObject({ error: { code: 'COMMAND_FAILED' } });

    await api.rpc.management.renameCollection({
      connectionId: localConnectionId,
      database: SHOP,
      name: ORDERS,
      newName: 'customers',
      dropTarget: true,
    });
    const names = await collectionNames(api, SHOP);
    expect(names).toContain('customers');
    expect(names).not.toContain(ORDERS);
  });

  it('drops a database and removes it from the list', async () => {
    const { api, events } = await connectedApi();
    await api.rpc.management.dropDatabase({ connectionId: localConnectionId, database: 'logs' });
    const databases = await api.rpc.databases.list({ connectionId: localConnectionId });
    expect(databases.map((item) => item.name)).not.toContain('logs');
    expect(events).toContainEqual({
      type: 'catalog:changed',
      connectionId: localConnectionId,
      database: 'logs',
    });
  });

  it('creates and drops an index, and refuses to drop a missing one', async () => {
    const { api } = await connectedApi();
    const index = await api.rpc.management.createIndex({
      connectionId: localConnectionId,
      database: SHOP,
      collection: ORDERS,
      keys: { total: -1 },
      options: { name: 'total_desc' },
    });
    expect(index).toMatchObject({ name: 'total_desc', key: { total: -1 } });
    const listed = await api.rpc.collections.indexes({
      connectionId: localConnectionId,
      database: SHOP,
      collection: ORDERS,
    });
    expect(listed.map((item) => item.name)).toContain('total_desc');

    await api.rpc.management.dropIndex({
      connectionId: localConnectionId,
      database: SHOP,
      collection: ORDERS,
      name: 'total_desc',
    });
    await expect(
      api.rpc.management.dropIndex({
        connectionId: localConnectionId,
        database: SHOP,
        collection: ORDERS,
        name: 'total_desc',
      }),
    ).rejects.toMatchObject({ error: { code: 'COMMAND_FAILED' } });
  });

  it('hides and unhides an index', async () => {
    const { api } = await connectedApi();
    await api.rpc.management.setIndexHidden({
      connectionId: localConnectionId,
      database: SHOP,
      collection: ORDERS,
      name: 'status_1_createdAt_-1',
      hidden: true,
    });
    const listed = await api.rpc.collections.indexes({
      connectionId: localConnectionId,
      database: SHOP,
      collection: ORDERS,
    });
    expect(listed.find((item) => item.name === 'status_1_createdAt_-1')?.hidden).toBe(true);
  });

  it('reports the index build seeded in the fixtures and only for its database', async () => {
    const { api } = await connectedApi();
    const shopBuilds = await api.rpc.management.listIndexBuilds({
      connectionId: localConnectionId,
      database: SHOP,
    });
    expect(shopBuilds).toEqual([
      expect.objectContaining({ collection: ORDERS, indexName: 'customerId_1' }),
    ]);
    const logBuilds = await api.rpc.management.listIndexBuilds({
      connectionId: localConnectionId,
      database: 'logs',
    });
    expect(logBuilds).toEqual([]);
  });

  it('keeps the validator, level and action it is given and returns them', async () => {
    const { api } = await connectedApi();
    await api.rpc.management.setValidation({
      connectionId: localConnectionId,
      database: SHOP,
      collection: ORDERS,
      rules: {
        validatorEjson: '{"qty":{"$type":"int"}}',
        validationLevel: 'moderate',
        validationAction: 'warn',
      },
    });
    const rules = await api.rpc.management.getValidation({
      connectionId: localConnectionId,
      database: SHOP,
      collection: ORDERS,
    });
    expect(JSON.parse(rules.validatorEjson)).toEqual({ qty: { $type: 'int' } });
    expect(rules).toMatchObject({ validationLevel: 'moderate', validationAction: 'warn' });
  });

  it('checks a draft validator against the sample without storing it', async () => {
    const { api } = await connectedApi();
    const draft = '{"$jsonSchema":{"required":["missingField"]}}';
    const failing = await api.rpc.management.checkValidation({
      connectionId: localConnectionId,
      database: SHOP,
      collection: ORDERS,
      sampleSize: 50,
      validatorEjson: draft,
    });
    expect(failing.ok).toBe(false);
    expect(failing.failingIds).toHaveLength(20);
    expect(failing.errors[0]?.message).toBe('50 sampled documents fail the validator.');

    const stored = await api.rpc.management.getValidation({
      connectionId: localConnectionId,
      database: SHOP,
      collection: ORDERS,
    });
    expect(stored.validatorEjson).not.toContain('missingField');
  });

  it('rejects an insert that fails the stored validator under the error action', async () => {
    const { api } = await connectedApi();
    await expect(
      api.rpc.management.insertDocument({
        connectionId: localConnectionId,
        database: SHOP,
        collection: ORDERS,
        documentEjson: '{"status":"paid"}',
      }),
    ).rejects.toMatchObject({ error: { code: 'COMMAND_FAILED' } });
  });

  it('inserts, reads, updates, replaces and deletes a document', async () => {
    const { api } = await connectedApi();
    const base = { connectionId: localConnectionId, database: SHOP, collection: 'customers' };
    const idEjson = await api.rpc.management.insertDocument({
      ...base,
      documentEjson: '{"name":"Ada","tier":1}',
    });
    expect(idEjson).toContain('$oid');

    const found = await api.rpc.management.findDocumentById({ ...base, idEjson });
    expect(found).toContain('"Ada"');

    await api.rpc.management.updateDocumentFields({
      ...base,
      idEjson,
      setEjson: '{"tier":2,"address.city":"Ljubljana"}',
      unsetPaths: [],
    });
    const updated = await api.rpc.management.findDocumentById({ ...base, idEjson });
    expect(updated).toContain('"city":"Ljubljana"');

    await api.rpc.management.replaceDocument({
      ...base,
      idEjson,
      documentEjson: '{"name":"Ada L."}',
    });
    const replaced = await api.rpc.management.findDocumentById({ ...base, idEjson });
    expect(replaced).not.toContain('"tier"');

    const deleted = await api.rpc.management.deleteDocuments({ ...base, idsEjson: [idEjson] });
    expect(deleted).toBe(1);
    expect(await api.rpc.management.findDocumentById({ ...base, idEjson })).toBeNull();
  });

  it('counts a filter, deletes it when the count still matches, and refuses when it moved', async () => {
    const { api } = await connectedApi();
    const base = { connectionId: localConnectionId, database: SHOP, collection: ORDERS };
    const count = await api.rpc.management.countDocuments({
      ...base,
      filterEjson: '{"status":"pending"}',
    });
    expect(count).toBeGreaterThan(0);

    await expect(
      api.rpc.management.deleteByFilter({
        ...base,
        filterEjson: '{"status":"pending"}',
        expectedCount: count + 1,
      }),
    ).rejects.toMatchObject({ error: { code: 'VALIDATION' } });

    const deleted = await api.rpc.management.deleteByFilter({
      ...base,
      filterEjson: '{"status":"pending"}',
      expectedCount: count,
    });
    expect(deleted).toBe(count);
    expect(
      await api.rpc.management.countDocuments({ ...base, filterEjson: '{"status":"pending"}' }),
    ).toBe(0);
  });

  it('samples the first documents as JSON text up to the limit', async () => {
    const { api } = await connectedApi();
    const documents = await api.rpc.management.sampleDocuments({
      connectionId: localConnectionId,
      database: SHOP,
      collection: ORDERS,
      limit: 5,
    });
    expect(documents).toHaveLength(5);
    expect(JSON.parse(documents[0] ?? '{}')).toMatchObject({ name: 'orders-1' });
  });

  it('clears a collection and reports zero documents in its stats', async () => {
    const { api } = await connectedApi();
    await api.rpc.management.clearCollection({
      connectionId: localConnectionId,
      database: SHOP,
      name: ORDERS,
    });
    const stats = await api.rpc.collections.stats({
      connectionId: localConnectionId,
      database: SHOP,
      collection: ORDERS,
    });
    expect(stats.count).toBe(0);
  });
});
