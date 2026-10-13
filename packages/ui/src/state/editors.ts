import {
  appError,
  EditorLanguageSchema,
  isUnkeptPreview,
  type AppError,
  type EditorLanguage,
  type ShellEvaluation,
  type ShellResultType,
  type ShellRuntimeState,
} from '@mongo-gui/core';
import { z } from 'zod';
import { collectionOfFind, parseCursorBatch, summariseResult, type JsonObject } from '../results';

export type ResultView = 'table' | 'tree' | 'json';

export const BATCH_SIZES = [20, 50, 100, 500] as const;
export type BatchSize = (typeof BATCH_SIZES)[number];
export const DEFAULT_BATCH_SIZE: BatchSize = 50;
/** Most documents "Load all" fetches in one go. */
export const LOAD_ALL_LIMIT = 5000;
/** Characters of result text one tab keeps. Load more and Load all stop here. */
export const RESIDENT_CHARS = 24 * 1024 * 1024;
const OUTPUT_LIMIT = 500;
const CURSOR_TYPES: ReadonlySet<ShellResultType> = new Set([
  'Cursor',
  'AggregationCursor',
  'CursorIterationResult',
]);

/** The result of one run. Cursor results hold the documents read so far. */
export interface ResultSet {
  readonly requestId: string;
  readonly statement: string;
  readonly database: string;
  readonly type: ShellResultType;
  readonly documents: readonly JsonObject[];
  readonly hasMore: boolean;
  /** Pass as the requestId of `next` to read the following batch. */
  readonly cursorRequestId: string | undefined;
  /** Canonical EJSON of a non-cursor value. Cursor results leave it unset. */
  readonly printableEjson: string | undefined;
  /** One line such as "Inserted 3", for a write result. */
  readonly summary: string | undefined;
  readonly elapsedMs: number;
  /** The collection a plain find reads. Editing a row needs it. */
  readonly collection: string | undefined;
  readonly loadingMore: boolean;
  /** Characters of cursor batch text loaded so far. Previews count at their shortened size. */
  readonly chars: number;
  /**
   * True once the loaded text reached RESIDENT_CHARS, or a document came with no stored copy of
   * its full text, so no more is fetched.
   */
  readonly capped: boolean;
}

export interface RunState {
  readonly requestId: string;
  readonly startedAt: number;
}

export interface EditorTab {
  readonly id: string;
  readonly connectionId: string;
  readonly database: string;
  readonly text: string;
  /** The text as last saved as a favourite, or as opened. The tab is unsaved when the two differ. */
  readonly savedText: string;
  readonly batchSize: BatchSize;
  readonly view: ResultView;
  /** Whether the text is mongosh or SQL. SQL is translated before it runs. */
  readonly language: EditorLanguage;
  /**
   * The text of the language the tab does not show, kept so a switch back finds it. A switch swaps
   * `text` and `otherText`, so the mongosh and the SQL of a tab never overwrite each other.
   */
  readonly otherText?: string | undefined;
  readonly running: RunState | undefined;
  readonly result: ResultSet | undefined;
  readonly error: AppError | undefined;
}

export interface PrintLine {
  readonly id: string;
  /** ISO time the line arrived. */
  readonly at: string;
  readonly tabId: string | undefined;
  readonly kind: 'print' | 'error' | 'info';
  readonly text: string;
}

export interface EditorsState {
  readonly tabs: Readonly<Record<string, EditorTab>>;
  /** Tab ids in the order they were opened. */
  readonly order: readonly string[];
  readonly activeId: string | undefined;
  readonly output: readonly PrintLine[];
  /** Maps a running request to its tab, so print lines land in the right place. */
  readonly requestTabs: Readonly<Record<string, string>>;
  readonly runtime: Readonly<Record<string, ShellRuntimeState>>;
  /** Moves when a history or favourite changes, so the panels reload. */
  readonly listRevision: number;
  /**
   * Moves on every activate request, even one for the tab that is already active. The shell brings
   * the panel to the front on each move, which matters when another panel kind has the focus.
   */
  readonly focusRevision: number;
}

export const EMPTY_EDITORS: EditorsState = {
  tabs: {},
  order: [],
  activeId: undefined,
  output: [],
  requestTabs: {},
  runtime: {},
  listRevision: 0,
  focusRevision: 0,
};

