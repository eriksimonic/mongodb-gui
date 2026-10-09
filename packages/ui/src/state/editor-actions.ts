import {
  AppErrorException,
  appError,
  newId,
  toAppError,
  type AppError,
  type RpcClient,
  type ShellEvaluation,
  type ShellRuntimeState,
} from '@mongo-gui/core';
import { editorUiEvents } from '../editor/editor-events';
import {
  isPlainObject,
  parseCursorBatch,
  parseEjson,
  type JsonObject,
} from '../results/result-model';
import { withoutPath, withValueAtPath } from '../results/document-path';
import {
  appendOutput,
  appendPage,
  appendPrint,
  beginRun,
  patchDocument,
  bumpListRevision,
  closeTab,
  findTab,
  finishRun,
  forgetRequest,
  layoutKeyFor,
  LOAD_ALL_LIMIT,
  markTabSaved,
  openTab,
  resultFromEvaluation,
  restoreTabs,
  savedTabsOf,
  SavedTabsSchema,
  setActiveTab,
  setLoadingMore,
  setRuntime,
  setTabBatchSize,
  setTabDatabase,
  setTabError,
  setTabText,
  setTabView,
  type BatchSize,
  type EditorsState,
  type ResultView,
} from './editors';

/** Batch size of "Load all". Each call reads this many documents, up to LOAD_ALL_LIMIT in all. */
const LOAD_ALL_BATCH = 500;
/** The largest batch the runtime accepts for one `next` call. */
const NEXT_BATCH_LIMIT = 1000;

/** What the editor actions need from the store. */
export interface EditorStoreAccess {
  readonly rpc: RpcClient;
  readonly get: () => { readonly editors: EditorsState };
  readonly update: (update: (editors: EditorsState) => EditorsState) => void;
}

export interface OpenEditorInput {
  readonly connectionId: string;
  readonly database: string;
  /** Opens a second tab even when one is open for the same database. */
  readonly newTab?: boolean | undefined;
}

export interface SaveFavouriteInput extends CodeTarget {
  readonly name: string;
  readonly folder?: string | undefined;
  /** The tab to mark saved, when the code came from one. */
  readonly tabId?: string | undefined;
}

export interface FieldEdit {
  readonly tabId: string;
  /** Index of the document in the loaded result. */
  readonly documentIndex: number;
  /** Dotted path of the field, such as `customer.address.city`. */
  readonly path: string;
  /** The new canonical EJSON value. Ignored when `unset` is true. */
  readonly value?: unknown;
  readonly unset?: boolean;
}

export interface CodeTarget {
  readonly connectionId: string;
  readonly database: string;
  readonly code: string;
}

type PageOutcome =
  | {
      readonly documents: readonly JsonObject[];
      readonly hasMore: boolean;
      readonly cursorRequestId: string | undefined;
    }
  | { readonly error: AppError };

/**
 * Builds the editor actions of the store. Each action reads the editors slice, calls the backend,
 * and writes the slice back through `update`. Failures show in the tab or the output, not as a throw.
 */
