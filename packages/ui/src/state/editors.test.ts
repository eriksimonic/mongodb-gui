import { describe, expect, it } from 'vitest';
import {
  EMPTY_EDITORS,
  appendPage,
  appendPrint,
  appendOutput,
  beginRun,
  bumpListRevision,
  closeTab,
  convertTabToMongosh,
  finishRun,
  forgetRequest,
  layoutKeyFor,
  markTabSaved,
  openTab,
  resultFromEvaluation,
  RESIDENT_CHARS,
  restoreTabs,
  savedTabsOf,
  setActiveTab,
  setLoadingMore,
  setRuntime,
  setTabBatchSize,
  setTabDatabase,
  setTabError,
  setTabLanguage,
  setTabText,
  setTabView,
  findTab,
  SavedTabsSchema,
  LOAD_ALL_LIMIT,
  BATCH_SIZES,
  type EditorsState,
} from './editors';

const CONNECTION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const REQUEST = '33333333-3333-4333-8333-333333333333';

function withTab(id = 'tab-1', text = ''): EditorsState {
  return openTab(EMPTY_EDITORS, { id, connectionId: CONNECTION, database: 'shop', text });
}

function addTab(state: EditorsState, id: string): EditorsState {
  return openTab(state, { id, connectionId: CONNECTION, database: 'shop' });
}

describe('openTab and closeTab', () => {
  it('adds a tab, makes it active and starts it clean', () => {
    const state = withTab('a', 'db.orders.find()');
    expect(state.order).toEqual(['a']);
    expect(state.activeId).toBe('a');
    expect(state.tabs.a).toMatchObject({
      database: 'shop',
      text: 'db.orders.find()',
      savedText: 'db.orders.find()',
      batchSize: 50,
      view: 'table',
      language: 'mongosh',
      running: undefined,
      result: undefined,
    });
  });

  it('opens a tab in the language it is given', () => {
    const state = openTab(EMPTY_EDITORS, {
      id: 'a',
      connectionId: CONNECTION,
      database: 'shop',
      language: 'sql',
    });
    expect(state.tabs.a?.language).toBe('sql');
  });

  it('opens a tab as mongosh when no language is given', () => {
    expect(withTab('a').tabs.a?.language).toBe('mongosh');
  });

  it('focuses an existing tab instead of adding a second one', () => {
    let state = addTab(EMPTY_EDITORS, 'a');
    state = addTab(state, 'b');
    state = openTab(state, { id: 'a', connectionId: CONNECTION, database: 'other' });
    expect(state.order).toEqual(['a', 'b']);
    expect(state.tabs.a?.database).toBe('shop');
    expect(state.activeId).toBe('a');
  });

  it('moves the active tab to a neighbour when the active one closes', () => {
    let state = addTab(EMPTY_EDITORS, 'a');
    state = addTab(state, 'b');
    state = addTab(state, 'c');
    state = setActiveTab(state, 'b');
    state = closeTab(state, 'b');
    expect(state.order).toEqual(['a', 'c']);
    expect(state.activeId).toBe('c');
    state = closeTab(state, 'c');
    expect(state.activeId).toBe('a');
    state = closeTab(state, 'a');
    expect(state.activeId).toBeUndefined();
  });

  it('keeps the active tab when another tab closes', () => {
    let state = addTab(EMPTY_EDITORS, 'a');
    state = addTab(state, 'b');
    state = closeTab(state, 'a');
    expect(state.activeId).toBe('b');
  });

  it('ignores an unknown id', () => {
    const state = withTab('a');
    expect(closeTab(state, 'missing')).toBe(state);
    expect(setActiveTab(state, 'missing')).toBe(state);
    expect(setTabText(state, 'missing', 'x')).toBe(state);
  });

  it('drops the print routing of a closed tab', () => {
    let state = withTab('a');
    state = beginRun(state, 'a', REQUEST, 0);
    state = closeTab(state, 'a');
    expect(state.requestTabs).toEqual({});
  });

  it('finds a tab by connection and database', () => {
    const state = withTab('a');
    expect(findTab(state, CONNECTION, 'shop')?.id).toBe('a');
    expect(findTab(state, OTHER, 'shop')).toBeUndefined();
    expect(findTab(state, CONNECTION, 'billing')).toBeUndefined();
  });
});

