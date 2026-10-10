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
  type ColDef,
  type ValueGetterParams,
} from 'ag-grid-community';
import { IconColumns } from '@tabler/icons-react';
import { AgGridReact, type CustomCellRendererProps, type CustomHeaderProps } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { compareCells } from './cell-order';
import {
  BSON_TYPE_LABELS,
  cellView,
  valueAtPath,
  type BsonType,
  type ColumnDef,
  type JsonObject,
} from './result-model';

ModuleRegistry.registerModules([AllCommunityModule]);

const DARK_THEME = themeQuartz.withPart(colorSchemeDark);
const LIGHT_THEME = themeQuartz.withPart(colorSchemeLight);
const ROW_HEIGHT_PX = 28;

interface Row {
  readonly index: number;
  readonly doc: JsonObject;
}

export interface TableViewProps {
  readonly documents: readonly JsonObject[];
  readonly columns: readonly ColumnDef[];
  /** Set when a row can be opened for editing. Describes why otherwise. */
  readonly editable: boolean;
  readonly editabilityNote: string;
  readonly onOpenDocument: (documentIndex: number) => void;
  readonly onSelectionChange: (documentIndexes: readonly number[]) => void;
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
        color: view.type === 'Null' ? 'var(--mantine-color-dimmed)' : undefined,
      }}
      title={view.title ?? view.text}
    >
      {view.text}
    </span>
  );
}

/**
 * The documents as a grid. Each field path is a column, discovered from the loaded pages. The
 * column chooser hides and shows columns. Double-clicking a row opens the whole document.
 */
export function TableView({
  documents,
  columns,
  editable,
  editabilityNote,
  onOpenDocument,
  onSelectionChange,
}: TableViewProps) {
  const [hidden, setHidden] = useState<readonly string[]>([]);
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
          onRowDoubleClicked={(event) => {
            if (event.data !== undefined) {
              onOpenDocument(event.data.index);
            }
          }}
          overlayNoRowsTemplate="<span>No documents</span>"
        />
      </Box>
    </Stack>
  );
}
