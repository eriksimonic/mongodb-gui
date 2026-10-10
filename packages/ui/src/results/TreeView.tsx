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
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  IconCheck,
  IconClipboard,
  IconCopy,
  IconPencil,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useMemo, useRef, useState } from 'react';
import { DestructiveDialog } from '../components/management/DestructiveDialog';
import { errorText } from '../components/notify-error';
import {
  BSON_TYPE_LABELS,
  EDIT_TYPES,
  cellView,
  editTextOf,
  editTypeOf,
  valueFromEdit,
  type EditType,
  type JsonObject,
} from './result-model';
import {
  COLLAPSED,
  copyTextOf,
  isOpen,
  valueTextOf,
  visibleRows,
  type TreeRow,
  type TreeState,
} from './tree-rows';

const ROW_HEIGHT_PX = 28;
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

export interface TreeViewProps {
  readonly documents: readonly JsonObject[];
  /** False when the result is not a plain find on one collection. Editing then stays off. */
  readonly editable: boolean;
  readonly editabilityNote: string;
  readonly onSetField: (edit: TreeEdit) => Promise<void>;
  readonly onUnsetField: (documentIndex: number, path: string) => Promise<void>;
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
 * through the editField callbacks, which the results pane wires to the management calls.
 */
export function TreeView({
  documents,
  editable,
  editabilityNote,
  onSetField,
  onUnsetField,
}: TreeViewProps) {
  const [state, setState] = useState<TreeState>(COLLAPSED);
  const [editing, setEditing] = useState<EditState | undefined>(undefined);
  // The field a Remove click asked about. The removal waits for the user to confirm it.
  const [pendingRemoval, setPendingRemoval] = useState<TreeRow | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => visibleRows(documents, state), [documents, state]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROWS,
  });

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

  return (
    <Stack gap={6} h="100%">
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            onClick={() => setState({ expandAll: true, overrides: {} })}
          >
            Expand all
          </Button>
          <Button size="xs" variant="default" onClick={() => setState(COLLAPSED)}>
            Collapse all
          </Button>
        </Group>
        {editable ? null : (
          <Badge tt="none" size="sm" variant="light" color="gray" aria-label={editabilityNote}>
            Read only
          </Badge>
        )}
      </Group>
      {notice === undefined ? null : (
        <Text size="xs" c="red" role="alert">
          {notice}
        </Text>
      )}
      <div
        ref={scroller}
        role="tree"
        className="mg-virtual-scroll"
        aria-label="Document tree"
        style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}
      >
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
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_HEIGHT_PX,
                  transform: `translateY(${item.start}px)`,
                  display: 'grid',
                  gridTemplateColumns: 'minmax(160px, 1fr) minmax(160px, 2fr) 90px 96px',
                  alignItems: 'center',
                  gap: 8,
                  paddingLeft: row.depth * INDENT_PX,
                  borderBottom: '1px solid var(--mantine-color-dark-5)',
                  fontSize: 13,
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
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    onDoubleClick={() => {
                      if (editable) {
                        startEdit(row);
                      }
                    }}
                  >
                    {row.key}
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
                <Badge
                  tt="none"
                  size="xs"
                  variant="light"
                  color="gray"
                  radius="sm"
                  aria-label="Type"
                >
                  {BSON_TYPE_LABELS[row.type]}
                </Badge>
                <Group gap={2} wrap="nowrap" justify="flex-end">
                  <Tooltip label="Copy path" withArrow>
                    <ActionIcon
                      aria-label={`Copy path ${row.path}`}
                      size="sm"
                      variant="subtle"
                      onClick={() => void copy(row.path)}
                    >
                      <IconCopy size={13} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Copy value" withArrow>
                    <ActionIcon
                      aria-label={`Copy value of ${row.path}`}
                      size="sm"
                      variant="subtle"
                      onClick={() => void copy(copyTextOf(row.value))}
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
      {pendingRemoval === undefined ? null : (
        <DestructiveDialog
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

/** A field a user may edit or remove. The document itself and its _id are fixed. */
function isEditableField(row: TreeRow): boolean {
  return row.path !== '' && row.path !== '_id';
}

/** The value column. Containers show their summary, and the full text on hover. */
function ValueText({ row }: { readonly row: TreeRow }) {
  const view = cellView(row.value);
  return (
    <span
      title={view.title ?? valueTextOf(row.value)}
      style={{
        display: 'block',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: view.align,
        fontFamily:
          view.align === 'right' || view.type === 'ObjectId'
            ? 'var(--mantine-font-family-monospace)'
            : undefined,
        color: view.type === 'Null' ? 'var(--mantine-color-dimmed)' : undefined,
      }}
    >
      {view.text}
    </span>
  );
}
