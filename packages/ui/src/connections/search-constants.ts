/** A cached name catalog is reused for this long, and a refetch waits this long after typing. */
export const NAME_CATALOG_MAX_AGE_MS = 5000;
export const NAME_CATALOG_DEBOUNCE_MS = 5000;

/** Window event the shell sends for Ctrl+T. The search box listens and takes focus. */
export const FOCUS_TREE_SEARCH_EVENT = 'mongo-gui:focus-tree-search';
