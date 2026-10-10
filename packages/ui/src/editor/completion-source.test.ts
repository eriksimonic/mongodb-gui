import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';
import { connectedMockApi } from '../api/connected-mock';
import { createCompletionSource } from './completion-source';
import { mergeCompletions, operatorCompletions } from './completion-model';

function signal(aborted = false): AbortSignal {
  const controller = new AbortController();
  if (aborted) {
    controller.abort();
  }
  return controller.signal;
}

describe('createCompletionSource', () => {
  it('offers the runtime methods of a collection after a dot', async () => {
    const api = await connectedMockApi();
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'analytics',
      isBusy: () => false,
    });
    const code = 'db.bson_samples.fi';
    const items = await source.complete(code, code.length, signal());

    expect(items.map((item) => item.label)).toContain('find');
    expect(items.find((item) => item.label === 'find')?.kind).toBe('method');
  });

  it('adds the sampled fields of the collection the statement names', async () => {
    const api = await connectedMockApi();
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'analytics',
      isBusy: () => false,
    });
    const code = 'db.bson_samples.find({ st';
    const merged = mergeCompletions('st', [
      await source.complete(code, code.length, signal()),
      operatorCompletions(),
    ]);

    expect(merged.map((item) => item.label)).toContain('status');
    expect(merged.find((item) => item.label === 'status')?.kind).toBe('property');
  });

  it('samples a collection once and samples again after a refresh', async () => {
    const api = await connectedMockApi();
    const sample = vi.spyOn(api.rpc.shell, 'sampleSchema');
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'analytics',
      isBusy: () => false,
    });
    const code = 'db.bson_samples.find({ ';

    await source.complete(code, code.length, signal());
    await source.complete(code, code.length, signal());
    expect(sample).toHaveBeenCalledTimes(1);

    source.refreshFields();
    await source.complete(code, code.length, signal());
    expect(sample).toHaveBeenCalledTimes(2);
  });

  it('asks the runtime nothing while it is busy', async () => {
    const api = await connectedMockApi();
    const complete = vi.spyOn(api.rpc.shell, 'complete');
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'analytics',
      isBusy: () => true,
    });

    expect(await source.complete('db.bson_samples.fi', 19, signal())).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it('returns nothing when the request was already cancelled', async () => {
    const api = await connectedMockApi();
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'analytics',
      isBusy: () => false,
    });
    expect(await source.complete('db.bson_samples.fi', 19, signal(true))).toEqual([]);
  });

  it('keeps the runtime items when the field sample fails', async () => {
    const api = await connectedMockApi();
    vi.spyOn(api.rpc.shell, 'sampleSchema').mockRejectedValue(new Error('down'));
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'analytics',
      isBusy: () => false,
    });
    const code = 'db.bson_samples.find({ ';
    const items = await source.complete(code, code.length, signal());
    expect(items.some((item) => item.kind === 'property')).toBe(false);
  });
});

describe('createCompletionSource fieldsOf', () => {
  it('resolves the sampled fields of a collection of the tab database', async () => {
    const api = await connectedMockApi();
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'analytics',
      isBusy: () => false,
    });
    const fields = await source.fieldsOf('bson_samples');
    expect(fields.map((field) => field.path)).toContain('status');
  });

  it('shares the sample cache with complete', async () => {
    const api = await connectedMockApi();
    const sample = vi.spyOn(api.rpc.shell, 'sampleSchema');
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'analytics',
      isBusy: () => false,
    });
    await source.fieldsOf('bson_samples');
    const code = 'db.bson_samples.find({ ';
    await source.complete(code, code.length, signal());
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it('samples again after a refresh', async () => {
    const api = await connectedMockApi();
    const sample = vi.spyOn(api.rpc.shell, 'sampleSchema');
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'analytics',
      isBusy: () => false,
    });
    await source.fieldsOf('bson_samples');
    source.refreshFields();
    await source.fieldsOf('bson_samples');
    expect(sample).toHaveBeenCalledTimes(2);
  });

  it('resolves to no fields when the sample fails and asks again next time', async () => {
    const api = await connectedMockApi();
    const sample = vi.spyOn(api.rpc.shell, 'sampleSchema').mockRejectedValueOnce(new Error('down'));
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'analytics',
      isBusy: () => false,
    });
    expect(await source.fieldsOf('bson_samples')).toEqual([]);
    expect((await source.fieldsOf('bson_samples')).length).toBeGreaterThan(0);
    expect(sample).toHaveBeenCalledTimes(2);
  });

  it('reads the database on each call', async () => {
    const api = await connectedMockApi();
    const sample = vi.spyOn(api.rpc.shell, 'sampleSchema');
    let database = 'analytics';
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => database,
      isBusy: () => false,
    });
    await source.fieldsOf('events');
    database = 'shop';
    await source.fieldsOf('events');
    expect(sample.mock.calls.map(([input]) => input.database)).toEqual(['analytics', 'shop']);
  });
});

describe('createCompletionSource collections', () => {
  it('lists the collections of the tab database', async () => {
    const api = await connectedMockApi();
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'analytics',
      isBusy: () => false,
    });
    expect(await source.collections()).toEqual(['bson_samples', 'events', 'sessions']);
  });

  it('lists once per database and lists again after a refresh', async () => {
    const api = await connectedMockApi();
    const list = vi.spyOn(api.rpc.collections, 'list');
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'analytics',
      isBusy: () => false,
    });
    await source.collections();
    await source.collections();
    expect(list).toHaveBeenCalledTimes(1);
    source.refreshFields();
    await source.collections();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('lists the database the tab changed to', async () => {
    const api = await connectedMockApi();
    let database = 'analytics';
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => database,
      isBusy: () => false,
    });
    await source.collections();
    database = 'logs';
    expect(await source.collections()).toEqual(['app_logs']);
  });

  it('resolves to no names when the listing fails and asks again next time', async () => {
    const api = await connectedMockApi();
    const list = vi.spyOn(api.rpc.collections, 'list').mockRejectedValueOnce(new Error('down'));
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'analytics',
      isBusy: () => false,
    });
    expect(await source.collections()).toEqual([]);
    expect(await source.collections()).toEqual(['bson_samples', 'events', 'sessions']);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('resolves to no names for an unknown database', async () => {
    const api = await connectedMockApi();
    const source = createCompletionSource({
      rpc: api.rpc,
      connectionId: localConnectionId,
      database: () => 'missing',
      isBusy: () => false,
    });
    expect(await source.collections()).toEqual([]);
  });
});
