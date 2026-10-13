import {
  AppErrorException,
  appError,
  isUnkeptPreview,
  newId,
  nestedMarker,
  previewInfo,
  withPreviewInfo,
  toAppError,
  translateSql,
  translateSqlStatement,
  type AppError,
  type EditorLanguage,
  type PreviewEdit,
  type RpcClient,
  type Settings,
  type SettingsPatch,
  type ShellEvaluation,
  type ShellRuntimeState,
} from '@mongo-gui/core';
import { editorUiEvents, prepareSqlRun, type SqlSampler } from '../editor';
import {
  addColumns,
  createExportSink,
  discoverColumns,
  EXPORT_FORMATS,
  exportHead,
  exportRow,
  exportTail,
  fullDocumentText,
  isPlainObject,
  parseCursorBatch,
  parseEjson,
  withoutPath,
  withValueAtPath,
  type ColumnDef,
  type ExportFormat,
  type JsonObject,
} from '../results';
import {
  appendOutput,
  appendPage,
  appendPrint,
  beginRun,
  patchDocument,
  bumpListRevision,
  closeTab,
  convertTabToMongosh,
  findTab,
  finishRun,
  forgetRequest,
  layoutKeyFor,
  LOAD_ALL_LIMIT,
  markTabSaved,
  openTab,
  resultFromEvaluation,
  RESIDENT_CHARS,
  restoreTabs,
  savedTabsOf,
  SavedTabsSchema,
  setActiveTab,
  setLoadingMore,
  setRuntime,
  setTabBatchSize,
  setTabDatabase,
  setTabError,
  setTabLanguage,
  setTabText,
  setTabView,
  type BatchSize,
  type EditorsState,
  type ResultView,
} from './editors';
import { collectionQueryStatement, collectionSelectStatement } from './collection-query';

/** Batch size of "Load all". Each call reads this many documents, up to LOAD_ALL_LIMIT in all. */
const LOAD_ALL_BATCH = 500;
/** The largest batch the runtime accepts for one `next` call. */
const NEXT_BATCH_LIMIT = 1000;
/** Samples nothing, so a translation has no field types. */
const NO_SAMPLER: SqlSampler = { fieldsOf: () => Promise.resolve([]) };

/** What the editor actions need from the store. */
export interface EditorStoreAccess {
  readonly rpc: RpcClient;
  readonly get: () => {
    readonly editors: EditorsState;
    /** The saved settings. Undefined while the vault is locked. */
    readonly settings: Settings | undefined;
  };
  readonly update: (update: (editors: EditorsState) => EditorsState) => void;
  /** Saves a settings patch, and the store keeps the settings it returns. */
  readonly saveSettings: (patch: SettingsPatch) => Promise<unknown>;
}

export interface OpenEditorInput {
  readonly connectionId: string;
  readonly database: string;
  /** Opens a second tab even when one is open for the same database. */
  readonly newTab?: boolean | undefined;
  /** The language of a new tab. Defaults to the language in the saved settings. */
  readonly language?: EditorLanguage | undefined;
}

export interface SaveFavouriteInput extends CodeTarget {
  readonly name: string;
  readonly folder?: string | undefined;
  /** The tab to mark saved, when the code came from one. */
  readonly tabId?: string | undefined;
}

export interface CollectionTarget {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
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
  /** The language of the code. Undefined means mongosh. */
  readonly language?: EditorLanguage | undefined;
}

