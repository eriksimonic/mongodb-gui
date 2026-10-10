import { AppErrorException } from '@mongo-gui/core';
import { describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';

const UNLISTED_CONNECTION = '99999999-9999-4999-8999-999999999999';
import { connectedMockApi } from '../api/connected-mock';
import type { UiApi } from '../api/ui-api';
import { editorUiEvents } from '../editor/editor-events';
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

  it('re-runs history code in a new tab and keeps the text of the current tab', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const current = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'shop' });
    store.getState().setEditorText(current, 'db.orders.countDocuments()');

    await store.getState().rerunStatement({
      connectionId: localConnectionId,
      database: 'analytics',
      code: 'db.bson_samples.find()',
    });

    const { tabs, order, activeId } = store.getState().editors;
    expect(order).toHaveLength(2);
    expect(tabs[current]?.text).toBe('db.orders.countDocuments()');
    expect(activeId).not.toBe(current);
    expect(activeId === undefined ? undefined : tabs[activeId]).toMatchObject({
      database: 'analytics',
      text: 'db.bson_samples.find()',
    });
  });

  it('re-runs history code in an empty current tab instead of opening another', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const empty = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'shop' });

    await store.getState().rerunStatement({
      connectionId: localConnectionId,
      database: 'analytics',
      code: 'db.bson_samples.find()',
    });

    expect(store.getState().editors.order).toEqual([empty]);
    expect(store.getState().editors.tabs[empty]).toMatchObject({
      database: 'analytics',
      text: 'db.bson_samples.find()',
    });
  });

  it('opens a query tab for a collection, sets its text and runs it', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const current = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'shop' });
    store.getState().setEditorText(current, 'db.orders.countDocuments()');

    await store.getState().openCollectionQuery({
      connectionId: localConnectionId,
      database: 'analytics',
      collection: 'bson_samples',
    });

    const { tabs, activeId } = store.getState().editors;
    expect(tabs[current]?.text).toBe('db.orders.countDocuments()');
    expect(activeId === undefined ? undefined : tabs[activeId]).toMatchObject({
      database: 'analytics',
      text: 'db.bson_samples.find({})',
      result: { type: 'Cursor', collection: 'bson_samples' },
    });
  });

  it('brings the tab that already shows the collection to the front instead of opening another', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const target = {
      connectionId: localConnectionId,
      database: 'analytics',
      collection: 'bson_samples',
    };
    await store.getState().openCollectionQuery(target);
    const first = store.getState().editors.activeId;
    const other = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'shop', newTab: true });
    store.getState().setEditorText(other, 'db.orders.find({})');
    const revision = store.getState().editors.focusRevision;

    await store.getState().openCollectionQuery(target);

    const { order, activeId, focusRevision } = store.getState().editors;
    expect(order).toHaveLength(2);
    expect(activeId).toBe(first);
    expect(focusRevision).toBeGreaterThan(revision);
  });

  it('reuses an empty tab on the same connection for a collection query', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const empty = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'shop' });

    await store.getState().openCollectionQuery({
      connectionId: localConnectionId,
      database: 'analytics',
      collection: 'bson_samples',
    });

    expect(store.getState().editors.order).toEqual([empty]);
    expect(store.getState().editors.tabs[empty]).toMatchObject({
      database: 'analytics',
      text: 'db.bson_samples.find({})',
    });
  });

  it('stops Load all at the limit, asking for no more than the documents left', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'analytics' });
    const cursorDocuments = (count: number) =>
      JSON.stringify({
        documents: Array.from({ length: count }, (_, n) => ({ n })),
        cursorHasMore: true,
      });
    vi.spyOn(api.rpc.shell, 'evaluate').mockResolvedValue({
      requestId: 'first',
      result: {
        type: 'Cursor',
        printableEjson: cursorDocuments(1),
        hasMore: true,
        cursorRequestId: 'cursor',
      },
    } as unknown as Awaited<ReturnType<typeof api.rpc.shell.evaluate>>);
    const requested: number[] = [];
    vi.spyOn(api.rpc.shell, 'next').mockImplementation((input) => {
      const size = input.batchSize ?? 0;
      requested.push(size);
      return Promise.resolve({
        requestId: 'cursor',
        result: {
          type: 'Cursor',
          printableEjson: cursorDocuments(size),
          hasMore: true,
          cursorRequestId: 'cursor',
        },
      } as unknown as Awaited<ReturnType<typeof api.rpc.shell.next>>);
    });
    await store.getState().runEditor(id, 'db.bson_samples.find()');

    await store.getState().loadAllEditor(id);

    expect(store.getState().editors.tabs[id]?.result?.documents).toHaveLength(5000);
    expect(requested.reduce((sum, size) => sum + size, 0)).toBe(4999);
    expect(requested.at(-1)).toBe(499);
    expect(requested.every((size) => size <= 500)).toBe(true);
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