/** The part of a tab that is saved between launches. */
export const SavedTabSchema = z.object({
  id: z.string().min(1).max(64),
  database: z.string().min(1),
  text: z.string().max(200_000),
  batchSize: z.union([z.literal(20), z.literal(50), z.literal(100), z.literal(500)]),
  view: z.enum(['table', 'tree', 'json']),
  language: EditorLanguageSchema.default('mongosh'),
  otherText: z.string().max(200_000).optional(),
});

export const SavedTabsSchema = z.object({
  tabs: z.array(SavedTabSchema).max(50),
  activeId: z.string().optional(),
});

export type SavedTab = z.infer<typeof SavedTabSchema>;
export type SavedTabs = z.infer<typeof SavedTabsSchema>;

export function layoutKeyFor(connectionId: string): string {
  return `editors:${connectionId}`;
}

export function tabsOfConnection(state: EditorsState, connectionId: string): EditorTab[] {
  return state.order
    .map((id) => state.tabs[id])
    .filter((tab): tab is EditorTab => tab !== undefined && tab.connectionId === connectionId);
}

/** The open tab for a connection and database, or undefined. */
export function findTab(
  state: EditorsState,
  connectionId: string,
  database: string,
): EditorTab | undefined {
  return tabsOfConnection(state, connectionId).find((tab) => tab.database === database);
}

export interface OpenTabInput {
  readonly id: string;
  readonly connectionId: string;
  readonly database: string;
  readonly text?: string;
  readonly batchSize?: BatchSize;
  readonly view?: ResultView;
  /** Defaults to mongosh. */
  readonly language?: EditorLanguage;
  /** The text of the other language. See `EditorTab.otherText`. */
  readonly otherText?: string | undefined;
}

/** Adds a tab and makes it active. An existing tab with the same id is left as it is. */
export function openTab(state: EditorsState, input: OpenTabInput): EditorsState {
  if (state.tabs[input.id] !== undefined) {
    return { ...state, activeId: input.id };
  }
  const text = input.text ?? '';
  const tab: EditorTab = {
    id: input.id,
    connectionId: input.connectionId,
    database: input.database,
    text,
    savedText: text,
    batchSize: input.batchSize ?? DEFAULT_BATCH_SIZE,
    view: input.view ?? 'table',
    language: input.language ?? 'mongosh',
    otherText: input.otherText,
    running: undefined,
    result: undefined,
    error: undefined,
  };
  return {
    ...state,
    tabs: { ...state.tabs, [tab.id]: tab },
    order: [...state.order, tab.id],
    activeId: tab.id,
  };
}

function updateTab(
  state: EditorsState,
  id: string,
  update: (tab: EditorTab) => EditorTab,
): EditorsState {
  const tab = state.tabs[id];
  if (tab === undefined) {
    return state;
  }
  return { ...state, tabs: { ...state.tabs, [id]: update(tab) } };
}

/** Removes a tab and its print routing. The active tab moves to its neighbour. */
export function closeTab(state: EditorsState, id: string): EditorsState {
  if (state.tabs[id] === undefined) {
    return state;
  }
  const index = state.order.indexOf(id);
  const order = state.order.filter((item) => item !== id);
  const tabs = Object.fromEntries(Object.entries(state.tabs).filter(([key]) => key !== id));
  const requestTabs = Object.fromEntries(
    Object.entries(state.requestTabs).filter(([, tabId]) => tabId !== id),
  );
  const neighbour = order[Math.min(index, order.length - 1)];
  const activeId = state.activeId === id ? neighbour : state.activeId;
  return { ...state, tabs, order, requestTabs, activeId };
}

export function setActiveTab(state: EditorsState, id: string): EditorsState {
  return state.tabs[id] === undefined
    ? state
    : { ...state, activeId: id, focusRevision: state.focusRevision + 1 };
}

export function setTabText(state: EditorsState, id: string, text: string): EditorsState {
  return updateTab(state, id, (tab) => (tab.text === text ? tab : { ...tab, text }));
}

export function setTabDatabase(state: EditorsState, id: string, database: string): EditorsState {
  return updateTab(state, id, (tab) => ({ ...tab, database }));
}

export function setTabBatchSize(
  state: EditorsState,
  id: string,
  batchSize: BatchSize,
): EditorsState {
  return updateTab(state, id, (tab) => ({ ...tab, batchSize }));
}

export function setTabView(state: EditorsState, id: string, view: ResultView): EditorsState {
  return updateTab(state, id, (tab) => ({ ...tab, view }));
}