describe('tab settings and saved text', () => {
  it('changes text, database, batch size and view', () => {
    let state = withTab('a');
    state = setTabText(state, 'a', 'db.x.find()');
    state = setTabDatabase(state, 'a', 'billing');
    state = setTabBatchSize(state, 'a', 500);
    state = setTabView(state, 'a', 'json');
    expect(state.tabs.a).toMatchObject({
      text: 'db.x.find()',
      database: 'billing',
      batchSize: 500,
      view: 'json',
    });
  });

  it('keeps the text of each language when the language changes', () => {
    let state = withTab('a', 'db.orders.find()');
    state = setTabLanguage(state, 'a', 'sql');
    expect(state.tabs.a).toMatchObject({
      language: 'sql',
      text: '',
      otherText: 'db.orders.find()',
    });
    state = setTabText(state, 'a', 'SELECT * FROM orders');
    state = setTabLanguage(state, 'a', 'mongosh');
    expect(state.tabs.a).toMatchObject({
      language: 'mongosh',
      text: 'db.orders.find()',
      otherText: 'SELECT * FROM orders',
    });
    state = setTabLanguage(state, 'a', 'sql');
    expect(state.tabs.a).toMatchObject({
      text: 'SELECT * FROM orders',
      otherText: 'db.orders.find()',
    });
  });

  it('treats the text of the new language as saved, so a switch alone leaves no unsaved mark', () => {
    let state = withTab('a', 'db.orders.find()');
    state = setTabText(state, 'a', 'db.orders.find({})');
    state = setTabLanguage(state, 'a', 'sql');
    expect(state.tabs.a?.savedText).toBe(state.tabs.a?.text);
  });

  it('clears the tab error when the language changes', () => {
    let state = setTabError(withTab('a'), 'a', { code: 'VALIDATION', message: 'old' });
    state = setTabLanguage(state, 'a', 'sql');
    expect(state.tabs.a?.error).toBeUndefined();
  });

  it('keeps the same tab object when the language does not change', () => {
    const state = withTab('a');
    expect(setTabLanguage(state, 'a', 'mongosh').tabs.a).toBe(state.tabs.a);
  });

  it('ignores a language change for an unknown tab', () => {
    const state = withTab('a');
    expect(setTabLanguage(state, 'missing', 'sql')).toBe(state);
  });

  it('keeps the language of a tab through text and view changes', () => {
    let state = setTabLanguage(withTab('a'), 'a', 'sql');
    state = setTabText(state, 'a', 'SELECT 1');
    state = setTabView(state, 'a', 'json');
    expect(state.tabs.a?.language).toBe('sql');
  });

  it('has no other text when it opens', () => {
    expect(withTab('a').tabs.a?.otherText).toBeUndefined();
  });

  it('converts a tab to mongosh in one step and keeps the SQL as its other text', () => {
    let state = setTabLanguage(withTab('a', 'db.old.find()'), 'a', 'sql');
    state = setTabText(state, 'a', 'SELECT * FROM orders');
    state = setTabError(state, 'a', { code: 'VALIDATION', message: 'old' });

    state = convertTabToMongosh(state, 'a', 'db.orders.find({})');

    expect(state.tabs.a).toMatchObject({
      language: 'mongosh',
      text: 'db.orders.find({})',
      otherText: 'SELECT * FROM orders',
      error: undefined,
    });
  });

  it('brings the SQL back when the language goes back to SQL after a conversion', () => {
    let state = setTabLanguage(withTab('a'), 'a', 'sql');
    state = setTabText(state, 'a', 'select 1 from  t');
    state = convertTabToMongosh(state, 'a', 'db.t.find({})');

    state = setTabLanguage(state, 'a', 'sql');

    expect(state.tabs.a).toMatchObject({
      language: 'sql',
      text: 'select 1 from  t',
      otherText: 'db.t.find({})',
    });
  });

  it('ignores a conversion for an unknown tab', () => {
    const state = withTab('a');
    expect(convertTabToMongosh(state, 'missing', 'y')).toBe(state);
  });

  it('saves the text of the other language and restores it', () => {
    let state = setTabLanguage(withTab('a', 'db.t.find()'), 'a', 'sql');
    state = setTabText(state, 'a', 'SELECT * FROM t');
    const saved = savedTabsOf(state, CONNECTION);
    expect(saved.tabs[0]).toEqual({
      id: 'a',
      database: 'shop',
      text: 'SELECT * FROM t',
      batchSize: 50,
      view: 'table',
      language: 'sql',
      otherText: 'db.t.find()',
    });

    const restored = restoreTabs(EMPTY_EDITORS, CONNECTION, SavedTabsSchema.parse(saved));
    expect(restored.tabs.a).toMatchObject({
      language: 'sql',
      text: 'SELECT * FROM t',
      otherText: 'db.t.find()',
    });
  });

  it('is unsaved until the text is saved', () => {
    let state = withTab('a', 'one');
    state = setTabText(state, 'a', 'two');
    expect(state.tabs.a?.savedText).toBe('one');
    state = markTabSaved(state, 'a');
    expect(state.tabs.a?.savedText).toBe('two');
  });

  it('offers the batch sizes from the spec', () => {
    expect(BATCH_SIZES).toEqual([20, 50, 100, 500]);
    expect(LOAD_ALL_LIMIT).toBe(5000);
  });

  it('keys the saved layout by connection', () => {
    expect(layoutKeyFor(CONNECTION)).toBe(`editors:${CONNECTION}`);
  });
});

