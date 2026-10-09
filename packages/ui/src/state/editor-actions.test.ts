import { AppErrorException } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';

const UNLISTED_CONNECTION = '99999999-9999-4999-8999-999999999999';
import { connectedMockApi } from '../api/connected-mock';
import type { UiApi } from '../api/ui-api';
import { createAppStore, type AppStore } from './app-store';
import { EMPTY_EDITORS, layoutKeyFor } from './editors';

async function storeOn(api: UiApi): Promise<AppStore> {
  const store = createAppStore(api);
  api.onEvent((event) => store.getState().applyEvent(event));
  await store.getState().refreshVault();
  await store.getState().expandConnection(localConnectionId);
  return store;
}

function firstTab(store: AppStore) {
  const id = store.getState().editors.order[0];
  if (id === undefined) {
    throw new Error('no tab');
  }
  return id;
}

describe('editor actions: runs', () => {
  it('runs a statement, keeps its cursor and records the run in history', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'analytics' });
    await store.getState().runEditor(id, 'db.bson_samples.find()');

    const tab = store.getState().editors.tabs[id];
    expect(tab?.running).toBeUndefined();
    expect(tab?.result).toMatchObject({ type: 'Cursor', collection: 'bson_samples' });
    expect(tab?.result?.documents).toHaveLength(12);
    const history = await api.rpc.history.list({
      connectionId: localConnectionId,
      search: 'bson_samples',
    });
    expect(history[0]).toMatchObject({ database: 'analytics', resultCount: 12 });
  });

  it('cancels a running statement and ends with a CANCELLED error', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'analytics' });
    const run = store.getState().runEditor(id, 'sleep(5000)');
    await vi.waitFor(() => expect(store.getState().editors.tabs[id]?.running).toBeDefined());

    await store.getState().cancelEditor(id);
    await run;

    expect(store.getState().editors.tabs[id]?.error?.code).toBe('CANCELLED');
    const history = await api.rpc.history.list({
      connectionId: localConnectionId,
      search: 'sleep',
    });
    expect(history[0]?.error?.code).toBe('CANCELLED');
  });

  it('reads every page with Load all', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    store.getState().setEditorBatchSize(id, 20);
    await store.getState().runEditor(id, 'db.orders.find()');
    expect(store.getState().editors.tabs[id]?.result?.documents).toHaveLength(20);

    await store.getState().loadAllEditor(id);

    const result = store.getState().editors.tabs[id]?.result;
    expect(result?.documents).toHaveLength(240);
    expect(result?.hasMore).toBe(false);
    expect(result?.loadingMore).toBe(false);
  });

  it('pages one batch with Load more', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    store.getState().setEditorBatchSize(id, 20);
    await store.getState().runEditor(id, 'db.orders.find()');

    await store.getState().loadMoreEditor(id);

    expect(store.getState().editors.tabs[id]?.result?.documents).toHaveLength(40);
  });
});

describe('editor actions: field edits', () => {
  it('writes a field with updateDocumentFields and updates the loaded copy', async () => {
    const api = await connectedMockApi();
    const update = vi.spyOn(api.rpc.management, 'updateDocumentFields');
    const store = await storeOn(api);
    const id = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'analytics' });
    await store.getState().runEditor(id, 'db.bson_samples.find()');

    await store.getState().editField({
      tabId: id,
      documentIndex: 0,
      path: 'customer.address.city',
      value: 'Koper',
    });

    expect(update.mock.calls[0]?.[0]).toMatchObject({
      setEjson: '{"customer.address.city":"Koper"}',
    });
    const first = store.getState().editors.tabs[id]?.result?.documents[0] as {
      customer: { address: { city: string } };
    };
    expect(first.customer.address.city).toBe('Koper');
  });

  it('removes a field with $unset and drops it from the loaded copy', async () => {
    const api = await connectedMockApi();
    const update = vi.spyOn(api.rpc.management, 'updateDocumentFields');
    const store = await storeOn(api);
    const id = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'analytics' });
    await store.getState().runEditor(id, 'db.bson_samples.find()');

    await store.getState().editField({ tabId: id, documentIndex: 0, path: 'note', unset: true });

    expect(update.mock.calls[0]?.[0]).toMatchObject({ unsetPaths: ['note'] });
    expect(store.getState().editors.tabs[id]?.result?.documents[0]).not.toHaveProperty('note');
  });

  it('refuses an edit on a result that is not a plain find', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'analytics' });
    await store.getState().runEditor(id, 'db.bson_samples.countDocuments()');

    await expect(
      store.getState().editField({ tabId: id, documentIndex: 0, path: 'status', value: 'x' }),
    ).rejects.toBeInstanceOf(AppErrorException);
  });
});