/**
 * Switches the tab between mongosh and SQL. The text of the language it leaves is kept as
 * `otherText`, and the text of the language it enters comes back, empty when it has none. The
 * result stays as it is. The new text counts as saved, so the switch does not mark the tab unsaved.
 */
export function setTabLanguage(
  state: EditorsState,
  id: string,
  language: EditorLanguage,
): EditorsState {
  return updateTab(state, id, (tab) => {
    if (tab.language === language) {
      return tab;
    }
    const text = tab.otherText ?? '';
    return { ...tab, language, text, savedText: text, otherText: tab.text, error: undefined };
  });
}

/**
 * Switches the tab from SQL to mongosh with the translation. The text becomes the mongosh, and the
 * SQL moves to `otherText`, so switching back to SQL finds it. The tab error clears.
 */
export function convertTabToMongosh(
  state: EditorsState,
  id: string,
  mongosh: string,
): EditorsState {
  return updateTab(state, id, (tab) => ({
    ...tab,
    text: mongosh,
    language: 'mongosh',
    otherText: tab.text,
    error: undefined,
  }));
}

/** Marks the text as saved, which clears the unsaved indicator. */
export function markTabSaved(state: EditorsState, id: string): EditorsState {
  return updateTab(state, id, (tab) => ({ ...tab, savedText: tab.text }));
}

/** Starts a run. The previous result and error are cleared, and the request owns the prints. */
export function beginRun(
  state: EditorsState,
  id: string,
  requestId: string,
  startedAt: number,
): EditorsState {
  const next = updateTab(state, id, (tab) => ({
    ...tab,
    running: { requestId, startedAt },
    result: undefined,
    error: undefined,
  }));
  return { ...next, requestTabs: { ...next.requestTabs, [requestId]: id } };
}

/** The result set of an evaluation, or the error it ended with. Pure, so tests can call it. */
export function resultFromEvaluation(input: {
  readonly statement: string;
  readonly database: string;
  readonly evaluation: ShellEvaluation;
}): { readonly result: ResultSet } | { readonly error: AppError } {
  const { evaluation } = input;
  if (evaluation.error !== undefined) {
    return { error: evaluation.error };
  }
  const shell = evaluation.result;
  if (shell === undefined) {
    return { error: appError('INTERNAL', 'The shell gave no result.') };
  }
  const isCursor = CURSOR_TYPES.has(shell.type);
  const batch = isCursor ? parseCursorBatch(shell.printableEjson) : undefined;
  return {
    result: {
      requestId: evaluation.requestId,
      statement: input.statement,
      database: input.database,
      type: shell.type,
      documents: batch?.documents ?? [],
      hasMore: shell.hasMore,
      cursorRequestId: shell.cursorRequestId,
      printableEjson: batch === undefined ? shell.printableEjson : undefined,
      summary: isCursor ? undefined : summariseResult(shell.type, shell.printableEjson),
      elapsedMs: evaluation.elapsedMs,
      collection: shell.type === 'Cursor' ? collectionOfFind(input.statement) : undefined,
      loadingMore: false,
      chars: batch === undefined ? 0 : shell.printableEjson.length,
      capped: batch?.documents.some(isUnkeptPreview) ?? false,
    },
  };
}

/** Ends a run with its result, or with the error it stopped on. */
export function finishRun(
  state: EditorsState,
  id: string,
  outcome: { readonly result: ResultSet } | { readonly error: AppError },
): EditorsState {
  return updateTab(state, id, (tab) => ({
    ...tab,
    running: undefined,
    result: 'result' in outcome ? outcome.result : undefined,
    error: 'error' in outcome ? outcome.error : undefined,
  }));
}

/**
 * Appends the documents of a later batch. The batch's cursor id replaces the earlier one. The
 * result stops asking for more once its text reaches RESIDENT_CHARS, and `capped` says so while
 * `hasMore` keeps the truth about the cursor.
 */
export function appendPage(
  state: EditorsState,
  id: string,
  batch: {
    readonly documents: readonly JsonObject[];
    readonly hasMore: boolean;
    readonly cursorRequestId: string | undefined;
    /** Length of the batch's printable text. */
    readonly chars: number;
  },
): EditorsState {
  return updateTab(state, id, (tab) => {
    if (tab.result === undefined) {
      return tab;
    }
    const chars = tab.result.chars + batch.chars;
    const capped = chars >= RESIDENT_CHARS || batch.documents.some(isUnkeptPreview);
    return {
      ...tab,
      result: {
        ...tab.result,
        documents: [...tab.result.documents, ...batch.documents],
        chars,
        capped: tab.result.capped || capped,
        // The cursor still has documents when the cap hits, so the result must not claim to be whole.
        hasMore: batch.hasMore,
        cursorRequestId: batch.cursorRequestId,
        loadingMore: false,
      },
    };
  });
}