describe('editor actions: language', () => {
  it('opens a new tab in the mongosh default when the settings are not loaded', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    expect(store.getState().editors.tabs[id]?.language).toBe('mongosh');
  });

  it('opens a new tab in the language of the saved settings', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    await store.getState().updateSettings({ editorLanguage: 'sql' });
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    expect(store.getState().editors.tabs[id]?.language).toBe('sql');
  });

  it('opens a tab in the language it is given, ahead of the saved default', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    await store.getState().updateSettings({ editorLanguage: 'sql' });
    const id = store.getState().openEditor({
      connectionId: localConnectionId,
      database: 'shop',
      language: 'mongosh',
    });
    expect(store.getState().editors.tabs[id]?.language).toBe('mongosh');
  });

  it('keeps the language of an existing tab when it is opened again', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
    });
    const again = store.getState().openEditor({
      connectionId: localConnectionId,
      database: 'shop',
      language: 'mongosh',
    });
    expect(again).toBe(id);
    expect(store.getState().editors.tabs[id]?.language).toBe('sql');
  });

  it('switches the tab language and saves it as the default in the settings', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    store.getState().setEditorText(id, 'SELECT * FROM orders;');

    await store.getState().setEditorLanguage(id, 'sql');

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'sql',
      text: 'SELECT * FROM orders;',
    });
    expect(store.getState().settings?.editorLanguage).toBe('sql');
    expect((await api.rpc.settings.get()).editorLanguage).toBe('sql');
  });

  it('keeps the tab switched and shows an error line when the default cannot be saved', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    vi.spyOn(api.rpc.settings, 'update').mockRejectedValueOnce(new Error('disk is full'));

    await store.getState().setEditorLanguage(id, 'sql');

    expect(store.getState().editors.tabs[id]?.language).toBe('sql');
    expect(store.getState().editors.output.at(-1)).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('The default language was not saved.'),
    });
  });

  it('does not save the settings again when the default already has the language', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    await store.getState().loadSettings();
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    const update = vi.spyOn(api.rpc.settings, 'update');

    await store.getState().setEditorLanguage(id, 'mongosh');

    expect(update).not.toHaveBeenCalled();
    expect(store.getState().editors.tabs[id]?.language).toBe('mongosh');
  });

  it('runs SQL with the mongosh printed first and records the SQL as SQL', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
    });
    const sql = 'SELECT TOP 5 * FROM orders;';
    const mongosh = 'db.orders.find({}).limit(5)';

    await store.getState().runEditor(id, mongosh, { sql });

    const printed = store.getState().editors.output.find((line) => line.text === mongosh);
    expect(printed).toMatchObject({ kind: 'info', tabId: id });
    const history = await api.rpc.history.list({
      connectionId: localConnectionId,
      search: 'orders',
    });
    expect(history.find((entry) => entry.code === sql)).toMatchObject({
      database: 'shop',
      language: 'sql',
    });
  });

  it('records a mongosh run as mongosh and prints nothing extra', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    const before = store.getState().editors.output.length;

    await store.getState().runEditor(id, 'db.orders.countDocuments()');

    expect(store.getState().editors.output.length).toBe(before);
    const history = await api.rpc.history.list({
      connectionId: localConnectionId,
      search: 'countDocuments',
    });
    expect(history[0]).toMatchObject({ code: 'db.orders.countDocuments()', language: 'mongosh' });
  });

  it('re-runs SQL history in a SQL tab without running it', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const runs = vi.spyOn(api.rpc.shell, 'evaluate');

    await store.getState().rerunStatement({
      connectionId: localConnectionId,
      database: 'shop',
      code: 'SELECT * FROM orders;',
      language: 'sql',
    });

    const id = firstTab(store);
    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'sql',
      text: 'SELECT * FROM orders;',
      running: undefined,
      result: undefined,
    });
    expect(runs).not.toHaveBeenCalled();
    expect(store.getState().editors.output.at(-1)).toMatchObject({
      kind: 'info',
      tabId: id,
    });
  });

  it('re-runs mongosh history in a mongosh tab even when the saved default is SQL', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    await store.getState().updateSettings({ editorLanguage: 'sql' });

    await store.getState().rerunStatement({
      connectionId: localConnectionId,
      database: 'analytics',
      code: 'db.bson_samples.find()',
      language: 'mongosh',
    });

    const id = firstTab(store);
    expect(store.getState().editors.tabs[id]).toMatchObject({ language: 'mongosh' });
    expect(store.getState().editors.tabs[id]?.result).toMatchObject({ type: 'Cursor' });
  });

  it('treats a rerun without a language as mongosh, even when the saved default is SQL', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    await store.getState().updateSettings({ editorLanguage: 'sql' });

    await store.getState().rerunStatement({
      connectionId: localConnectionId,
      database: 'analytics',
      code: 'db.bson_samples.find()',
    });

    expect(store.getState().editors.tabs[firstTab(store)]?.language).toBe('mongosh');
  });

  it('switches an empty tab to the language of the rerun', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const empty = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'shop' });

    await store.getState().rerunStatement({
      connectionId: localConnectionId,
      database: 'shop',
      code: 'SELECT 1;',
      language: 'sql',
    });

    expect(store.getState().editors.order).toEqual([empty]);
    expect(store.getState().editors.tabs[empty]?.language).toBe('sql');
  });

  it('saves a favourite with the language of its tab', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
    });
    store.getState().setEditorText(id, 'SELECT * FROM orders;');

    await store.getState().saveFavourite({
      name: 'Orders',
      code: 'SELECT * FROM orders;',
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
      tabId: id,
    });

    const favourites = await api.rpc.favourites.list();
    expect(favourites.find((item) => item.name === 'Orders')).toMatchObject({ language: 'sql' });
    expect(store.getState().editors.tabs[id]?.savedText).toBe('SELECT * FROM orders;');
  });

  it('saves a favourite without a language when the code has none', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);

    await store.getState().saveFavourite({
      name: 'Plain',
      code: 'db.orders.find()',
      connectionId: localConnectionId,
      database: 'shop',
    });

    const favourites = await api.rpc.favourites.list();
    const saved = favourites.find((item) => item.name === 'Plain');
    expect(saved).toBeDefined();
    expect(saved?.language).toBeUndefined();
  });

  it('inserts code into the active tab when the language matches or is not given', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
    });
    const emitted: unknown[] = [];
    const unsubscribe = editorUiEvents.subscribe((event) => emitted.push(event));

    store.getState().insertCode({
      connectionId: localConnectionId,
      database: 'shop',
      code: 'SELECT 1;',
      language: 'sql',
    });
    store.getState().insertCode({
      connectionId: localConnectionId,
      database: 'shop',
      code: 'SELECT 2;',
    });
    unsubscribe();

    expect(store.getState().editors.order).toEqual([id]);
    expect(emitted).toEqual([
      { type: 'editor:insert', tabId: id, text: 'SELECT 1;' },
      { type: 'editor:insert', tabId: id, text: 'SELECT 2;' },
    ]);
  });

  it('opens a tab of its own when the code language differs from the active tab', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const mongo = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'shop' });

    store.getState().insertCode({
      connectionId: localConnectionId,
      database: 'shop',
      code: 'SELECT * FROM orders;',
      language: 'sql',
    });

    const { order, tabs, activeId } = store.getState().editors;
    expect(order).toHaveLength(2);
    expect(order[0]).toBe(mongo);
    expect(activeId).not.toBe(mongo);
    expect(activeId === undefined ? undefined : tabs[activeId]).toMatchObject({
      language: 'sql',
      text: 'SELECT * FROM orders;',
    });
  });

  it('opens a tab in the language of the inserted code when none is open', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);

    store.getState().insertCode({
      connectionId: localConnectionId,
      database: 'shop',
      code: 'SELECT 1;',
      language: 'sql',
    });

    expect(store.getState().editors.tabs[firstTab(store)]).toMatchObject({
      language: 'sql',
      text: 'SELECT 1;',
    });
  });

  it('opens a mongosh tab for code without a language when none is open, whatever the default', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    await store.getState().updateSettings({ editorLanguage: 'sql' });

    store.getState().insertCode({
      connectionId: localConnectionId,
      database: 'shop',
      code: 'db.orders.find()',
    });

    expect(store.getState().editors.tabs[firstTab(store)]?.language).toBe('mongosh');
  });

  it('restores the language of saved tabs in a new store', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
    });
    store.getState().setEditorText(id, 'SELECT 1;');
    await store.getState().persistEditors(localConnectionId);

    const reopened = createAppStore(api);
    await reopened.getState().refreshVault();
    await reopened.getState().restoreEditors(localConnectionId);

    expect(reopened.getState().editors.tabs[firstTab(reopened)]?.language).toBe('sql');
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

    const { value: saved } = await api.rpc.layout.get({ key: layoutKeyFor(localConnectionId) });
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

