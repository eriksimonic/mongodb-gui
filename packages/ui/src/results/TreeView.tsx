import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { valueColor } from './value-color';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  IconCheck,
  IconClipboard,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconEye,
  IconPencil,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { previewInfo } from '@mongo-gui/core';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '../kit/ConfirmDialog';
import { isInsideControl } from '../kit/is-inside-control';
import { errorText } from '../kit/notify-error';
import { useFontScale } from '../theme/font-scale';
import { COPY_MAX_CHARS, fullDocuments, fullValueText } from './full-documents';
import { ValueModal } from './ValueModal';
import {
  EDIT_TYPES,
  cellView,
  isPlainObject,
  collectionTitle,
  editTextOf,
  editTypeOf,
  valueFromEdit,
  type EditType,
  type JsonObject,
} from './result-model';
import {
  COLLAPSED,
  childrenOf,
  isOpen,
  isShortenedValue,
  valueTextOf,
  visibleRows,
  type TreeRow,
  type TreeState,
} from './tree-rows';

const ROW_HEIGHT_PX = 33;
/** Documents per page of the tree. */
const PAGE_SIZE = 20;
/** The first document starts open, the others closed. */
const FIRST_OPEN: TreeState = { expandAll: false, overrides: { '0:': true } };
const GRID_COLUMNS = 'minmax(160px, 1fr) minmax(160px, 2fr) 90px 150px';
const INDENT_PX = 16;
const OVERSCAN_ROWS = 12;

const TYPE_LABEL: Readonly<Record<EditType, string>> = {
  string: 'string',
  int: 'int',
  long: 'long',
  double: 'double',
  decimal: 'decimal',
  boolean: 'boolean',
  date: 'date',
  objectId: 'ObjectId',
  null: 'null',
};
const TYPE_OPTIONS = EDIT_TYPES.map((type) => ({ value: type, label: TYPE_LABEL[type] }));

export interface TreeEdit {
  readonly documentIndex: number;
  readonly path: string;
  readonly value: unknown;
}

/** Scrolling within this many rows of the last one asks for more. */
const NEAR_END_ROWS = 10;

export interface TreeViewProps {
  readonly documents: readonly JsonObject[];
  /** False when the result is not a plain find on one collection. Editing then stays off. */
  readonly editable: boolean;
  readonly editabilityNote: string;
  /** Called when a document row is double-clicked. Without it, a double-click does nothing. */
  readonly onOpenDocument?: ((documentIndex: number) => void) | undefined;
  /** Reads the full text of a previewed document. Without it, a previewed document cannot be copied. */
  readonly readFull?: ((ref: string) => Promise<string>) | undefined;
  readonly onSetField: (edit: TreeEdit) => Promise<void>;
  readonly onUnsetField: (documentIndex: number, path: string) => Promise<void>;
  /** Called when the user scrolls near the last row, or pages past the loaded documents. */
  readonly onNearEnd?: (() => void) | undefined;
  /** The view switch and namespace, shown at the left of the toolbar. */
  readonly leading?: ReactNode;
  /** Exports the result as JSON. Without it the Export button is hidden. */
  readonly onExport?: (() => void) | undefined;
  /** More documents exist than are loaded. Used for the range text. */
  readonly hasMore?: boolean | undefined;
}

interface EditState {
  readonly id: string;
  readonly documentIndex: number;
  readonly path: string;
  readonly type: EditType;
  readonly text: string;
  readonly error: string | undefined;
}

/**
 * Documents as an expandable tree, with a key, a value and a type badge per row. Rows are
 * virtualised. A leaf value can be edited with a type picker, and a field can be removed. Both write
 * through the editField callbacks, which the results pane wires to the management calls. Double-
 * clicking a document row opens the whole document.
 */