export function setLoadingMore(state: EditorsState, id: string, loading: boolean): EditorsState {
  return updateTab(state, id, (tab) =>
    tab.result === undefined ? tab : { ...tab, result: { ...tab.result, loadingMore: loading } },
  );
}

/** Changes one loaded document of a result, such as after an inline edit. */
export function patchDocument(
  state: EditorsState,
  id: string,
  index: number,
  change: (document: JsonObject) => JsonObject,
): EditorsState {
  return updateTab(state, id, (tab) => {
    const result = tab.result;
    if (result === undefined || result.documents[index] === undefined) {
      return tab;
    }
    const documents = result.documents.map((document, position) =>
      position === index ? change(document) : document,
    );
    return { ...tab, result: { ...result, documents } };
  });
}

/** Shows an error that happened after the first page, such as a failed "Load more". */
export function setTabError(
  state: EditorsState,
  id: string,
  error: AppError | undefined,
): EditorsState {
  return updateTab(state, id, (tab) => ({
    ...tab,
    error,
    result: tab.result === undefined ? undefined : { ...tab.result, loadingMore: false },
  }));
}

/** Adds an output line. The oldest lines drop once the list is full. */
export function appendOutput(state: EditorsState, line: PrintLine): EditorsState {
  const output = [...state.output, line];
  return {
    ...state,
    output: output.length > OUTPUT_LIMIT ? output.slice(output.length - OUTPUT_LIMIT) : output,
  };
}

/** Routes a print line to the tab that owns the request. Lines from unknown requests keep no tab. */
export function appendPrint(
  state: EditorsState,
  requestId: string,
  text: string,
  line: { readonly id: string; readonly at: string },
): EditorsState {
  return appendOutput(state, {
    id: line.id,
    at: line.at,
    tabId: state.requestTabs[requestId],
    kind: 'print',
    text,
  });
}

export function setRuntime(
  state: EditorsState,
  connectionId: string,
  runtime: ShellRuntimeState,
): EditorsState {
  return { ...state, runtime: { ...state.runtime, [connectionId]: runtime } };
}

export function bumpListRevision(state: EditorsState): EditorsState {
  return { ...state, listRevision: state.listRevision + 1 };
}

/** Forgets the request routing of a finished run. */
export function forgetRequest(state: EditorsState, requestId: string): EditorsState {
  const requestTabs = Object.fromEntries(
    Object.entries(state.requestTabs).filter(([id]) => id !== requestId),
  );
  return { ...state, requestTabs };
}

/** The tabs of one connection as they are saved. Results and running state are not saved. */
export function savedTabsOf(state: EditorsState, connectionId: string): SavedTabs {
  const tabs = tabsOfConnection(state, connectionId).map((tab) => ({
    id: tab.id,
    database: tab.database,
    text: tab.text,
    batchSize: tab.batchSize,
    view: tab.view,
    language: tab.language,
    ...(tab.otherText === undefined ? {} : { otherText: tab.otherText }),
  }));
  const active = state.activeId !== undefined && tabs.some((tab) => tab.id === state.activeId);
  return active ? { tabs, activeId: state.activeId } : { tabs };
}

/**
 * Restores saved tabs of a connection. Tabs whose id is already open are skipped, so a restore
 * never duplicates a tab. The saved text is the saved state, so the tabs start clean.
 */
export function restoreTabs(
  state: EditorsState,
  connectionId: string,
  saved: SavedTabs,
): EditorsState {
  let next = state;
  for (const tab of saved.tabs) {
    if (next.tabs[tab.id] !== undefined) {
      continue;
    }
    next = openTab(next, {
      id: tab.id,
      connectionId,
      database: tab.database,
      text: tab.text,
      batchSize: tab.batchSize,
      view: tab.view,
      language: tab.language,
      otherText: tab.otherText,
    });
  }
  const activeId = saved.activeId;
  return activeId !== undefined && next.tabs[activeId] !== undefined ? { ...next, activeId } : next;
}