describe('editor actions: SQL tabs', () => {
  const sampler = { fieldsOf: () => Promise.resolve([]) };

  it('opens a collection as a SELECT in a SQL tab and runs its translation when the default is SQL', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    const store = await storeOn(api);
    await store.getState().updateSettings({ editorLanguage: 'sql' });

    await store.getState().openCollectionQuery({
      connectionId: localConnectionId,
      database: 'analytics',
      collection: 'bson_samples',
    });

    const { tabs, activeId, output } = store.getState().editors;
    const tab = activeId === undefined ? undefined : tabs[activeId];
    expect(tab).toMatchObject({
      language: 'sql',
      text: 'SELECT * FROM bson_samples;',
      result: { type: 'Cursor', collection: 'bson_samples' },
    });
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({ code: 'db.bson_samples.find({})' });
    expect(output.find((line) => line.text === 'db.bson_samples.find({})')).toMatchObject({
      kind: 'info',
    });
    const history = await api.rpc.history.list({
      connectionId: localConnectionId,
      search: 'bson_samples',
    });
    expect(history[0]).toMatchObject({ code: 'SELECT * FROM bson_samples;', language: 'sql' });
  });

  it('brackets a collection name that is a SQL keyword in the SELECT', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    const store = await storeOn(api);
    await store.getState().updateSettings({ editorLanguage: 'sql' });

    await store.getState().openCollectionQuery({
      connectionId: localConnectionId,
      database: 'shop',
      collection: 'user',
    });

    const { tabs, activeId } = store.getState().editors;
    expect(activeId === undefined ? undefined : tabs[activeId]?.text).toBe('SELECT * FROM [user];');
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({ code: 'db.user.find({})' });
  });

  it('brings the SQL tab that already shows the collection to the front', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    await store.getState().updateSettings({ editorLanguage: 'sql' });
    const target = {
      connectionId: localConnectionId,
      database: 'analytics',
      collection: 'bson_samples',
    };
    await store.getState().openCollectionQuery(target);
    const first = store.getState().editors.activeId;
    const other = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'shop', newTab: true });
    store.getState().setEditorText(other, 'SELECT * FROM orders;');

    await store.getState().openCollectionQuery(target);

    const { order, activeId } = store.getState().editors;
    expect(order).toHaveLength(2);
    expect(activeId).toBe(first);
  });

  it('does not reuse a mongosh tab for the SQL query of the same collection', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const target = {
      connectionId: localConnectionId,
      database: 'analytics',
      collection: 'bson_samples',
    };
    await store.getState().openCollectionQuery(target);
    await store.getState().updateSettings({ editorLanguage: 'sql' });

    await store.getState().openCollectionQuery(target);

    const { order, tabs } = store.getState().editors;
    expect(order.map((id) => tabs[id]?.language)).toEqual(['mongosh', 'sql']);
  });

  it('keeps opening find({}) in a mongosh tab when the default is mongosh', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    await store.getState().openCollectionQuery({
      connectionId: localConnectionId,
      database: 'analytics',
      collection: 'bson_samples',
    });
    const { tabs, activeId } = store.getState().editors;
    expect(activeId === undefined ? undefined : tabs[activeId]).toMatchObject({
      language: 'mongosh',
      text: 'db.bson_samples.find({})',
    });
  });

  it('converts a SQL tab to its mongosh and switches the tab language', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
    });
    store.getState().setEditorText(id, 'SELECT * FROM orders; DELETE FROM orders');

    await store.getState().convertEditorToMongosh(id, sampler);

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'mongosh',
      text: 'db.orders.find({});\ndb.orders.deleteMany({})',
    });
    expect(store.getState().settings?.editorLanguage).toBe('mongosh');
  });

  it('uses the sampled field types when it converts', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
    });
    store.getState().setEditorText(id, "SELECT * FROM orders WHERE createdAt > '2026-01-02'");
    const dated = {
      fieldsOf: () => Promise.resolve([{ path: 'createdAt', types: ['Date'], presence: 1 }]),
    };

    await store.getState().convertEditorToMongosh(id, dated);

    expect(store.getState().editors.tabs[id]?.text).toBe(
      "db.orders.find({ createdAt: { $gt: ISODate('2026-01-02T00:00:00.000Z') } })",
    );
  });

  it('keeps the SQL and shows the error on the tab when the conversion fails', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
    });
    store.getState().setEditorText(id, 'SELECT * FROM orders WHERE');

    await store.getState().convertEditorToMongosh(id, sampler);

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'sql',
      text: 'SELECT * FROM orders WHERE',
      error: { code: 'VALIDATION', message: 'expected an expression but the statement ended' },
    });
  });

  it('leaves a mongosh tab alone when asked to convert it', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    store.getState().setEditorText(id, 'db.orders.find()');

    await store.getState().convertEditorToMongosh(id, sampler);

    expect(store.getState().editors.tabs[id]?.text).toBe('db.orders.find()');
  });

  it('sets and clears the error of a tab', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });

    store.getState().setEditorError(id, { code: 'VALIDATION', message: 'bad SQL' });
    expect(store.getState().editors.tabs[id]?.error).toEqual({
      code: 'VALIDATION',
      message: 'bad SQL',
    });

    store.getState().setEditorError(id, undefined);
    expect(store.getState().editors.tabs[id]?.error).toBeUndefined();
  });
});
