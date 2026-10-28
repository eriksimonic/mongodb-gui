import {
  Badge,
  Box,
  Group,
  Button,
  Checkbox,
  Popover,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  useComputedColorScheme,
} from '@mantine/core';
import {
  AllCommunityModule,
  colorSchemeDark,
  colorSchemeLight,
  ModuleRegistry,
  themeQuartz,
  type CellContextMenuEvent,
  type CellDoubleClickedEvent,
  type ColDef,
  type EditableCallbackParams,
  type SuppressKeyboardEventParams,
  type ValueGetterParams,
} from 'ag-grid-community';
import { IconColumns } from '@tabler/icons-react';
import { AgGridReact, type CustomCellRendererProps, type CustomHeaderProps } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { TreeMenu, type TreeMenuEntry } from '../kit/TreeMenu';
import { notifyError } from '../kit/notify-error';
import { copyText } from '../kit/copy';
import { CellEditor, type CellEditorParams, type Row } from './CellEditor';
import { compareCells } from './cell-order';
import { COPY_MAX_CHARS, fullDocuments, fullValueText } from './full-documents';
import { jsonTextFor } from './json-text';
import {
  BSON_TYPE_LABELS,
  cellView,
  collectionTitle,
  editTypeOf,
  valueAtPath,
  type BsonType,
  type ColumnDef,
  type JsonObject,
} from './result-model';
import { typeBucket, typeColor } from '../schema';
import { valueColor } from './value-color';
import { isShortenedValue } from './tree-rows';
import { ValueModal } from './ValueModal';
import { TABLE_FONT } from '../theme/theme';

ModuleRegistry.registerModules([AllCommunityModule]);

// The dark grid takes its colours from docs/design-language.md#tables.
const DARK_THEME = themeQuartz.withPart(colorSchemeDark).withParams({
  fontFamily: TABLE_FONT,
  backgroundColor: '#18191b',
  foregroundColor: '#f2f3f5',
  headerBackgroundColor: '#2b2d30',
  headerTextColor: '#dfe1e5',
  borderColor: '#393b40',
  rowHoverColor: '#2b2d30',
  selectedRowBackgroundColor: '#2e436e',
  accentColor: '#f4b223',
  chromeBackgroundColor: '#2b2d30',
});
const LIGHT_THEME = themeQuartz.withPart(colorSchemeLight).withParams({ fontFamily: TABLE_FONT });
const ROW_HEIGHT_PX = 28;

/** Scrolling within this many rows of the last one asks for more. */
const NEAR_END_ROWS = 10;

export interface TableViewProps {
  readonly documents: readonly JsonObject[];
  readonly columns: readonly ColumnDef[];
  /** Paths of the columns the chooser has hidden. */
  readonly hidden: readonly string[];
  /** Set when a row can be opened for editing. Describes why otherwise. */
  readonly editable: boolean;
  readonly onOpenDocument: (documentIndex: number) => void;
  /** Writes one edited cell. Rejects with the reason when the write fails. */
  readonly onSetField: CellEditorParams['onSetField'];
  /** Reads the full text of a previewed document. */
  readonly readFull: (ref: string) => Promise<string>;
  readonly onSelectionChange: (documentIndexes: readonly number[]) => void;
  /** Called when the user scrolls near the last loaded row. */
  readonly onNearEnd?: (() => void) | undefined;
}

/** The cell under the pointer when its menu opened. */
interface CellMenuState {
  readonly position: { readonly x: number; readonly y: number };
  readonly path: string;
  readonly value: unknown;
  readonly doc: JsonObject;
  readonly index: number;
}

/** A cell is edited in place when the result is editable and it holds a scalar. `_id` is fixed. */
function cellEditable(editable: boolean, path: string, doc: JsonObject | undefined): boolean {
  return (
    editable &&
    path !== '_id' &&
    doc !== undefined &&
    editTypeOf(valueAtPath(doc, path)) !== undefined
  );
}

/** Copies the whole document. A previewed one is read in full first. */
async function copyDocument(
  doc: JsonObject,
  readFull: (ref: string) => Promise<string>,
): Promise<void> {
  try {
    const documents = await fullDocuments([doc], readFull, COPY_MAX_CHARS);
    await copyText(jsonTextFor({ documents }, 'canonical'), 'Document copied');
  } catch (failure) {
    notifyError(failure, 'Copy failed');
  }
}

