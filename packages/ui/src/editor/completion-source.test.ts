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