describe('runs', () => {
  const cursorEvaluation = {
    requestId: REQUEST,
    result: {
      type: 'Cursor' as const,
      printableEjson: JSON.stringify({
        cursorHasMore: true,
        documents: [{ _id: { $oid: '65f0c0ffee0000000000abcd' }, status: 'paid' }],
      }),
      hasMore: true,
      cursorRequestId: REQUEST,
    },
    elapsedMs: 12,
  };

  it('starts a run and clears the previous result', () => {
    let state = withTab('a');
    state = beginRun(state, 'a', REQUEST, 100);
    expect(state.tabs.a?.running).toEqual({ requestId: REQUEST, startedAt: 100 });
    expect(state.requestTabs[REQUEST]).toBe('a');
  });

  it('builds a cursor result from the first page', () => {
    const outcome = resultFromEvaluation({
      statement: 'db.orders.find({ status: "paid" }).sort({ total: -1 })',
      database: 'shop',
      evaluation: cursorEvaluation,
    });
    expect('result' in outcome).toBe(true);
    if (!('result' in outcome)) {
      return;
    }
    expect(outcome.result).toMatchObject({
      type: 'Cursor',
      hasMore: true,
      cursorRequestId: REQUEST,
      collection: 'orders',
      elapsedMs: 12,
    });
    expect(outcome.result.documents).toHaveLength(1);
    expect(outcome.result.printableEjson).toBeUndefined();
    expect(outcome.result.chars).toBe(cursorEvaluation.result.printableEjson.length);
    expect(outcome.result.capped).toBe(false);
  });

  it('keeps the value of a non-cursor result and summarises a write', () => {
    const outcome = resultFromEvaluation({
      statement: 'db.orders.updateMany({}, {})',
      database: 'shop',
      evaluation: {
        requestId: REQUEST,
        result: {
          type: 'UpdateResult',
          printableEjson: JSON.stringify({ matchedCount: 10, modifiedCount: 10 }),
          hasMore: false,
        },
        elapsedMs: 3,
      },
    });
    expect('result' in outcome && outcome.result).toMatchObject({
      summary: 'Matched 10, modified 10',
      collection: undefined,
      documents: [],
    });
  });

  it('falls back to the raw text when a cursor batch does not parse', () => {
    const outcome = resultFromEvaluation({
      statement: 'db.orders.find()',
      database: 'shop',
      evaluation: {
        requestId: REQUEST,
        result: { type: 'Cursor', printableEjson: 'not json', hasMore: false },
        elapsedMs: 1,
      },
    });
    expect('result' in outcome && outcome.result.printableEjson).toBe('not json');
  });

  it('reports the error of an evaluation', () => {
    const outcome = resultFromEvaluation({
      statement: 'db.x.find(',
      database: 'shop',
      evaluation: {
        requestId: REQUEST,
        error: { code: 'VALIDATION', message: 'Unexpected end of input' },
        elapsedMs: 1,
      },
    });
    expect(outcome).toEqual({ error: { code: 'VALIDATION', message: 'Unexpected end of input' } });
  });

  it('reports an evaluation that has neither a result nor an error', () => {
    const outcome = resultFromEvaluation({
      statement: 'x',
      database: 'shop',
      evaluation: { requestId: REQUEST, elapsedMs: 1 },
    });
    expect('error' in outcome && outcome.error.code).toBe('INTERNAL');
  });

  it('ends a run with its result and clears the running state', () => {
    let state = beginRun(withTab('a'), 'a', REQUEST, 0);
    const outcome = resultFromEvaluation({
      statement: 'db.orders.find()',
      database: 'shop',
      evaluation: cursorEvaluation,
    });
    state = finishRun(state, 'a', outcome);
    expect(state.tabs.a?.running).toBeUndefined();
    expect(state.tabs.a?.result?.documents).toHaveLength(1);
    expect(state.tabs.a?.error).toBeUndefined();
  });

  it('ends a run with an error and keeps no result', () => {
    let state = beginRun(withTab('a'), 'a', REQUEST, 0);
    state = finishRun(state, 'a', {
      error: { code: 'CANCELLED', message: 'The operation was cancelled' },
    });
    expect(state.tabs.a?.error?.code).toBe('CANCELLED');
    expect(state.tabs.a?.result).toBeUndefined();
  });

  it('appends a later page and moves the cursor on', () => {
    let state = beginRun(withTab('a'), 'a', REQUEST, 0);
    state = finishRun(
      state,
      'a',
      resultFromEvaluation({
        statement: 'db.orders.find()',
        database: 'shop',
        evaluation: cursorEvaluation,
      }),
    );
    state = setLoadingMore(state, 'a', true);
    expect(state.tabs.a?.result?.loadingMore).toBe(true);
    state = appendPage(state, 'a', {
      documents: [{ status: 'open' }, { status: 'closed' }],
      hasMore: false,
      cursorRequestId: undefined,
      chars: 100,
    });
    expect(state.tabs.a?.result).toMatchObject({
      documents: [
        { _id: { $oid: '65f0c0ffee0000000000abcd' }, status: 'paid' },
        { status: 'open' },
        { status: 'closed' },
      ],
      hasMore: false,
      cursorRequestId: undefined,
      loadingMore: false,
      capped: false,
    });
    expect(state.tabs.a?.result?.chars).toBe(cursorEvaluation.result.printableEjson.length + 100);
  });

  it('stops asking for more once the loaded text reaches the resident limit', () => {
    let state = beginRun(withTab('a'), 'a', REQUEST, 0);
    state = finishRun(
      state,
      'a',
      resultFromEvaluation({
        statement: 'db.orders.find()',
        database: 'shop',
        evaluation: cursorEvaluation,
      }),
    );
    const first = state.tabs.a?.result?.chars ?? 0;
    state = appendPage(state, 'a', {
      documents: [{ n: 1 }],
      hasMore: true,
      cursorRequestId: REQUEST,
      chars: RESIDENT_CHARS - first - 1,
    });
    expect(state.tabs.a?.result).toMatchObject({ hasMore: true, capped: false });
    state = appendPage(state, 'a', {
      documents: [{ n: 2 }],
      hasMore: true,
      cursorRequestId: REQUEST,
      chars: 1,
    });
    // The cursor still has documents, so the result must not claim to be whole.
    expect(state.tabs.a?.result).toMatchObject({
      hasMore: true,
      capped: true,
      chars: RESIDENT_CHARS,
    });
  });

  it('ignores a page when no result is open', () => {
    const state = withTab('a');
    const next = appendPage(state, 'a', {
      documents: [{}],
      hasMore: false,
      cursorRequestId: undefined,
      chars: 2,
    });
    expect(next.tabs.a).toBe(state.tabs.a);
  });

  it('keeps a paging error with the result', () => {
    let state = finishRun(
      withTab('a'),
      'a',
      resultFromEvaluation({
        statement: 'db.orders.find()',
        database: 'shop',
        evaluation: cursorEvaluation,
      }),
    );
    state = setLoadingMore(state, 'a', true);
    state = setTabError(state, 'a', { code: 'CANCELLED', message: 'The cursor is closed.' });
    expect(state.tabs.a?.error?.message).toBe('The cursor is closed.');
    expect(state.tabs.a?.result?.loadingMore).toBe(false);
    expect(setTabError(state, 'a', undefined).tabs.a?.error).toBeUndefined();
  });
});