/** Copies a cell's value. A value the preview shortened is read in full first. */
async function copyValue(
  cell: Omit<CellMenuState, 'position'>,
  readFull: (ref: string) => Promise<string>,
): Promise<void> {
  try {
    await copyText(await fullValueText(cell.doc, cell.path, cell.value, readFull), 'Value copied');
  } catch (failure) {
    notifyError(failure, 'Copy failed');
  }
}

/** The entries of a cell's menu. It opens the document or copies one piece of the clicked cell. */
function cellMenuEntries(
  cell: Omit<CellMenuState, 'position'>,
  editable: boolean,
  readFull: (ref: string) => Promise<string>,
  onView: () => void,
  onOpen: () => void,
): TreeMenuEntry[] {
  return [
    { kind: 'item', label: editable ? 'Edit document' : 'View document', onSelect: onOpen },
    ...(cell.value !== undefined && isShortenedValue(cell.value)
      ? [{ kind: 'item' as const, label: 'View value', onSelect: onView }]
      : []),
    {
      kind: 'item',
      label: 'Copy value',
      disabled: cell.value === undefined,
      reason: cell.value === undefined ? 'missing' : undefined,
      onSelect: () => void copyValue(cell, readFull),
    },
    {
      kind: 'item',
      label: 'Copy key',
      onSelect: () => void copyText(cell.path, 'Key copied'),
    },
    {
      kind: 'item',
      label: 'Copy document',
      onSelect: () => void copyDocument(cell.doc, readFull),
    },
  ];
}

interface TypeHeaderParams {
  readonly types?: readonly BsonType[];
}

/** Column header: the field path with a badge for each BSON type seen in the sample. */
function TypeHeader(props: CustomHeaderProps & TypeHeaderParams) {
  return (
    <Group gap={4} wrap="nowrap" style={{ minWidth: 0, overflow: 'hidden' }}>
      <Text size="xs" fw={600} truncate="end">
        {props.displayName}
      </Text>
      {(props.types ?? []).map((type) => (
        <Badge
          tt="none"
          key={type}
          size="xs"
          variant="default"
          radius="xl"
          ff="var(--mantine-font-family-monospace)"
          fw={400}
          c="var(--mg-text-muted)"
        >
          {BSON_TYPE_LABELS[type]}
        </Badge>
      ))}
    </Group>
  );
}

/** One cell. A missing field shows a dash. Long text is cut, with the full value on hover. */
function CellRenderer(props: CustomCellRendererProps<Row, unknown>) {
  const scheme = useComputedColorScheme('dark');
  if (props.value === undefined) {
    return (
      <Text size="sm" c="dimmed" component="span">
        —
      </Text>
    );
  }
  const view = cellView(props.value);
  return (
    <span
      data-bson-type={view.type}
      style={{
        display: 'block',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: view.align,
        fontFamily:
          view.type === 'ObjectId' || view.align === 'right'
            ? 'var(--mantine-font-family-monospace)'
            : undefined,
        color: valueColor(view.type) ?? typeColor(typeBucket(view.type), scheme),
      }}
      title={view.title ?? view.text}
      onMouseEnter={
        view.type === 'Object' || view.type === 'Array'
          ? (event) => {
              event.currentTarget.title = collectionTitle(props.value);
            }
          : undefined
      }
    >
      {view.text}
    </span>
  );
}