export function TreeView({
  documents,
  editable,
  editabilityNote,
  onOpenDocument,
  readFull,
  onSetField,
  onUnsetField,
  onNearEnd,
  leading,
  onExport,
  hasMore = false,
}: TreeViewProps) {
  const [pageStart, setPageStart] = useState(0);
  const [state, setState] = useState<TreeState>(FIRST_OPEN);
  const [editing, setEditing] = useState<EditState | undefined>(undefined);
  // The field a Remove click asked about. The removal waits for the user to confirm it.
  const [pendingRemoval, setPendingRemoval] = useState<TreeRow | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [viewing, setViewing] = useState<
    { readonly path: string; readonly load: () => Promise<string> } | undefined
  >(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const start = Math.min(pageStart, Math.max(0, documents.length - 1));
  const rows = useMemo(
    () =>
      visibleRows(documents.slice(start, start + PAGE_SIZE), state).map((row) => ({
        ...row,
        documentIndex: row.documentIndex + start,
      })),
    [documents, state, start],
  );
  const end = Math.min(documents.length, start + PAGE_SIZE);
  const rowHeight = Math.round(ROW_HEIGHT_PX * useFontScale());
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN_ROWS,
  });

  const lastVisible = virtualizer.getVirtualItems().at(-1)?.index ?? -1;
  // Keyed on position and count, so a failed load does not retry until the user scrolls again.
  useEffect(() => {
    if (rows.length > 0 && lastVisible >= rows.length - NEAR_END_ROWS) {
      onNearEnd?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastVisible, rows.length]);

  function toggle(row: TreeRow): void {
    setState((current) => ({
      ...current,
      overrides: { ...current.overrides, [row.id]: !isOpen(current, row.id) },
    }));
  }

  function startEdit(row: TreeRow): void {
    const type = editTypeOf(row.value);
    if (type === undefined) {
      return;
    }
    setEditing({
      id: row.id,
      documentIndex: row.documentIndex,
      path: row.path,
      type,
      text: editTextOf(row.value),
      error: undefined,
    });
  }

  async function saveEdit(edit: EditState): Promise<void> {
    const converted = valueFromEdit(edit.type, edit.text);
    if (!converted.ok) {
      setEditing({ ...edit, error: converted.message });
      return;
    }
    setBusy(true);
    try {
      await onSetField({
        documentIndex: edit.documentIndex,
        path: edit.path,
        value: converted.value,
      });
      setEditing(undefined);
      setNotice(undefined);
    } catch (failure) {
      setEditing({ ...edit, error: errorText(failure) });
    } finally {
      setBusy(false);
    }
  }

  async function removeField(row: TreeRow): Promise<void> {
    setBusy(true);
    try {
      await onUnsetField(row.documentIndex, row.path);
      setNotice(undefined);
    } catch (failure) {
      setNotice(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(undefined);
    } catch {
      setNotice('The clipboard is not available.');
    }
  }

  /** Copies the documents on this page as formatted JSON, each read in full first. */
  async function copyPage(): Promise<void> {
    try {
      const full = await fullDocuments(
        documents.slice(start, start + PAGE_SIZE),
        readFull ?? (() => Promise.reject(new Error('The full document is not available.'))),
        COPY_MAX_CHARS,
      );
      await copy(JSON.stringify(full.length === 1 ? full[0] : full, null, 2));
    } catch (failure) {
      setNotice(errorText(failure));
    }
  }

  const read = readFull ?? (() => Promise.reject(new Error('The full document is not available.')));
  const documentOf = (row: TreeRow): JsonObject => documents[row.documentIndex] ?? {};

  /** Copies a value in full. A previewed document, or a part the preview shortened, is read in full first. */
  async function copyValue(row: TreeRow): Promise<void> {
    if (row.depth === 0 && previewInfo(row.value) !== undefined) {
      try {
        const [full] = await fullDocuments(
          [row.value as JsonObject],
          readFull ?? (() => Promise.reject(new Error('The full document is not available.'))),
          COPY_MAX_CHARS,
        );
        await copy(JSON.stringify(full, null, 2));
      } catch (failure) {
        setNotice(errorText(failure));
      }
      return;
    }
    try {
      await copy(await fullValueText(documentOf(row), row.path, row.value, read));
    } catch (failure) {
      setNotice(errorText(failure));
    }
  }

  return (
    <Stack gap={6} h="100%">
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          {leading}
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => setState({ expandAll: true, overrides: {} })}
          >
            Expand all
          </Button>
          <Button size="xs" variant="subtle" color="gray" onClick={() => setState(COLLAPSED)}>
            Collapse all
          </Button>
        </Group>
        <Group gap="xs" wrap="nowrap">
          {editable ? null : (
            <Badge tt="none" size="sm" variant="light" color="gray" aria-label={editabilityNote}>
              Read only
            </Badge>
          )}
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            leftSection={<IconCopy size={13} />}
            disabled={documents.length === 0}
            onClick={() => void copyPage()}
          >
            Copy document as formatted JSON
          </Button>
          {onExport === undefined ? null : (
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              disabled={documents.length === 0}
              onClick={onExport}
            >
              Export
            </Button>
          )}
          <Text size="xs" c="var(--mg-text-muted)" ff="var(--mantine-font-family-monospace)">
            {documents.length === 0 ? '0' : `${start + 1}-${end}`} of {documents.length}
            {hasMore ? '+' : ''}
          </Text>
          <ActionIcon
            size="input-xs"
            variant="default"
            aria-label="Previous page"
            disabled={start === 0}
            onClick={() => setPageStart(Math.max(0, start - PAGE_SIZE))}
          >
            <IconChevronLeft size={14} />
          </ActionIcon>
          <ActionIcon
            size="input-xs"
            variant="default"
            aria-label="Next page"
            disabled={end >= documents.length && !hasMore}
            onClick={() => {
              if (end < documents.length) {
                setPageStart(start + PAGE_SIZE);
              } else {
                onNearEnd?.();
              }
            }}
          >
            <IconChevronRight size={14} />
          </ActionIcon>
        </Group>
      </Group>
      {notice === undefined ? null : (
        <Text size="xs" c="red" role="alert">
          {notice}
        </Text>
      )}
      <div
        aria-hidden="true"
        style={{
          display: 'grid',
          gridTemplateColumns: GRID_COLUMNS,
          gap: 8,
          padding: '6px 0',
          borderBottom: '1px solid var(--mg-border)',
          fontSize: 'calc(var(--mg-font-scale, 1) * 12px)',
          color: 'var(--mg-text-muted)',
          fontWeight: 500,
        }}
      >
        <span style={{ paddingLeft: 24 }}>Key</span>
        <span>Value</span>
        <span>Type</span>
        <span />
      </div>
      <div
        ref={scroller}
        role="tree"
        className="mg-virtual-scroll"
        aria-label="Document tree"
        style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}
      >
        <style>
          {
            '.mg-tree-row:hover{background:var(--mg-surface-2)}.mg-tree-actions{opacity:0}.mg-tree-row:hover .mg-tree-actions,.mg-tree-actions:focus-within{opacity:1}'
          }
        </style>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (row === undefined) {
              return null;
            }
            const edit = editing?.id === row.id ? editing : undefined;
            return (
              <div
                key={row.id}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.hasChildren ? row.expanded : undefined}
                aria-label={row.key}
                data-row-id={row.id}
                className="mg-tree-row"
                onDoubleClick={(event) => {
                  // Only a document row opens the document. Buttons in a row keep their own action.
                  if (row.depth === 0 && !isInsideControl(event.target)) {
                    onOpenDocument?.(row.documentIndex);
                  }
                }}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: rowHeight,
                  transform: `translateY(${item.start}px)`,
                  display: 'grid',
                  gridTemplateColumns: GRID_COLUMNS,
                  alignItems: 'center',
                  gap: 8,
                  paddingLeft: row.depth * INDENT_PX,
                  borderBottom: '1px solid var(--mg-border)',
                  fontSize: 'calc(var(--mg-font-scale, 1) * 13px)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, gap: 4 }}>
                  {row.hasChildren ? (
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${row.key}`}
                      onClick={() => toggle(row)}
                    >
                      {row.expanded ? '▾' : '▸'}
                    </ActionIcon>
                  ) : (
                    <span style={{ width: 20 }} aria-hidden="true" />
                  )}
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontFamily: 'var(--mantine-font-family-monospace)',
                      color: row.depth === 0 ? 'var(--mg-text-strong)' : 'var(--mg-link)',
                    }}
                    onDoubleClick={() => {
                      if (editable) {
                        startEdit(row);
                      }
                    }}
                  >
                    {keyText(row)}
                  </span>
                </div>
                <div style={{ minWidth: 0 }}>
                  {edit !== undefined ? (
                    <Group gap={4} wrap="nowrap">
                      <TextInput
                        size="xs"
                        aria-label={`New value for ${row.path}`}
                        value={edit.text}
                        error={edit.error}
                        onChange={(event) =>
                          setEditing({ ...edit, text: event.currentTarget.value, error: undefined })
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            void saveEdit(edit);
                          }
                          if (event.key === 'Escape') {
                            setEditing(undefined);
                          }
                        }}
                        style={{ flex: 1, minWidth: 0 }}
                        autoFocus
                      />
                      <Select
                        size="xs"
                        aria-label="Value type"
                        data={TYPE_OPTIONS}
                        value={edit.type}
                        allowDeselect={false}
                        onChange={(value) => {
                          if (value !== null && (EDIT_TYPES as readonly string[]).includes(value)) {
                            setEditing({ ...edit, type: value as EditType, error: undefined });
                          }
                        }}
                        w={104}
                      />
                      <ActionIcon
                        aria-label="Save value"
                        loading={busy}
                        onClick={() => void saveEdit(edit)}
                      >
                        <IconCheck size={14} />
                      </ActionIcon>
                      <ActionIcon
                        aria-label="Cancel edit"
                        variant="subtle"
                        onClick={() => setEditing(undefined)}
                      >
                        <IconX size={14} />
                      </ActionIcon>
                    </Group>
                  ) : (
                    <ValueText row={row} />
                  )}
                </div>
                <TypePill row={row} />
                <Group gap={2} wrap="nowrap" justify="flex-end" className="mg-tree-actions">
                  <Button
                    aria-label={`Copy path ${row.path}`}
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => void copy(row.path)}
                  >
                    Copy path
                  </Button>
                  {isShortenedValue(row.value) ? (
                    <Tooltip label="View value" withArrow>
                      <ActionIcon
                        aria-label={`View value of ${row.path}`}
                        size="sm"
                        variant="subtle"
                        onClick={() =>
                          setViewing({
                            path: row.path,
                            load: () => fullValueText(documentOf(row), row.path, row.value, read),
                          })
                        }
                      >
                        <IconEye size={13} />
                      </ActionIcon>
                    </Tooltip>
                  ) : null}
                  <Tooltip label="Copy value" withArrow>
                    <ActionIcon
                      aria-label={`Copy value of ${row.path}`}
                      size="sm"
                      variant="subtle"
                      onClick={() => void copyValue(row)}
                    >
                      <IconClipboard size={13} />
                    </ActionIcon>
                  </Tooltip>
                  {editable && isEditableField(row) && editTypeOf(row.value) !== undefined ? (
                    <Tooltip label="Edit value" withArrow>
                      <ActionIcon
                        aria-label={`Edit ${row.path}`}
                        size="sm"
                        variant="subtle"
                        onClick={() => startEdit(row)}
                      >
                        <IconPencil size={13} />
                      </ActionIcon>
                    </Tooltip>
                  ) : null}
                  {editable && isEditableField(row) ? (
                    <Tooltip label="Remove field" withArrow>
                      <ActionIcon
                        aria-label={`Remove ${row.path}`}
                        size="sm"
                        variant="subtle"
                        color="red"
                        disabled={busy}
                        onClick={() => setPendingRemoval(row)}
                      >
                        <IconTrash size={13} />
                      </ActionIcon>
                    </Tooltip>
                  ) : null}
                </Group>
              </div>
            );
          })}
        </div>
      </div>
      {viewing === undefined ? null : (
        <ValueModal path={viewing.path} load={viewing.load} onClose={() => setViewing(undefined)} />
      )}
      {pendingRemoval === undefined ? null : (
        <ConfirmDialog
          title="Remove field"
          description={`Remove ${pendingRemoval.path} from document ${pendingRemoval.documentIndex + 1}? The document is written without the field.`}
          confirmLabel="Remove"
          onConfirm={() => removeField(pendingRemoval)}
          onClose={() => setPendingRemoval(undefined)}
        />
      )}
    </Stack>
  );
}

/**
 * A field a user may edit or remove. The document and its _id are fixed, and so is every part of a
 * compound _id, because changing one part changes the identity of the document.
 */
function isEditableField(row: TreeRow): boolean {
  return row.path !== '' && row.path !== '_id' && !row.path.startsWith('_id.');
}

/** The value column. Containers show their summary, and the full text on hover. */
function ValueText({ row }: { readonly row: TreeRow }) {
  const view = cellView(row.value);
  const text = row.type === 'Object' || row.type === 'Array' ? valueDisplay(row) : view.text;
  return (
    <span
      title={view.title ?? valueTextOf(row.value)}
      onMouseEnter={
        view.type === 'Object' || view.type === 'Array'
          ? (event) => {
              event.currentTarget.title = collectionTitle(row.value);
            }
          : undefined
      }
      style={{
        display: 'block',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'left',
        fontFamily: 'var(--mantine-font-family-monospace)',
        color: valueColor(view.type),
      }}
    >
      {text}
    </span>
  );
}

const NEUTRAL_TYPES = new Set(['Object', 'Array', 'Binary', 'Undefined', 'Boolean']);
const SUMMARY_CHARS = 90;

/** The key column text. A document reads "(1) <_id>", an array element "[0]". */
function keyText(row: TreeRow): string {
  if (row.depth === 0) {
    const id = isPlainObject(row.value) ? row.value._id : undefined;
    const view = id === undefined ? undefined : cellView(id);
    return `(${row.documentIndex + 1}) ${view === undefined ? '' : (view.title ?? view.text)}`.trim();
  }
  return /^\d+$/.test(row.key) ? `[${row.key}]` : row.key;
}

/** One-line text of a value for the value column: counts for containers, a summary when collapsed. */
function valueDisplay(row: TreeRow): string {
  const value = row.value;
  if (row.type === 'Array' && Array.isArray(value)) {
    return `[ ${value.length} ${value.length === 1 ? 'element' : 'elements'} ]`;
  }
  if (row.type === 'Object' && isPlainObject(value)) {
    const entries = childrenOf(value);
    if (row.depth > 0 && !row.expanded && /^\d+$/.test(row.key) && entries.length > 0) {
      const inner = entries.map(([k, v]) => `${k}: ${summaryOf(v)}`).join(', ');
      const text = `{ ${inner} }`;
      return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text;
    }
    return `{ ${entries.length} ${entries.length === 1 ? 'field' : 'fields'} }`;
  }
  return valueTextOf(value);
}

function summaryOf(value: unknown): string {
  const view = cellView(value);
  return view.type === 'String' ? JSON.stringify(view.text) : view.text;
}

/** The type pill, tinted by type. Containers and the document stay neutral. */
function TypePill({ row }: { readonly row: TreeRow }) {
  const label = row.depth === 0 ? 'Document' : row.type;
  const color = row.depth === 0 || NEUTRAL_TYPES.has(row.type) ? undefined : valueColor(row.type);
  return (
    <Badge
      tt="none"
      size="xs"
      variant="default"
      radius="sm"
      ff="var(--mantine-font-family-monospace)"
      fw={400}
      aria-label="Type"
      styles={{
        root: {
          justifySelf: 'start',
          borderColor: 'transparent',
          color: color ?? 'var(--mg-text-muted)',
          background:
            color === undefined
              ? 'var(--mg-surface-3)'
              : `color-mix(in srgb, ${color} 16%, transparent)`,
        },
      }}
    >
      {label}
    </Badge>
  );
}