describe('output and runtime', () => {
  it('routes a print line to the tab that owns the request', () => {
    let state = beginRun(withTab('a'), 'a', REQUEST, 0);
    state = appendPrint(state, REQUEST, 'hi', { id: 'l1', at: '2026-01-01T00:00:00.000Z' });
    expect(state.output).toEqual([
      { id: 'l1', at: '2026-01-01T00:00:00.000Z', tabId: 'a', kind: 'print', text: 'hi' },
    ]);
  });

  it('keeps a print line without a tab when the request is unknown', () => {
    const state = appendPrint(withTab('a'), 'unknown', 'x', { id: 'l2', at: 'now' });
    expect(state.output[0]?.tabId).toBeUndefined();
  });

  it('caps the output and drops the oldest lines', () => {
    let state = EMPTY_EDITORS;
    for (let index = 0; index < 510; index += 1) {
      state = appendOutput(state, {
        id: `l${index}`,
        at: 'now',
        tabId: undefined,
        kind: 'info',
        text: 'x',
      });
    }
    expect(state.output).toHaveLength(500);
    expect(state.output[0]?.id).toBe('l10');
  });

  it('forgets a finished request so its late prints have no tab', () => {
    let state = beginRun(withTab('a'), 'a', REQUEST, 0);
    state = forgetRequest(state, REQUEST);
    expect(
      appendPrint(state, REQUEST, 'late', { id: 'l', at: 'now' }).output[0]?.tabId,
    ).toBeUndefined();
  });

  it('stores the runtime state per connection and moves the list revision', () => {
    let state = setRuntime(EMPTY_EDITORS, CONNECTION, 'busy');
    expect(state.runtime[CONNECTION]).toBe('busy');
    state = bumpListRevision(state);
    expect(state.listRevision).toBe(1);
  });
});