/** The button and list that hide and show grid columns. */
export function ColumnChooser({
  columns,
  hidden,
  onHiddenChange,
}: {
  readonly columns: readonly ColumnDef[];
  readonly hidden: readonly string[];
  readonly onHiddenChange: (hidden: readonly string[]) => void;
}) {
  const shown = columns.filter((column) => !hidden.includes(column.path)).length;
  return (
    <Popover width={280} position="bottom-start" shadow="md" withinPortal>
      <Popover.Target>
        <Button size="xs" variant="default" leftSection={<IconColumns size={14} />}>
          Columns {shown} of {columns.length}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <ScrollArea.Autosize mah={320}>
          <Stack gap={6}>
            {columns.map((column) => (
              <Checkbox
                key={column.path}
                size="xs"
                label={column.path}
                checked={!hidden.includes(column.path)}
                onChange={(event) =>
                  onHiddenChange(
                    event.currentTarget.checked
                      ? hidden.filter((path) => path !== column.path)
                      : [...hidden, column.path],
                  )
                }
              />
            ))}
          </Stack>
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}

/** Says why the grid cannot edit. */
export function ReadOnlyBadge({ note }: { readonly note: string }) {
  return (
    <Tooltip label={note} multiline w={260} withArrow>
      <Badge tt="none" size="sm" variant="light" color="gray" tabIndex={0} aria-label={note}>
        Read only
      </Badge>
    </Tooltip>
  );
}

/**
 * The documents as a grid. Each field path is a column, discovered from the loaded pages. The
 * column chooser hides and shows columns. Double-clicking, F2 or Enter edits a scalar cell in place
 * when the result is editable. Double-clicking any other cell opens the whole document. A
 * right-click on a cell offers to edit the document, or to copy its value, its key or its document.
 */
export function TableView({
  documents,
  columns,
  hidden,
  editable,
  onOpenDocument,
  onSetField,
  readFull,
  onSelectionChange,
  onNearEnd,
}: TableViewProps) {
  const [cellMenu, setCellMenu] = useState<CellMenuState | undefined>(undefined);
  const [viewing, setViewing] = useState<
    { readonly path: string; readonly load: () => Promise<string> } | undefined
  >(undefined);
  const scheme = useComputedColorScheme('dark');
  const rows = useMemo<Row[]>(() => documents.map((doc, index) => ({ index, doc })), [documents]);
  const visible = useMemo(
    () => columns.filter((column) => !hidden.includes(column.path)),
    [columns, hidden],
  );

  const defs = useMemo<ColDef<Row>[]>(
    () =>
      visible.map((column) => ({
        colId: column.path,
        headerName: column.path,
        headerComponent: TypeHeader,
        headerComponentParams: { types: column.types },
        valueGetter: (params: ValueGetterParams<Row>) =>
          params.data === undefined ? undefined : valueAtPath(params.data.doc, column.path),
        cellRenderer: CellRenderer,
        editable: (params: EditableCallbackParams<Row>) =>
          cellEditable(editable, column.path, params.data?.doc),
        cellEditor: CellEditor,
        cellEditorParams: { onSetField },
        // The editor handles Enter and Escape itself, so the grid does not end the edit first.
        suppressKeyboardEvent: (params: SuppressKeyboardEventParams<Row>) =>
          params.editing && (params.event.key === 'Enter' || params.event.key === 'Escape'),
        comparator: compareCells,
        minWidth: 120,
        flex: 1,
        sortable: true,
        resizable: true,
      })),
    [visible, editable, onSetField],
  );

  return (
    <Stack gap={8} h="100%">
      <Box style={{ flex: 1, minHeight: 0 }}>
        <AgGridReact<Row>
          theme={scheme === 'dark' ? DARK_THEME : LIGHT_THEME}
          rowData={rows}
          columnDefs={defs}
          rowHeight={ROW_HEIGHT_PX}
          headerHeight={ROW_HEIGHT_PX + 4}
          rowSelection={{ mode: 'multiRow', enableClickSelection: true }}
          suppressCellFocus={false}
          getRowId={(params) => String(params.data.index)}
          onSelectionChanged={(event) =>
            onSelectionChange(event.api.getSelectedRows().map((row: Row) => row.index))
          }
          preventDefaultOnContextMenu
          onCellContextMenu={(event: CellContextMenuEvent<Row>) => {
            const pointer = event.event;
            if (event.data === undefined || !(pointer instanceof MouseEvent)) {
              return;
            }
            setCellMenu({
              position: { x: pointer.clientX, y: pointer.clientY },
              path: event.column.getColId(),
              value: event.value,
              doc: event.data.doc,
              index: event.data.index,
            });
          }}
          onCellDoubleClicked={(event: CellDoubleClickedEvent<Row>) => {
            if (
              event.data !== undefined &&
              !cellEditable(editable, event.column.getColId(), event.data.doc)
            ) {
              onOpenDocument(event.data.index);
            }
          }}
          onBodyScroll={(event) => {
            const total = event.api.getDisplayedRowCount();
            if (event.api.getLastDisplayedRowIndex() >= total - NEAR_END_ROWS) {
              onNearEnd?.();
            }
          }}
          overlayNoRowsTemplate="<span>No documents</span>"
        />
      </Box>
      {cellMenu === undefined ? null : (
        <TreeMenu
          entries={cellMenuEntries(
            cellMenu,
            editable,
            readFull,
            () =>
              setViewing({
                path: cellMenu.path,
                load: () => fullValueText(cellMenu.doc, cellMenu.path, cellMenu.value, readFull),
              }),
            () => onOpenDocument(cellMenu.index),
          )}
          position={cellMenu.position}
          onClose={() => setCellMenu(undefined)}
        />
      )}
      {viewing === undefined ? null : (
        <ValueModal path={viewing.path} load={viewing.load} onClose={() => setViewing(undefined)} />
      )}
    </Stack>
  );
}
