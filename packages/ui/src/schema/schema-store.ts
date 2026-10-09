import type { SchemaAnalyseInput, SchemaReport, SchemaSampleStrategy } from '@mongo-gui/core';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { errorText } from '../components/notify-error';
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  toggleExpanded,
  toggleSort,
  type SampleSizeOption,
  type SchemaFilters,
  type SchemaSort,
  type SchemaSortKey,
} from './schema-model';

/** The sample a panel asks for. The collection is fixed when the panel opens. */
export interface SchemaTarget {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
}

export type AnalyseCall = (input: SchemaAnalyseInput) => Promise<SchemaReport>;

export interface SchemaState {
  readonly sampleSize: SampleSizeOption;
  readonly strategy: SchemaSampleStrategy;
  readonly report: SchemaReport | undefined;
  readonly loading: boolean;
  /** The text of the last failed analysis. Cleared by the next analysis. */
  readonly error: string | undefined;
  /** Time the last successful analysis took, in milliseconds. */
  readonly elapsedMs: number | undefined;
  readonly sort: SchemaSort;
  readonly filters: SchemaFilters;
  /** Open state of nested paths. A path missing from the map is closed. */
  readonly expanded: Readonly<Record<string, boolean>>;
  setSampleSize(size: SampleSizeOption): void;
  setStrategy(strategy: SchemaSampleStrategy): void;
  setPathText(text: string): void;
  setMixedOnly(mixedOnly: boolean): void;
  setSparseOnly(sparseOnly: boolean): void;
  sortBy(key: SchemaSortKey): void;
  toggleRow(path: string): void;
  analyse(): Promise<void>;
}

export type SchemaStore = StoreApi<SchemaState>;

export interface SchemaStoreOptions {
  readonly target: SchemaTarget;
  readonly analyse: AnalyseCall;
  /** Milliseconds from a fixed origin. Tests pass a fake clock. */
  readonly now?: (() => number) | undefined;
}

/**
 * The state of one schema panel: the sample settings, the last report, the sort, the filters and
 * the open paths. Plain zustand, so the component and the tests drive the same actions.
 */
export function createSchemaStore(options: SchemaStoreOptions): SchemaStore {
  const now = options.now ?? (() => performance.now());
  // Each analysis takes a number. A result that arrives after a newer analysis started is dropped.
  let latestAnalysis = 0;

  return createStore<SchemaState>()((set, get) => ({
    sampleSize: 1000,
    strategy: 'random',
    report: undefined,
    loading: false,
    error: undefined,
    elapsedMs: undefined,
    sort: DEFAULT_SORT,
    filters: DEFAULT_FILTERS,
    expanded: {},

    setSampleSize(sampleSize) {
      set({ sampleSize });
    },

    setStrategy(strategy) {
      set({ strategy });
    },

    setPathText(text) {
      set((state) => ({ filters: { ...state.filters, text } }));
    },

    setMixedOnly(mixedOnly) {
      set((state) => ({ filters: { ...state.filters, mixedOnly } }));
    },

    setSparseOnly(sparseOnly) {
      set((state) => ({ filters: { ...state.filters, sparseOnly } }));
    },

    sortBy(key) {
      set((state) => ({ sort: toggleSort(state.sort, key) }));
    },

    toggleRow(path) {
      set((state) => ({ expanded: toggleExpanded(state.expanded, path) }));
    },

    async analyse() {
      const { sampleSize, strategy } = get();
      const analysis = ++latestAnalysis;
      set({ loading: true, error: undefined });
      const started = now();
      try {
        const report = await options.analyse({
          connectionId: options.target.connectionId,
          database: options.target.database,
          collection: options.target.collection,
          size: sampleSize,
          strategy,
        });
        if (analysis === latestAnalysis) {
          set({ report, loading: false, elapsedMs: now() - started });
        }
      } catch (error) {
        if (analysis === latestAnalysis) {
          set({ loading: false, error: errorText(error), elapsedMs: undefined });
        }
      }
    },
  }));
}