describe('saving and restoring tabs', () => {
  it('saves only the tabs of one connection', () => {
    let state = openTab(EMPTY_EDITORS, {
      id: 'a',
      connectionId: CONNECTION,
      database: 'shop',
      text: 'db.a.find()',
      view: 'tree',
    });
    state = openTab(state, { id: 'b', connectionId: OTHER, database: 'billing' });
    expect(savedTabsOf(state, CONNECTION)).toEqual({
      tabs: [
        {
          id: 'a',
          database: 'shop',
          text: 'db.a.find()',
          batchSize: 50,
          view: 'tree',
          language: 'mongosh',
        },
      ],
    });
  });

  it('saves the language of each tab', () => {
    let state = openTab(EMPTY_EDITORS, {
      id: 'a',
      connectionId: CONNECTION,
      database: 'shop',
      language: 'sql',
    });
    state = addTab(state, 'b');
    const saved = savedTabsOf(state, CONNECTION).tabs;
    expect(saved.map((tab) => tab.language)).toEqual(['sql', 'mongosh']);
  });

  it('drops the active id when it is not one of the saved tabs', () => {
    const state = openTab(EMPTY_EDITORS, { id: 'a', connectionId: OTHER, database: 'shop' });
    expect(savedTabsOf(state, CONNECTION)).toEqual({ tabs: [] });
  });

  it('restores saved tabs clean, without duplicating an open one', () => {
    const saved = SavedTabsSchema.parse({
      tabs: [
        { id: 'a', database: 'shop', text: 'db.a.find()', batchSize: 100, view: 'json' },
        { id: 'b', database: 'billing', text: '', batchSize: 20, view: 'table' },
      ],
      activeId: 'b',
    });
    let state = withTab('a', 'open already');
    state = restoreTabs(state, CONNECTION, saved);
    expect(state.order).toEqual(['a', 'b']);
    expect(state.tabs.a?.text).toBe('open already');
    expect(state.tabs.b).toMatchObject({ database: 'billing', batchSize: 20, savedText: '' });
    expect(state.activeId).toBe('b');
  });

  it('restores the saved language of a tab', () => {
    const saved = SavedTabsSchema.parse({
      tabs: [
        {
          id: 'a',
          database: 'shop',
          text: 'SELECT 1',
          batchSize: 50,
          view: 'table',
          language: 'sql',
        },
      ],
    });
    const state = restoreTabs(EMPTY_EDITORS, CONNECTION, saved);
    expect(state.tabs.a?.language).toBe('sql');
  });

  it('restores a tab saved before the language existed as mongosh', () => {
    const saved = SavedTabsSchema.parse({
      tabs: [{ id: 'a', database: 'shop', text: 'db.a.find()', batchSize: 50, view: 'table' }],
    });
    expect(saved.tabs[0]?.language).toBe('mongosh');
    expect(restoreTabs(EMPTY_EDITORS, CONNECTION, saved).tabs.a?.language).toBe('mongosh');
  });

  it('rejects a saved language that is not offered', () => {
    expect(
      SavedTabsSchema.safeParse({
        tabs: [{ id: 'a', database: 'x', text: '', batchSize: 50, view: 'table', language: 'js' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a saved batch size that is not offered', () => {
    expect(
      SavedTabsSchema.safeParse({
        tabs: [{ id: 'a', database: 'x', text: '', batchSize: 7, view: 'table' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a saved view that is not offered', () => {
    expect(
      SavedTabsSchema.safeParse({
        tabs: [{ id: 'a', database: 'x', text: '', batchSize: 50, view: 'chart' }],
      }).success,
    ).toBe(false);
  });
});