type PageOutcome =
  | {
      readonly documents: readonly JsonObject[];
      readonly hasMore: boolean;
      readonly cursorRequestId: string | undefined;
      readonly chars: number;
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

  /** The language in the saved settings. Mongosh until the settings load. */
  function defaultLanguage(): EditorLanguage {
    return access.get().settings?.editorLanguage ?? 'mongosh';
  }

  /** Frees the spill files of the tab's current result. The files are gone for good, so a failure is ignored. */
  function releaseResult(id: string): void {
    const result = access.get().editors.tabs[id]?.result;
    const requestId = result?.cursorRequestId ?? result?.requestId;
    if (requestId !== undefined) {
      void rpc.shell.releaseResult({ requestId }).catch(() => undefined);
    }
  }

  /**
   * Translates the SQL of a tab and switches the tab to mongosh with the translation as its text.
   * The SQL stays in the tab, so switching back to SQL finds it. Resolves to true when the tab is
   * mongosh afterwards. A text with no statement switches without a translation. A failure marks
   * the span and the tab error and leaves the tab in SQL. A tab that changed while the sampler ran,
   * by an edit, a run or a switch, is left alone.
   */
  async function convertToMongosh(id: string, sql: string, sampler: SqlSampler): Promise<boolean> {
    if (translateSql(sql).length === 0) {
      update((state) => setTabLanguage(state, id, 'mongosh'));
      return true;
    }
    const plan = await prepareSqlRun(sql, sampler);
    const now = access.get().editors.tabs[id];
    if (
      now === undefined ||
      now.text !== sql ||
      now.language !== 'sql' ||
      now.running !== undefined
    ) {
      return false;
    }
    if (!plan.ok) {
      editorUiEvents.emit({
        type: 'editor:markers',
        tabId: id,
        markers: [{ start: plan.span.start, end: plan.span.end, message: plan.message }],
      });
      update((state) => setTabError(state, id, appError('VALIDATION', plan.message)));
      return false;
    }
    update((state) => convertTabToMongosh(state, id, plan.mongosh));
    return true;
  }

  /** Saves the language as the default for new tabs. A failed save shows an error line. */
  async function saveDefaultLanguage(language: EditorLanguage): Promise<void> {
    if (access.get().settings?.editorLanguage === language) {
      return;
    }
    try {
      await access.saveSettings({ editorLanguage: language });
    } catch (failure) {
      reportLine('error', `The default language was not saved. ${toAppError(failure).message}`);
    }
  }

  function openEditor(input: OpenEditorInput): string {
    const existing =
      input.newTab === true
        ? undefined
        : findTab(access.get().editors, input.connectionId, input.database);
    if (existing !== undefined) {
      update((state) => setActiveTab(state, existing.id));
      editorUiEvents.emit({ type: 'editor:focus', tabId: existing.id });
      return existing.id;
    }
    const id = newId();
    const language = input.language ?? defaultLanguage();
    update((state) =>
      openTab(state, {
        id,
        connectionId: input.connectionId,
        database: input.database,
        language,
      }),
    );
    return id;
  }

  /**
   * Runs the mongosh text of a tab. A SQL run passes the original SQL as `options.sql`, which prints
   * the mongosh first and records the SQL in history. Without it the run is recorded as mongosh.
   */
  async function runEditor(
    id: string,
    text: string,
    options?: { readonly sql?: string | undefined },
  ): Promise<void> {
    const tab = access.get().editors.tabs[id];
    if (tab === undefined || tab.running !== undefined || text.trim() === '') {
      return;
    }
    const sql = options?.sql;
    if (sql !== undefined) {
      reportLine('info', text, id);
    }
    const requestId = newId();
    const startedAt = Date.now();
    releaseResult(id);
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
      code: sql ?? text,
      language: sql === undefined ? 'mongosh' : 'sql',
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
    readonly language: EditorLanguage;
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
        language: input.language,
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
        chars: evaluation.result.printableEjson.length,
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
    if (result.cursorRequestId === undefined || !result.hasMore || result.capped) {
      return;
    }
    update((state) => setLoadingMore(state, id, true));
    // Load all asks for no more than the documents still under the limit, so it stops at the limit.
    const batchFor = (count: number): number =>
      mode === 'all'
        ? Math.min(LOAD_ALL_BATCH, LOAD_ALL_LIMIT - count)
        : Math.min(tab.batchSize, NEXT_BATCH_LIMIT);
    let loaded = result.documents.length;
    let chars = result.chars;
    let cursor: string | undefined = result.cursorRequestId;
    let more = true;
    // A document with no stored copy ends Load all, as the resident limit does.
    let unkept = false;
    while (
      more &&
      cursor !== undefined &&
      (mode === 'batch' || (loaded < LOAD_ALL_LIMIT && chars < RESIDENT_CHARS && !unkept))
    ) {
      const page = await nextPage(tab.connectionId, cursor, batchFor(loaded));
      if ('error' in page) {
        update((state) => setTabError(state, id, page.error));
        return;
      }
      loaded += page.documents.length;
      chars += page.chars;
      unkept = page.documents.some(isUnkeptPreview);
      more = page.hasMore;
      cursor = page.cursorRequestId;
      update((state) =>
        appendPage(state, id, {
          documents: page.documents,
          hasMore: page.hasMore,
          cursorRequestId: page.cursorRequestId,
          chars: page.chars,
        }),
      );
      if (mode === 'batch') {
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
      ({ value: raw } = await rpc.layout.get({ key: layoutKeyFor(connectionId) }));
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

  /**
   * Puts code into a tab of its language and returns the tab's id. An empty active tab on the same
   * connection takes the code, with its database and language switched. Otherwise a new tab opens.
   */
  function placeCode(target: CodeTarget, language: EditorLanguage): string {
    const state = access.get().editors;
    const active = state.activeId === undefined ? undefined : state.tabs[state.activeId];
    let id: string;
    if (
      active !== undefined &&
      active.connectionId === target.connectionId &&
      active.text.trim() === ''
    ) {
      id = active.id;
      update((current) => setTabDatabase(current, id, target.database));
      update((current) => setTabLanguage(current, id, language));
    } else {
      id = openEditor({
        connectionId: target.connectionId,
        database: target.database,
        newTab: true,
        language,
      });
    }
    update((current) => setTabText(current, id, target.code));
    return id;
  }

  async function rerunStatement(target: CodeTarget): Promise<void> {
    const language = target.language ?? 'mongosh';
    const id = placeCode(target, language);
    if (language === 'sql') {
      // The tab's Run button translates SQL. Running it from here would skip the field types the
      // translation reads, and the confirmation for a write without WHERE.
      reportLine('info', 'The SQL is in its tab. Press Run to translate and run it.', id);
      return;
    }
    await runEditor(id, target.code);
  }

  return {
    openEditor,

    activateEditor(id: string): void {
      update((state) => setActiveTab(state, id));
    },

    closeEditor(id: string): void {
      releaseResult(id);
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

    /**
     * Saves the loaded documents of a tab as a JSON or CSV file. The user picks the file first. The
     * main process writes it only when no file exists under that name. A document whose full text
     * was not kept cannot be read back, so it is left out and counted in the result.
     */
    async exportResult(id: string, format: ExportFormat): Promise<{ readonly skipped: number }> {
      const result = access.get().editors.tabs[id]?.result;
      if (result === undefined) {
        return { skipped: 0 };
      }
      const { extension, name } = EXPORT_FORMATS[format];
      const picked = await rpc.app.showSaveDialog({
        title: `Export results as ${name}`,
        filters: [{ name, extensions: [extension] }],
        defaultPath: `${result.collection ?? 'results'}.${extension}`,
      });
      if (picked.path === undefined) {
        return { skipped: 0 };
      }
      // The text goes out in parts, one document at a time, so neither this process nor the IPC
      // message ever holds the whole file, and a full previewed document is only a transient.
      const path = picked.path;
      const documents = result.documents.filter((document) => !isUnkeptPreview(document));
      const skipped = result.documents.length - documents.length;
      const loadFull = async (document: JsonObject): Promise<JsonObject> =>
        previewInfo(document) === undefined
          ? document
          : (JSON.parse(
              await fullDocumentText(document, (ref) => rpc.shell.readDocument({ ref })),
            ) as JsonObject);
      // A preview keeps only some of the keys of a wide document, so the CSV columns come from the
      // full documents. Each is read and dropped, and read again for its row.
      let columns: ColumnDef[] = [];
      if (format === 'csv') {
        if (documents.some((document) => previewInfo(document) !== undefined)) {
          for (const document of documents) {
            columns = addColumns(columns, [await loadFull(document)]);
          }
        } else {
          columns = discoverColumns(documents);
        }
      }
      const sink = createExportSink((content, part) =>
        rpc.app.writeExport({ path, content, part }),
      );
      try {
        await sink.push(exportHead(format, columns, documents.length));
        for (const [index, document] of documents.entries()) {
          await sink.push(exportRow(format, columns, await loadFull(document), index));
        }
        await sink.push(exportTail(format, documents.length));
        await sink.finish();
      } catch (error) {
        if (sink.started) {
          await rpc.app.writeExport({ path, content: '', part: 'abort' }).catch(() => undefined);
        }
        throw error;
      }
      return { skipped };
    },

    loadAllEditor(id: string): Promise<void> {
      return readPages(id, 'all');
    },

    /** The full canonical EJSON text of a document whose result carried only a preview. */
    readFullDocument(ref: string): Promise<string> {
      return rpc.shell.readDocument({ ref });
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
      // A marker for _id means the preview cut it, and an update by it could miss or hit another document.
      if (nestedMarker(document._id) !== undefined) {
        throw new AppErrorException(
          appError('VALIDATION', 'This document is a preview. Open it to edit.'),
        );
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
      const saved: PreviewEdit =
        edit.unset === true
          ? { path: edit.path, unset: true }
          : { path: edit.path, value: edit.value };
      update((state) =>
        patchDocument(state, edit.tabId, edit.documentIndex, (current) =>
          withRecordedEdit(
            edit.unset === true
              ? withoutPath(current, edit.path)
              : withValueAtPath(current, edit.path, edit.value),
            saved,
          ),
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

    /**
     * Saves code as a favourite, with the language it was written in. A tab named in the input is
     * marked saved.
     */
    async saveFavourite(input: SaveFavouriteInput): Promise<void> {
      const folder = input.folder?.trim() ?? '';
      await rpc.favourites.save({
        name: input.name.trim(),
        code: input.code,
        connectionId: input.connectionId,
        database: input.database,
        ...(input.language === undefined ? {} : { language: input.language }),
        ...(folder === '' ? {} : { folder }),
      });
      update((state) => {
        const next = bumpListRevision(state);
        return input.tabId === undefined ? next : markTabSaved(next, input.tabId);
      });
    },

    /**
     * Runs the code from history or favourites. It goes into a new tab, so the text of the current
     * tab stays. An empty current tab on the same connection takes the code instead. Mongosh runs
     * at once. SQL waits in its tab, so the user runs it from the tab's Run button.
     */
    rerunStatement,

    /**
     * Opens the documents of a collection and runs the query. The query is `find({})` in a mongosh
     * tab, or `SELECT * FROM name;` in a SQL tab when the saved default language is SQL. The tab
     * rules are those of `rerunStatement`. A tab that already holds this exact query on the same
     * connection and database comes to the front instead of a second one opening. A given `sql`
     * runs in a SQL tab whatever the default language.
     */
    async openCollectionQuery(target: CollectionTarget, sql?: string): Promise<void> {
      const language = sql === undefined ? defaultLanguage() : 'sql';
      const code =
        sql ??
        (language === 'sql'
          ? collectionSelectStatement(target.collection)
          : collectionQueryStatement(target.collection));
      const state = access.get().editors;
      const existing = state.order.find((id) => {
        const tab = state.tabs[id];
        return (
          tab !== undefined &&
          tab.connectionId === target.connectionId &&
          tab.database === target.database &&
          tab.language === language &&
          tab.text.trim() === code
        );
      });
      if (existing !== undefined) {
        update((current) => setActiveTab(current, existing));
        return;
      }
      const codeTarget = { connectionId: target.connectionId, database: target.database, code };
      if (language !== 'sql') {
        await rerunStatement(codeTarget);
        return;
      }
      // A select or count of a whole collection needs no field types, so it runs without a sample.
      const id = placeCode(codeTarget, 'sql');
      const result = translateSqlStatement(code);
      if (!result.ok) {
        update((current) => setTabError(current, id, appError('VALIDATION', result.error.message)));
        return;
      }
      await runEditor(id, result.translation.mongosh, { sql: code });
    },

    /** Shows an error on a tab, or clears it. The run flow uses it for a SQL that does not translate. */
    setEditorError(id: string, error: AppError | undefined): void {
      update((state) => setTabError(state, id, error));
    },

    /**
     * Puts the code into the active tab, at its cursor. With no active tab on the connection, a tab
     * for the database opens with the code as its text.
     */
    insertCode(target: CodeTarget): void {
      const language = target.language ?? 'mongosh';
      const state = access.get().editors;
      const active = state.activeId === undefined ? undefined : state.tabs[state.activeId];
      if (active !== undefined && active.connectionId === target.connectionId) {
        if (target.language === undefined || active.language === target.language) {
          editorUiEvents.emit({ type: 'editor:insert', tabId: active.id, text: target.code });
          return;
        }
        // SQL never goes into a mongosh tab, or the reverse, so the code gets a tab of its own.
        const id = openEditor({
          connectionId: target.connectionId,
          database: target.database,
          newTab: true,
          language,
        });
        update((current) => setTabText(current, id, target.code));
        return;
      }
      const id = openEditor({
        connectionId: target.connectionId,
        database: target.database,
        language,
      });
      update((current) => setTabText(current, id, target.code));
    },

    /**
     * Switches a tab between mongosh and SQL, as the language toggle does, and saves the choice as
     * the default for new tabs. The tab keeps the text of each language. The text of the language it
     * leaves waits in the tab, and the text of the language it enters comes back, empty when it has
     * none. Nothing translates, so the SQL and the mongosh never overwrite each other.
     *
     * A tab with a run in progress, and an unknown tab, stay as they are. A failed settings save
     * keeps the tab switched and shows an error line.
     */
    async setEditorLanguage(id: string, language: EditorLanguage): Promise<void> {
      const tab = access.get().editors.tabs[id];
      if (tab === undefined || tab.running !== undefined || tab.language === language) {
        return;
      }
      update((state) => setTabLanguage(state, id, language));
      await saveDefaultLanguage(language);
    },

    /**
     * Translates the SQL of a tab, with the field types the sampler gives, and switches the tab to
     * mongosh with the translation as its text. Both the "Open in Mongo" button and the tab menu
     * entry call it. The SQL stays in the tab, so the language toggle brings it back. Whatever
     * mongosh the tab held before is replaced. Text with no statements switches without a
     * translation. A text that does not translate stays SQL, underlines the failing span and shows
     * the message on the tab. Resolves to true when the tab is mongosh afterwards.
     *
     * A tab with a run in progress, an unknown tab and a mongosh tab stay as they are.
     */
    async openSqlAsMongo(id: string, sampler: SqlSampler = NO_SAMPLER): Promise<boolean> {
      const tab = access.get().editors.tabs[id];
      if (tab === undefined || tab.running !== undefined || tab.language !== 'sql') {
        return false;
      }
      if (!(await convertToMongosh(id, tab.text, sampler))) {
        return false;
      }
      await saveDefaultLanguage('mongosh');
      return true;
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

/**
 * A previewed document keeps its marker after an edit, and the spill still holds the text from
 * before it. The marker records the edit, so whoever reads the stored text applies it on top and
 * gets the document as it is now.
 */
function withRecordedEdit(document: JsonObject, edit: PreviewEdit): JsonObject {
  const info = previewInfo(document);
  return info === undefined
    ? document
    : withPreviewInfo(document, { ...info, edits: [...(info.edits ?? []), edit] });
}