export function createEditorActions(access: EditorStoreAccess) {
  const { rpc, update } = access;
  // Connections whose saved tabs were read this session. Saving waits for the read, so an empty
  // slice cannot overwrite the saved tabs.
  const restored = new Set<string>();

  function reportLine(kind: 'error' | 'info', text: string, tabId?: string): void {
    update((state) =>
      appendOutput(state, {
        id: newId(),
        at: new Date().toISOString(),
        tabId,
        kind,
        text,
      }),
    );
  }

  function openEditor(input: OpenEditorInput): string {
    const existing =
      input.newTab === true
        ? undefined
        : findTab(access.get().editors, input.connectionId, input.database);
    if (existing !== undefined) {
      update((state) => setActiveTab(state, existing.id));
      return existing.id;
    }
    const id = newId();
    update((state) =>
      openTab(state, { id, connectionId: input.connectionId, database: input.database }),
    );
    return id;
  }

  async function runEditor(id: string, text: string): Promise<void> {
    const tab = access.get().editors.tabs[id];
    if (tab === undefined || tab.running !== undefined || text.trim() === '') {
      return;
    }
    const requestId = newId();
    const startedAt = Date.now();
    update((state) => beginRun(state, id, requestId, startedAt));
    let evaluation: ShellEvaluation;
    try {
      evaluation = await rpc.shell.evaluate({
        connectionId: tab.connectionId,
        requestId,
        database: tab.database,
        code: text,
        batchSize: tab.batchSize,
      });
    } catch (failure) {
      evaluation = { requestId, error: toAppError(failure), elapsedMs: Date.now() - startedAt };
    }
    const outcome = resultFromEvaluation({ statement: text, database: tab.database, evaluation });
    update((state) => finishRun(forgetRequest(state, requestId), id, outcome));
    if ('error' in outcome) {
      reportLine('error', outcome.error.message, id);
    }
    await recordHistory({
      connectionId: tab.connectionId,
      database: tab.database,
      code: text,
      startedAt,
      durationMs: evaluation.elapsedMs,
      resultCount:
        'result' in outcome ? countOf(outcome.result.documents, outcome.result.type) : undefined,
      error: evaluation.error,
    });
  }

  async function recordHistory(input: {
    readonly connectionId: string;
    readonly database: string;
    readonly code: string;
    readonly startedAt: number;
    readonly durationMs: number;
    readonly resultCount: number | undefined;
    readonly error: AppError | undefined;
  }): Promise<void> {
    try {
      await rpc.history.append({
        connectionId: input.connectionId,
        database: input.database,
        code: input.code,
        startedAt: new Date(input.startedAt).toISOString(),
        durationMs: input.durationMs,
        ...(input.resultCount === undefined ? {} : { resultCount: input.resultCount }),
        ...(input.error === undefined ? {} : { error: input.error }),
      });
      update((state) => bumpListRevision(state));
    } catch (failure) {
      reportLine('error', `The run was not saved to history. ${toAppError(failure).message}`);
    }
  }

  async function nextPage(
    connectionId: string,
    requestId: string,
    batchSize: number,
  ): Promise<PageOutcome> {
    try {
      const evaluation = await rpc.shell.next({ connectionId, requestId, batchSize });
      if (evaluation.error !== undefined) {
        return { error: evaluation.error };
      }
      const batch =
        evaluation.result === undefined
          ? undefined
          : parseCursorBatch(evaluation.result.printableEjson);
      if (evaluation.result === undefined || batch === undefined) {
        return { error: { code: 'INTERNAL', message: 'The next batch could not be read.' } };
      }
      return {
        documents: batch.documents,
        hasMore: evaluation.result.hasMore,
        cursorRequestId: evaluation.result.cursorRequestId,
      };
    } catch (failure) {
      return { error: toAppError(failure) };
    }
  }

  /** Reads batches after the first page. "batch" reads one, "all" reads up to LOAD_ALL_LIMIT documents. */
  async function readPages(id: string, mode: 'batch' | 'all'): Promise<void> {
    const tab = access.get().editors.tabs[id];
    const result = tab?.result;
    if (
      tab === undefined ||
      result === undefined ||
      result.loadingMore ||
      tab.running !== undefined
    ) {
      return;
    }
    if (result.cursorRequestId === undefined || !result.hasMore) {
      return;
    }
    update((state) => setLoadingMore(state, id, true));
    const batchSize = mode === 'all' ? LOAD_ALL_BATCH : Math.min(tab.batchSize, NEXT_BATCH_LIMIT);
    let loaded = result.documents.length;
    let cursor: string | undefined = result.cursorRequestId;
    let more = true;
    while (more && cursor !== undefined) {
      const page = await nextPage(tab.connectionId, cursor, batchSize);
      if ('error' in page) {
        update((state) => setTabError(state, id, page.error));
        return;
      }
      loaded += page.documents.length;
      more = page.hasMore;
      cursor = page.cursorRequestId;
      update((state) =>
        appendPage(state, id, {
          documents: page.documents,
          hasMore: page.hasMore,
          cursorRequestId: page.cursorRequestId,
        }),
      );
      if (mode === 'batch' || loaded >= LOAD_ALL_LIMIT) {
        break;
      }
    }
    update((state) => setLoadingMore(state, id, false));
  }

  async function restoreEditors(connectionId: string): Promise<void> {
    if (restored.has(connectionId)) {
      return;
    }
    restored.add(connectionId);
    let raw: unknown;
    try {
      raw = await rpc.layout.get({ key: layoutKeyFor(connectionId) });
    } catch {
      // Without the saved tabs the connection starts with none open.
      return;
    }
    const parsed = SavedTabsSchema.safeParse(raw);
    if (parsed.success) {
      update((state) => restoreTabs(state, connectionId, parsed.data));
    }
  }

  async function persistEditors(connectionId: string): Promise<void> {
    if (!restored.has(connectionId)) {
      return;
    }
    const value = savedTabsOf(access.get().editors, connectionId);
    try {
      await rpc.layout.set({ key: layoutKeyFor(connectionId), value });
    } catch {
      // The layout is a convenience. A failed save does not interrupt editing, and the next change retries.
    }
  }

  return {
    openEditor,

    activateEditor(id: string): void {
      update((state) => setActiveTab(state, id));
    },

    closeEditor(id: string): void {
      update((state) => closeTab(state, id));
    },

    setEditorText(id: string, text: string): void {
      update((state) => setTabText(state, id, text));
    },

    setEditorDatabase(id: string, database: string): void {
      update((state) => setTabDatabase(state, id, database));
    },

    setEditorBatchSize(id: string, batchSize: BatchSize): void {
      update((state) => setTabBatchSize(state, id, batchSize));
    },

    setEditorView(id: string, view: ResultView): void {
      update((state) => setTabView(state, id, view));
    },

    /** Runs the text the caller picked: the selection, the statement, or the whole tab. */
    runEditor,

    /** Asks the runtime to stop a run. The run ends with a CANCELLED error when it stops. */
    async cancelEditor(id: string): Promise<void> {
      const tab = access.get().editors.tabs[id];
      if (tab?.running === undefined) {
        return;
      }
      await rpc.shell.cancel({ connectionId: tab.connectionId, requestId: tab.running.requestId });
    },

    loadMoreEditor(id: string): Promise<void> {
      return readPages(id, 'batch');
    },

    loadAllEditor(id: string): Promise<void> {
      return readPages(id, 'all');
    },

    /**
     * Writes one field of a loaded document with `$set`, or removes it with `$unset`, and updates the
     * loaded copy. Throws when the result is not a plain find on one collection, or the write fails.
     */
    async editField(edit: FieldEdit): Promise<void> {
      const tab = access.get().editors.tabs[edit.tabId];
      const result = tab?.result;
      const document = result?.documents[edit.documentIndex];
      if (
        tab === undefined ||
        result?.collection === undefined ||
        document === undefined ||
        !('_id' in document)
      ) {
        throw new AppErrorException(appError('VALIDATION', 'This result cannot be edited.'));
      }
      const target = {
        connectionId: tab.connectionId,
        database: result.database,
        collection: result.collection,
      };
      const idEjson = JSON.stringify(document._id);
      if (edit.unset === true) {
        await rpc.management.updateDocumentFields({ ...target, idEjson, unsetPaths: [edit.path] });
      } else {
        await rpc.management.updateDocumentFields({
          ...target,
          idEjson,
          setEjson: JSON.stringify({ [edit.path]: edit.value }),
        });
      }
      update((state) =>
        patchDocument(state, edit.tabId, edit.documentIndex, (current) =>
          edit.unset === true
            ? withoutPath(current, edit.path)
            : withValueAtPath(current, edit.path, edit.value),
        ),
      );
    },

    /** Replaces a loaded document with the EJSON the editor dialog saved. */
    replaceLoadedDocument(tabId: string, index: number, documentEjson: string): void {
      const parsed = parseEjson(documentEjson);
      if (!isPlainObject(parsed)) {
        return;
      }
      update((state) => patchDocument(state, tabId, index, () => parsed));
    },

    /** Saves code as a favourite. A tab named in the input is marked saved. */
    async saveFavourite(input: SaveFavouriteInput): Promise<void> {
      const folder = input.folder?.trim() ?? '';
      await rpc.favourites.save({
        name: input.name.trim(),
        code: input.code,
        connectionId: input.connectionId,
        database: input.database,
        ...(folder === '' ? {} : { folder }),
      });
      update((state) => {
        const next = bumpListRevision(state);
        return input.tabId === undefined ? next : markTabSaved(next, input.tabId);
      });
    },

    /** Opens the code on the connection and database in a tab, and runs it. Used by history and favourites. */
    async rerunStatement(target: CodeTarget): Promise<void> {
      const id = openEditor({ connectionId: target.connectionId, database: target.database });
      update((state) => setTabText(state, id, target.code));
      await runEditor(id, target.code);
    },

    /**
     * Puts the code into the active tab, at its cursor. With no active tab on the connection, a tab
     * for the database opens with the code as its text.
     */
    insertCode(target: CodeTarget): void {
      const state = access.get().editors;
      const active = state.activeId === undefined ? undefined : state.tabs[state.activeId];
      if (active !== undefined && active.connectionId === target.connectionId) {
        editorUiEvents.emit({ type: 'editor:insert', tabId: active.id, text: target.code });
        return;
      }
      const id = openEditor({ connectionId: target.connectionId, database: target.database });
      update((current) => setTabText(current, id, target.code));
    },

    /**
     * Shows the explain plan of the code. Explain is a later phase, so this does nothing yet. The
     * signature is fixed here so that phase can replace the body.
     */
    openExplain(target: CodeTarget): void {
      void target;
      return undefined;
    },

    restoreEditors,

    persistEditors,

    /** Lets the next unlock restore the tabs again. */
    forgetRestored(): void {
      restored.clear();
    },

    isRestored(connectionId: string): boolean {
      return restored.has(connectionId);
    },

    setRuntimeState(connectionId: string, state: ShellRuntimeState): void {
      update((current) => setRuntime(current, connectionId, state));
    },

    /** A print line from a running request. Lines from requests the tab no longer owns keep no tab. */
    printLine(requestId: string, text: string): void {
      update((state) =>
        appendPrint(state, requestId, text, { id: newId(), at: new Date().toISOString() }),
      );
    },

    reportLine,

    /** Moves the list revision, so the history and favourite panels reload. */
    refreshLists(): void {
      update((state) => bumpListRevision(state));
    },

    clearOutput(): void {
      update((state) => ({ ...state, output: [] }));
    },
  };
}

export type EditorActions = ReturnType<typeof createEditorActions>;

/** Documents in a cursor result, or one for any other result that returned a value. */
function countOf(documents: readonly JsonObject[], type: string): number {
  const isCursor =
    type === 'Cursor' || type === 'AggregationCursor' || type === 'CursorIterationResult';
  return isCursor ? documents.length : 1;
}
