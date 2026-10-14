import { AppErrorException } from '@mongo-gui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localConnectionId } from '../api/mock-fixtures';

const UNLISTED_CONNECTION = '99999999-9999-4999-8999-999999999999';
import { connectedMockApi } from '../api/connected-mock';
import type { UiApi } from '../api/ui-api';
import { editorUiEvents, type EditorUiEvent } from '../editor';
import { createAppStore, type AppStore } from './app-store';
import { EMPTY_EDITORS, layoutKeyFor, savedTabsOf } from './editors';

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

  it('connects a disconnected connection before it runs', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    await store.getState().disconnect(localConnectionId);
    const id = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'analytics' });
    await store.getState().runEditor(id, 'db.bson_samples.find()');

    expect(store.getState().statuses[localConnectionId]?.state).toBe('connected');
    expect(store.getState().editors.tabs[id]?.result).toMatchObject({ type: 'Cursor' });
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

  it('switches the tab language, keeps the text of each language and saves the default', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    store.getState().setEditorText(id, 'db.orders.find()');

    await store.getState().setEditorLanguage(id, 'sql');
    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'sql',
      text: '',
      otherText: 'db.orders.find()',
    });
    store.getState().setEditorText(id, 'SELECT * FROM orders;');
    await store.getState().setEditorLanguage(id, 'mongosh');

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'mongosh',
      text: 'db.orders.find()',
      otherText: 'SELECT * FROM orders;',
    });
    expect(store.getState().settings?.editorLanguage).toBe('mongosh');
    expect((await api.rpc.settings.get()).editorLanguage).toBe('mongosh');
  });

  it('does not translate when the language switches to mongosh', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    const store = await storeOn(api);
    const id = store.getState().openEditor({
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
    });
    store.getState().setEditorText(id, 'SELECT * FROM orders');

    await store.getState().setEditorLanguage(id, 'mongosh');

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'mongosh',
      text: '',
      otherText: 'SELECT * FROM orders',
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(store.getState().editors.output).toEqual([]);
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

    await store.getState().openSqlAsMongo(id);

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

  it('runs a given SQL statement in a SQL tab when the default language is mongosh', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    const store = await storeOn(api);

    await store
      .getState()
      .openCollectionQuery(
        { connectionId: localConnectionId, database: 'shop', collection: 'orders' },
        'SELECT TOP 1000 * FROM orders;',
      );

    const { tabs, activeId } = store.getState().editors;
    const tab = activeId === undefined ? undefined : tabs[activeId];
    expect(tab).toMatchObject({ text: 'SELECT TOP 1000 * FROM orders;', language: 'sql' });
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({ code: 'db.orders.find({}).limit(1000)' });
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

  /** Opens a SQL tab holding the text. */
  async function sqlTab(store: AppStore, text: string): Promise<string> {
    const id = store.getState().openEditor({
      connectionId: localConnectionId,
      database: 'shop',
      language: 'sql',
    });
    store.getState().setEditorText(id, text);
    return id;
  }

  function markerEvents(): EditorUiEvent[] {
    const events: EditorUiEvent[] = [];
    unsubscribers.push(
      editorUiEvents.subscribe((event) => {
        if (event.type === 'editor:markers') {
          events.push(event);
        }
      }),
    );
    return events;
  }

  const unsubscribers: (() => void)[] = [];
  afterEach(() => {
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  });

  it('translates the SQL and switches the tab to mongosh when the language changes', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = await sqlTab(store, 'SELECT * FROM orders; DELETE FROM orders');
    await store.getState().updateSettings({ editorLanguage: 'sql' });
    expect((await api.rpc.settings.get()).editorLanguage).toBe('sql');

    await store.getState().openSqlAsMongo(id, sampler);

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'mongosh',
      text: 'db.orders.find({});\ndb.orders.deleteMany({})',
    });
    expect(store.getState().settings?.editorLanguage).toBe('mongosh');
    expect((await api.rpc.settings.get()).editorLanguage).toBe('mongosh');
  });

  it('adds no line to the Output panel and clears an old error when it converts', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = await sqlTab(store, 'SELECT * FROM orders');
    store.getState().setEditorError(id, { code: 'VALIDATION', message: 'old' });

    await store.getState().openSqlAsMongo(id, sampler);

    expect(store.getState().editors.output).toEqual([]);
    expect(store.getState().editors.tabs[id]?.error).toBeUndefined();
  });

  it('does not run anything when it converts', async () => {
    const api = await connectedMockApi();
    const evaluate = vi.spyOn(api.rpc.shell, 'evaluate');
    const store = await storeOn(api);
    const id = await sqlTab(store, 'SELECT * FROM orders');

    await store.getState().openSqlAsMongo(id, sampler);

    expect(evaluate).not.toHaveBeenCalled();
  });

  it('converts without field types when no sampler is given', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = await sqlTab(store, 'SELECT TOP 5 * FROM orders');

    await store.getState().openSqlAsMongo(id);

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'mongosh',
      text: 'db.orders.find({}).limit(5)',
    });
  });

  it('uses the sampled field types when it converts', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = await sqlTab(store, "SELECT * FROM orders WHERE createdAt > '2026-01-02'");
    const dated = {
      fieldsOf: () => Promise.resolve([{ path: 'createdAt', types: ['Date'], presence: 1 }]),
    };

    await store.getState().openSqlAsMongo(id, dated);

    expect(store.getState().editors.tabs[id]?.text).toBe(
      "db.orders.find({ createdAt: { $gt: ISODate('2026-01-02T00:00:00.000Z') } })",
    );
  });

  it('keeps the sampled type of a failing sampler out of the way and still converts', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = await sqlTab(store, 'SELECT * FROM orders');
    const broken = { fieldsOf: () => Promise.reject(new Error('sample failed')) };

    await store.getState().openSqlAsMongo(id, broken);

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'mongosh',
      text: 'db.orders.find({})',
    });
  });

  it.each([
    ['empty text', ''],
    ['blank text', '  \n\t '],
    ['a line comment', '-- nothing here'],
    ['a block comment', '/* nothing here */'],
    ['comments and separators', '-- a\n;\n/* b */\nGO'],
  ])('switches with the text unchanged for %s', async (_name, text) => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = await sqlTab(store, text);
    const markers = markerEvents();

    await store.getState().openSqlAsMongo(id, sampler);

    const tab = store.getState().editors.tabs[id];
    expect(tab).toMatchObject({ language: 'mongosh', text: '', otherText: text });
    expect(tab?.error).toBeUndefined();
    expect(markers).toEqual([]);
    expect(store.getState().settings?.editorLanguage).toBe('mongosh');
  });

  it('keeps the SQL, stays in SQL and shows the error on the tab when the translation fails', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = await sqlTab(store, 'SELECT * FROM orders WHERE');
    const markers = markerEvents();
    const update = vi.spyOn(api.rpc.settings, 'update');

    await store.getState().openSqlAsMongo(id, sampler);

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'sql',
      text: 'SELECT * FROM orders WHERE',
      error: { code: 'VALIDATION', message: 'expected an expression but the statement ended' },
    });
    expect(markers).toEqual([
      {
        type: 'editor:markers',
        tabId: id,
        markers: [
          { start: 21, end: 26, message: 'expected an expression but the statement ended' },
        ],
      },
    ]);
    expect(update).not.toHaveBeenCalled();
    expect(store.getState().editors.output).toEqual([]);
  });

  it('marks the failing statement at its offset and converts none of the statements', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const first = 'SELECT * FROM orders;\n';
    const id = await sqlTab(store, `${first}SELEC * FROM orders`);
    const markers = markerEvents();

    await store.getState().openSqlAsMongo(id, sampler);

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'sql',
      text: `${first}SELEC * FROM orders`,
    });
    const [event] = markers;
    expect(
      event?.type === 'editor:markers' ? event.markers[0]?.start : undefined,
    ).toBeGreaterThanOrEqual(first.length);
  });

  it('converts after a failed attempt once the SQL is fixed', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = await sqlTab(store, 'SELECT * FROM orders WHERE');
    await store.getState().openSqlAsMongo(id, sampler);
    expect(store.getState().editors.tabs[id]?.language).toBe('sql');

    store.getState().setEditorText(id, 'SELECT * FROM orders');
    await store.getState().openSqlAsMongo(id, sampler);

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'mongosh',
      text: 'db.orders.find({})',
      error: undefined,
    });
  });

  it('restores the original SQL when the text is still the converted mongosh', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const sql = 'select  *\nfrom orders -- keep this comment\n;\nDELETE FROM orders WHERE id = 1';
    const id = await sqlTab(store, sql);
    await store.getState().openSqlAsMongo(id, sampler);
    expect(store.getState().editors.tabs[id]?.text).not.toBe(sql);

    await store.getState().setEditorLanguage(id, 'sql');

    expect(store.getState().editors.tabs[id]).toMatchObject({ language: 'sql', text: sql });
    expect(store.getState().settings?.editorLanguage).toBe('sql');
  });

  it('survives a second round trip', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const sql = 'SELECT   * FROM orders';
    const id = await sqlTab(store, sql);

    for (let round = 0; round < 2; round += 1) {
      await store.getState().openSqlAsMongo(id, sampler);
      expect(store.getState().editors.tabs[id]?.text).toBe('db.orders.find({})');
      await store.getState().setEditorLanguage(id, 'sql');
      expect(store.getState().editors.tabs[id]?.text).toBe(sql);
    }
  });

  it('keeps an edited mongosh text and brings the SQL back when it switches to SQL', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = await sqlTab(store, 'SELECT * FROM orders');
    await store.getState().openSqlAsMongo(id, sampler);
    store.getState().setEditorText(id, 'db.orders.find({}).limit(1)');

    await store.getState().setEditorLanguage(id, 'sql');

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'sql',
      text: 'SELECT * FROM orders',
      otherText: 'db.orders.find({}).limit(1)',
    });
  });

  it('replaces the mongosh the tab held when the SQL opens as mongosh', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    store.getState().setEditorText(id, 'db.customers.find()');
    await store.getState().setEditorLanguage(id, 'sql');
    store.getState().setEditorText(id, 'SELECT * FROM orders');

    await store.getState().openSqlAsMongo(id, sampler);

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'mongosh',
      text: 'db.orders.find({})',
      otherText: 'SELECT * FROM orders',
    });
  });

  it('opens an empty SQL side for a tab that never held SQL', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    store.getState().setEditorText(id, 'db.orders.find()');

    await store.getState().setEditorLanguage(id, 'sql');

    expect(store.getState().editors.tabs[id]).toMatchObject({ language: 'sql', text: '' });
  });

  it('saves the SQL and the mongosh of a tab with the tabs', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = await sqlTab(store, 'SELECT * FROM orders');
    await store.getState().openSqlAsMongo(id, sampler);

    const saved = savedTabsOf(store.getState().editors, localConnectionId);

    expect(saved.tabs[0]).toMatchObject({
      language: 'mongosh',
      text: 'db.orders.find({})',
      otherText: 'SELECT * FROM orders',
    });
  });

  it('leaves the language alone while a run is in progress', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = await sqlTab(store, 'SELECT * FROM orders');
    const update = vi.spyOn(api.rpc.settings, 'update');
    const run = store.getState().runEditor(id, 'sleep(5000)');
    await vi.waitFor(() => expect(store.getState().editors.tabs[id]?.running).toBeDefined());

    await store.getState().openSqlAsMongo(id, sampler);
    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'sql',
      text: 'SELECT * FROM orders',
    });
    expect(update).not.toHaveBeenCalled();

    await store.getState().cancelEditor(id);
    await run;
  });

  it('leaves a mongosh tab on mongosh while a run is in progress', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    const run = store.getState().runEditor(id, 'sleep(5000)');
    await vi.waitFor(() => expect(store.getState().editors.tabs[id]?.running).toBeDefined());

    await store.getState().setEditorLanguage(id, 'sql');
    expect(store.getState().editors.tabs[id]?.language).toBe('mongosh');

    await store.getState().cancelEditor(id);
    await run;
  });

  it('leaves the tab as it is when the text changes while the fields are sampled', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = await sqlTab(store, 'SELECT * FROM orders');
    const slow = {
      fieldsOf: async () => {
        store.getState().setEditorText(id, 'SELECT * FROM customers');
        return [];
      },
    };

    await store.getState().openSqlAsMongo(id, slow);

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'sql',
      text: 'SELECT * FROM customers',
    });
  });

  it('does nothing for a tab that is already in the language', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store.getState().openEditor({ connectionId: localConnectionId, database: 'shop' });
    store.getState().setEditorText(id, 'db.orders.find()');
    const update = vi.spyOn(api.rpc.settings, 'update');

    await store.getState().openSqlAsMongo(id, sampler);

    expect(store.getState().editors.tabs[id]?.text).toBe('db.orders.find()');
    expect(update).not.toHaveBeenCalled();
  });

  it('ignores a tab that does not exist', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);

    await expect(store.getState().openSqlAsMongo('missing')).resolves.toBe(false);

    expect(store.getState().editors.tabs).toEqual({});
  });

  it('keeps the converted text and shows an error line when the default cannot be saved', async () => {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = await sqlTab(store, 'SELECT * FROM orders');
    // The saved default is SQL, so the switch to mongosh has a setting to save.
    const other = store.getState().openEditor({
      connectionId: localConnectionId,
      database: 'shop',
      newTab: true,
    });
    await store.getState().setEditorLanguage(other, 'sql');
    vi.spyOn(api.rpc.settings, 'update').mockRejectedValueOnce(new Error('disk is full'));

    await store.getState().openSqlAsMongo(id, sampler);

    expect(store.getState().editors.tabs[id]).toMatchObject({
      language: 'mongosh',
      text: 'db.orders.find({})',
    });
    expect(store.getState().editors.output.at(-1)).toMatchObject({
      kind: 'error',
      text: expect.stringContaining('The default language was not saved.'),
    });
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

describe('editor actions: previews', () => {
  const REF = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';
  const MARKER = { $mgTruncated: { t: 'array', n: 200000 } };

  /** A tab whose first page is the given documents, with a cursor that has more. */
  async function previewTab(documents: readonly unknown[]) {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'analytics' });
    vi.spyOn(api.rpc.shell, 'evaluate').mockResolvedValue({
      requestId: 'first',
      result: {
        type: 'Cursor',
        printableEjson: JSON.stringify({ documents, cursorHasMore: true }),
        hasMore: true,
        cursorRequestId: 'cursor',
      },
    } as unknown as Awaited<ReturnType<typeof api.rpc.shell.evaluate>>);
    await store.getState().runEditor(id, 'db.bson_samples.find()');
    return { api, store, id };
  }

  it('refuses an edit when _id of the preview is a marker', async () => {
    const { api, store, id } = await previewTab([
      { _id: { $mgTruncated: { t: 'string', n: 99999, head: 'k' } }, a: 1 },
    ]);
    const update = vi.spyOn(api.rpc.management, 'updateDocumentFields');

    await expect(
      store.getState().editField({ tabId: id, documentIndex: 0, path: 'a', unset: true }),
    ).rejects.toMatchObject({ error: { code: 'VALIDATION' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('sends only the id and the one edited path for a previewed document', async () => {
    const { api, store, id } = await previewTab([
      { _id: 7, big: MARKER, a: 1, $mgTruncated: { ref: REF, chars: 3_600_000 } },
    ]);
    const update = vi
      .spyOn(api.rpc.management, 'updateDocumentFields')
      .mockResolvedValue(undefined as never);

    await store.getState().editField({ tabId: id, documentIndex: 0, path: 'a', value: 2 });

    const sent = update.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ idEjson: '7', setEjson: '{"a":2}' });
    expect(JSON.stringify(sent)).not.toContain('$mgTruncated');
    // The spill still holds the text from before the edit, so the row records the edit with the ref.
    const row = store.getState().editors.tabs[id]?.result?.documents[0];
    expect(row).toMatchObject({
      a: 2,
      $mgTruncated: { ref: REF, chars: 3_600_000, edits: [{ path: 'a', value: 2 }] },
    });
  });

  it('exports and opens an edited previewed document with the edits applied to the stored text', async () => {
    const { api, store, id } = await previewTab([
      { _id: 7, big: MARKER, a: 1, gone: 1, $mgTruncated: { ref: REF, chars: 3_600_000 } },
    ]);
    vi.spyOn(api.rpc.management, 'updateDocumentFields').mockResolvedValue(undefined as never);
    vi.spyOn(api.rpc.shell, 'readDocument').mockResolvedValue(
      '{"_id":7,"big":[1,2,3],"a":1,"gone":1}',
    );
    const writes: string[] = [];
    vi.spyOn(api.rpc.app, 'writeExport').mockImplementation((input) => {
      writes.push(input.content);
      return Promise.resolve();
    });

    await store.getState().editField({ tabId: id, documentIndex: 0, path: 'a', value: 2 });
    await store.getState().editField({ tabId: id, documentIndex: 0, path: 'gone', unset: true });
    const result = await store.getState().exportResult(id, 'json');

    expect(result).toEqual({ skipped: 0 });
    expect(JSON.parse(writes.join(''))).toEqual([{ _id: 7, big: [1, 2, 3], a: 2 }]);
  });

  it('stops Load all when the loaded text reaches the resident limit', async () => {
    const { api, store, id } = await previewTab([{ n: 0 }]);
    const pad = JSON.stringify({
      documents: [{ pad: 'x'.repeat(13 * 1024 * 1024) }],
      cursorHasMore: true,
    });
    const next = vi.spyOn(api.rpc.shell, 'next').mockResolvedValue({
      requestId: 'cursor',
      result: { type: 'Cursor', printableEjson: pad, hasMore: true, cursorRequestId: 'cursor' },
    } as unknown as Awaited<ReturnType<typeof api.rpc.shell.next>>);

    await store.getState().loadAllEditor(id);

    expect(next).toHaveBeenCalledTimes(2);
    expect(store.getState().editors.tabs[id]?.result).toMatchObject({
      capped: true,
      hasMore: true,
      loadingMore: false,
    });
    // A capped result fetches nothing more, even when asked.
    await store.getState().loadMoreEditor(id);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('stops Load all at the first document that has no stored copy', async () => {
    const { api, store, id } = await previewTab([{ n: 0 }]);
    const unkept = JSON.stringify({
      documents: [{ _id: 1, big: MARKER, $mgTruncated: { chars: 3_600_000 } }],
      cursorHasMore: true,
    });
    const next = vi.spyOn(api.rpc.shell, 'next').mockResolvedValue({
      requestId: 'cursor',
      result: { type: 'Cursor', printableEjson: unkept, hasMore: true, cursorRequestId: 'cursor' },
    } as unknown as Awaited<ReturnType<typeof api.rpc.shell.next>>);

    await store.getState().loadAllEditor(id);

    expect(next).toHaveBeenCalledTimes(1);
    expect(store.getState().editors.tabs[id]?.result).toMatchObject({
      capped: true,
      hasMore: true,
      loadingMore: false,
    });
  });

  it('frees the spill of the old result when the run restarts and when the tab closes', async () => {
    const { api, store, id } = await previewTab([{ n: 0 }]);
    const release = vi.spyOn(api.rpc.shell, 'releaseResult').mockRejectedValue(new Error('gone'));

    await store.getState().runEditor(id, 'db.bson_samples.find()');
    expect(release).toHaveBeenCalledWith({ requestId: 'cursor' });

    store.getState().closeEditor(id);
    expect(release).toHaveBeenCalledTimes(2);
    // The rejected release is swallowed.
    await Promise.resolve();
  });

  it('reads the full text of a document by its ref', async () => {
    const { api, store } = await previewTab([]);
    const read = vi.spyOn(api.rpc.shell, 'readDocument').mockResolvedValue('{"_id":1}');

    expect(await store.getState().readFullDocument(REF)).toBe('{"_id":1}');
    expect(read).toHaveBeenCalledWith({ ref: REF });
  });

  it('replaces a previewed row with the saved full text, which has no marker', async () => {
    const { store, id } = await previewTab([
      { _id: 7, big: MARKER, $mgTruncated: { ref: REF, chars: 3_600_000 } },
    ]);

    store.getState().replaceLoadedDocument(id, 0, '{"_id":7,"big":[1,2,3]}');

    const row = store.getState().editors.tabs[id]?.result?.documents[0];
    expect(row).toEqual({ _id: 7, big: [1, 2, 3] });
  });
});

describe('editor actions: export', () => {
  const REF = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';
  const LIMIT = 2 * 1024 * 1024;

  async function tabWith(documents: readonly unknown[]) {
    const api = await connectedMockApi();
    const store = await storeOn(api);
    const id = store
      .getState()
      .openEditor({ connectionId: localConnectionId, database: 'analytics' });
    vi.spyOn(api.rpc.shell, 'evaluate').mockResolvedValue({
      requestId: 'first',
      result: {
        type: 'Cursor',
        printableEjson: JSON.stringify({ documents, cursorHasMore: false }),
        hasMore: false,
      },
    } as unknown as Awaited<ReturnType<typeof api.rpc.shell.evaluate>>);
    await store.getState().runEditor(id, 'db.bson_samples.find()');
    return { api, store, id };
  }

  /** The text each writeExport call carried, in order. */
  function captureWrites(api: Awaited<ReturnType<typeof connectedMockApi>>) {
    const calls: { content: string; part: string | undefined }[] = [];
    vi.spyOn(api.rpc.app, 'writeExport').mockImplementation((input) => {
      calls.push({ content: input.content, part: input.part });
      return Promise.resolve();
    });
    return calls;
  }

  it('writes a small result in one call', async () => {
    const { api, store, id } = await tabWith([{ _id: 1, a: 'x' }]);
    const calls = captureWrites(api);

    await store.getState().exportResult(id, 'json');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.part).toBe('only');
    expect(JSON.parse(calls[0]?.content ?? '')).toEqual([{ _id: 1, a: 'x' }]);
  });

  it('streams more than 1 MiB in first, next and last parts under 2 MiB each', async () => {
    const docs = Array.from({ length: 12 }, (_, n) => ({ _id: n, pad: 'x'.repeat(400_000) }));
    const { api, store, id } = await tabWith(docs);
    const calls = captureWrites(api);

    await store.getState().exportResult(id, 'json');

    const parts = calls.map((call) => call.part);
    expect(parts[0]).toBe('first');
    expect(parts.at(-1)).toBe('last');
    expect(parts.slice(1, -1).every((part) => part === 'next')).toBe(true);
    expect(calls.length).toBeGreaterThan(3);
    expect(Math.max(...calls.map((call) => call.content.length))).toBeLessThan(LIMIT);
    const text = calls.map((call) => call.content).join('');
    expect(JSON.parse(text)).toEqual(docs);
  });

  it('reads each previewed document once and writes its full text', async () => {
    const preview = {
      _id: 1,
      big: { $mgTruncated: { t: 'array', n: 9 } },
      $mgTruncated: { ref: REF, chars: 40 },
    };
    const { api, store, id } = await tabWith([{ _id: 0 }, preview]);
    const calls = captureWrites(api);
    const read = vi
      .spyOn(api.rpc.shell, 'readDocument')
      .mockResolvedValue('{"_id":1,"big":[1,2,3]}');

    await store.getState().exportResult(id, 'json');

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ ref: REF });
    const text = calls.map((call) => call.content).join('');
    expect(JSON.parse(text)).toEqual([{ _id: 0 }, { _id: 1, big: [1, 2, 3] }]);
    expect(text).not.toContain('$mgTruncated');
  });

  it('exports the documents it can read and reports the ones with no stored copy', async () => {
    const kept = { _id: 1, $mgTruncated: { ref: REF, chars: 40 } };
    const unkept = { _id: 2, $mgTruncated: { chars: 40 } };
    const { api, store, id } = await tabWith([unkept, { _id: 0 }, kept, unkept]);
    const calls = captureWrites(api);
    vi.spyOn(api.rpc.shell, 'readDocument').mockResolvedValue('{"_id":1,"big":[1]}');

    const result = await store.getState().exportResult(id, 'json');

    expect(result).toEqual({ skipped: 2 });
    expect(JSON.parse(calls.map((call) => call.content).join(''))).toEqual([
      { _id: 0 },
      { _id: 1, big: [1] },
    ]);
  });

  it('takes the CSV columns from the full documents, not from their previews', async () => {
    // The preview holds only the first keys of a wide document, so a later key is no column of it.
    const preview = { _id: 1, a: 1, $mgTruncated: { ref: REF, chars: 40 } };
    const { api, store, id } = await tabWith([preview, { _id: 2, a: 2, c: 3 }]);
    const calls = captureWrites(api);
    const read = vi.spyOn(api.rpc.shell, 'readDocument').mockResolvedValue('{"_id":1,"a":1,"b":9}');

    await store.getState().exportResult(id, 'csv');

    expect(calls.map((call) => call.content).join('')).toBe('_id,a,b,c\n1,1,9,\n2,2,,3\n');
    // Once for the columns and once for the row.
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('sends abort and throws when a read fails after a part was written', async () => {
    const docs = Array.from({ length: 5 }, (_, n) => ({ _id: n, pad: 'x'.repeat(600_000) }));
    const preview = { _id: 9, $mgTruncated: { ref: REF, chars: 40 } };
    const { api, store, id } = await tabWith([...docs, preview]);
    const calls = captureWrites(api);
    vi.spyOn(api.rpc.shell, 'readDocument').mockRejectedValue(
      new AppErrorException({ code: 'NOT_FOUND', message: 'gone' }),
    );

    await expect(store.getState().exportResult(id, 'json')).rejects.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });

    expect(calls.map((call) => call.part)).toContain('first');
    expect(calls.at(-1)?.part).toBe('abort');
  });

  it('sends no abort when nothing was written yet', async () => {
    const preview = { _id: 9, $mgTruncated: { ref: REF, chars: 40 } };
    const { api, store, id } = await tabWith([preview]);
    const calls = captureWrites(api);
    vi.spyOn(api.rpc.shell, 'readDocument').mockRejectedValue(new Error('gone'));

    await expect(store.getState().exportResult(id, 'csv')).rejects.toThrow('gone');

    expect(calls).toEqual([]);
  });
});
