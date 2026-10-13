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
  type ColDef,
  type ValueGetterParams,
} from 'ag-grid-community';
import { IconColumns } from '@tabler/icons-react';
import { AgGridReact, type CustomCellRendererProps, type CustomHeaderProps } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { TreeMenu, type TreeMenuEntry } from '../components/connections/TreeMenu';
import { notifyError } from '../components/notify-error';
import { copyText } from '../diagnostics/copy';
import { compareCells } from './cell-order';
import { COPY_MAX_CHARS, fullDocuments } from './full-documents';
import { jsonTextFor } from './json-text';
import {
  BSON_TYPE_LABELS,
  cellView,
  collectionTitle,
  valueAtPath,
  type BsonType,
  type ColumnDef,
  type JsonObject,
} from './result-model';
import { typeBucket, typeColor } from '../schema/schema-model';
import { exactCopyTextOf } from './tree-rows';
import { APP_FONT } from '../theme/theme';

ModuleRegistry.registerModules([AllCommunityModule]);

// The dark grid takes its colours from docs/color-palette.md.
const DARK_THEME = themeQuartz.withPart(colorSchemeDark).withParams({
  fontFamily: APP_FONT,
  backgroundColor: '#0a0a0c',
  foregroundColor: '#f5f3ee',
  headerBackgroundColor: '#222226',
  headerTextColor: '#d0d0cd',
  borderColor: '#34343a',
  rowHoverColor: '#222226',
  selectedRowBackgroundColor: '#3d3317',
  accentColor: '#ffd60a',
  chromeBackgroundColor: '#222226',
});
const LIGHT_THEME = themeQuartz.withPart(colorSchemeLight).withParams({ fontFamily: APP_FONT });
const ROW_HEIGHT_PX = 28;

interface Row {
  readonly index: number;
  readonly doc: JsonObject;
}

/** Scrolling within this many rows of the last one asks for more. */
const NEAR_END_ROWS = 10;

export interface TableViewProps {
  readonly documents: readonly JsonObject[];
  readonly columns: readonly ColumnDef[];
  /** Set when a row can be opened for editing. Describes why otherwise. */
  readonly editable: boolean;
  readonly editabilityNote: string;
  readonly onOpenDocument: (documentIndex: number) => void;
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

/** The entries of a cell's menu. Each copies one piece of the clicked cell. */
function cellMenuEntries(
  cell: Omit<CellMenuState, 'position'>,
  readFull: (ref: string) => Promise<string>,
): TreeMenuEntry[] {
  const valueText = cell.value === undefined ? undefined : exactCopyTextOf(cell.value);
  return [
    {
      kind: 'item',
      label: 'Copy value',
      disabled: valueText === undefined,
      reason:
        valueText !== undefined ? undefined : cell.value === undefined ? 'missing' : 'Shortened',
      onSelect: () => {
        if (valueText !== undefined) {
          void copyText(valueText, 'Value copied');
        }
      },
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
        <Badge tt="none" key={type} size="xs" variant="light" color="gray" radius="sm">
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
        color:
          view.type === 'Null'
            ? 'var(--mantine-color-dimmed)'
            : typeColor(typeBucket(view.type), scheme),
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

/**
 * The documents as a grid. Each field path is a column, discovered from the loaded pages. The
 * column chooser hides and shows columns. Double-clicking a row opens the whole document. A
 * right-click on a cell offers to copy its value, its key or its document.
 */
export function TableView({
  documents,
  columns,
  editable,
  editabilityNote,
  onOpenDocument,
  readFull,
  onSelectionChange,
  onNearEnd,
}: TableViewProps) {
  const [hidden, setHidden] = useState<readonly string[]>([]);
  const [cellMenu, setCellMenu] = useState<CellMenuState | undefined>(undefined);
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
        comparator: compareCells,
        minWidth: 120,
        flex: 1,
        sortable: true,
        resizable: true,
      })),
    [visible],
  );

  return (
    <Stack gap={6} h="100%">
      <Group gap="xs" wrap="nowrap">
        <Popover width={280} position="bottom-start" shadow="md" withinPortal>
          <Popover.Target>
            <Button size="xs" variant="default" leftSection={<IconColumns size={14} />}>
              Columns {visible.length} of {columns.length}
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
                    onChange={(event) => {
                      const shown = event.currentTarget.checked;
                      setHidden((current) =>
                        shown
                          ? current.filter((path) => path !== column.path)
                          : [...current, column.path],
                      );
                    }}
                  />
                ))}
              </Stack>
            </ScrollArea.Autosize>
          </Popover.Dropdown>
        </Popover>
        {editable ? null : (
          <Tooltip label={editabilityNote} multiline w={260} withArrow>
            <Badge
              tt="none"
              size="sm"
              variant="light"
              color="gray"
              tabIndex={0}
              aria-label={editabilityNote}
            >
              Read only
            </Badge>
          </Tooltip>
        )}
      </Group>
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
            });
          }}
          onRowDoubleClicked={(event) => {
            if (event.data !== undefined) {
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
          entries={cellMenuEntries(cellMenu, readFull)}
          position={cellMenu.position}
          onClose={() => setCellMenu(undefined)}
        />
      )}
    </Stack>
  );
}