describe('editor actions: output and routing', () => {
  it('routes a print line of a run to its tab', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'analytics' });
    await store.getState().runEditor(id, 'print("hi")');

    const line = store.getState().editors.output.find((item) => item.text === 'hi');
    expect(line).toMatchObject({ kind: 'print', tabId: id });
  });

  it('reports a failed run as an error line of its tab', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    await store.getState().runEditor(id, 'db.orders.find(');

    expect(store.getState().editors.output.at(-1)).toMatchObject({ kind: 'error', tabId: id });
  });

  it('records the shell runtime state from events', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    store
      .getState()
      .applyEvent({ type: 'shell:state', connectionId: localConnectionId, state: 'busy' });
    expect(store.getState().editors.runtime[localConnectionId]).toBe('busy');
  });
});

describe('editor actions: tabs', () => {
  it('focuses the open tab for a database instead of opening a second one', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const first = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'shop' });
    store.getState().openEditor({ connectionId: localConnectionId, database: 'analytics' });
    const again = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'shop' });

    expect(again).toBe(first);
    expect(store.getState().editors.order).toHaveLength(2);
    expect(store.getState().editors.activeId).toBe(first);
  });

  it('opens a second tab on the same database when asked to', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'shop', newTab: true });

    expect(store.getState().editors.order).toHaveLength(2);
  });

  it('inserts into the active tab of the connection, or opens a tab with the code', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    store
      .getState()
      .insertCode({ connectionId: localConnectionId, database: 'shop', code: 'db.orders.find()' });

    const id = firstTab(store);
    expect(store.getState().editors.tabs[id]?.text).toBe('db.orders.find()');
    expect(store.getState().editors.tabs[id]?.database).toBe('shop');
  });

  it('keeps the explain action as a placeholder that changes nothing', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const before = store.getState().editors;
    store
      .getState()
      .openExplain({ connectionId: localConnectionId, database: 'shop', code: 'db.orders.find()' });
    expect(store.getState().editors).toBe(before);
  });

  it('closes a tab and makes the next one active', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const first = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'shop' });
    const second = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'analytics' });
    store.getState().closeEditor(second);

    expect(store.getState().editors.activeId).toBe(first);
    expect(store.getState().editors.tabs[second]).toBeUndefined();
  });
});

describe('editor actions: layout', () => {
  it('saves the open tabs with the layout namespace and restores them in a new store', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    store.getState().setEditorText(id, 'db.orders.find({ status: "paid" })');
    store.getState().setEditorView(id, 'tree');
    await store.getState().restoreEditors(localConnectionId);
    await store.getState().persistEditors(localConnectionId);

    const saved = await api.rpc.layout.get({ key: layoutKeyFor(localConnectionId) });
    expect(saved).toMatchObject({ tabs: [{ database: 'shop', view: 'tree' }] });

    const reopened = createAppStore(api);
    await reopened.getState().refreshVault();
    await reopened.getState().restoreEditors(localConnectionId);
    const tab = reopened.getState().editors.tabs[firstTab(reopened)];
    expect(tab).toMatchObject({
      text: 'db.orders.find({ status: "paid" })',
      savedText: 'db.orders.find({ status: "paid" })',
      view: 'tree',
    });
  });

  it('does not save before the tabs of the connection were read', async () => {
    const api = await connectedMockApi();
    const set = vi.spyOn(api.rpc.layout, 'set');
    const store = await storeOn(api);
    // A connection the store never listed is never restored, so its tabs are not written.
    await store.getState().persistEditors(UNLISTED_CONNECTION);
    expect(set).not.toHaveBeenCalled();
  });

  it('starts with no tabs in a fresh store', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    expect(store.getState().editors).toEqual(EMPTY_EDITORS);
  });
});
