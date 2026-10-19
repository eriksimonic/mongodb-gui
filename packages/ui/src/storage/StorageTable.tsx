import { Box, Text, useComputedColorScheme } from '@mantine/core';
import {
  AllCommunityModule,
  colorSchemeDark,
  colorSchemeLight,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type RowClickedEvent,
} from 'ag-grid-community';
import { AgGridReact, type CustomCellRendererProps } from 'ag-grid-react';
import { useMemo } from 'react';
import { formatBytes, formatCount } from '../diagnostics/format';
import { TABLE_FONT } from '../theme/theme';

ModuleRegistry.registerModules([AllCommunityModule]);

// Same dark colours as the result table, from docs/color-palette.md.
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

export type StorageTableLevel = 'databases' | 'collections' | 'indexes';

export interface StorageTableRow {
  /** The database or collection name, or the index name. Used as the row id. */
  readonly id: string;
  /** Error text of a collection whose read failed. The row is greyed out. */
  readonly error: string | undefined;
  /** One value per column field. `name` is always set. Null prints as "n/a". */
  readonly cells: Readonly<Record<string, number | string | null>>;
  /** CSS fill of a colour dot before the name. */
  readonly dot?: string | undefined;
}

export interface StorageTableProps {
  readonly level: StorageTableLevel;
  readonly rows: readonly StorageTableRow[];
  /** Runs when a row is clicked. Index rows have none. */
  readonly onRowActivate?: ((id: string) => void) | undefined;
  /** Changes when the size column changes, so the grid resets its sort. */
  readonly sizeKey?: string | undefined;
}

type CellFormat = 'bar' | 'text' | 'bytes' | 'count' | 'percent' | 'ratio' | 'date';

interface ColumnSpec {
  readonly field: string;
  /** Short header text that fits on one line. */
  readonly header: string;
  /** Full name, shown as the header tooltip. */
  readonly title: string;
  readonly format: CellFormat;
}

const COLUMNS: Record<StorageTableLevel, readonly ColumnSpec[]> = {
  databases: [
    { field: 'name', header: 'Database', title: 'Database', format: 'text' },
    { field: 'bar', header: 'Size', title: 'Size on disk', format: 'bar' },
    { field: 'state', header: 'State', title: 'Empty or has data', format: 'text' },
  ],
  collections: [
    { field: 'name', header: 'Collection', title: 'Collection', format: 'text' },
    { field: 'bar', header: 'Size', title: 'Size for the chosen metric', format: 'bar' },
    { field: 'count', header: 'Docs', title: 'Documents', format: 'count' },
    { field: 'avgObjSize', header: 'Avg doc', title: 'Average document size', format: 'bytes' },
    { field: 'dataSize', header: 'Data', title: 'Data size', format: 'bytes' },
    { field: 'storageSize', header: 'Storage', title: 'Storage size', format: 'bytes' },
    {
      field: 'freeStorageSize',
      header: 'Free',
      title: 'Free space reported by the server',
      format: 'bytes',
    },
    { field: 'totalIndexSize', header: 'Index', title: 'Index size', format: 'bytes' },
    {
      field: 'indexShare',
      header: 'Idx %',
      title: 'Index size as a share of data plus index size',
      format: 'percent',
    },
    {
      field: 'compression',
      header: 'Ratio',
      title: 'Compression: data size / storage size',
      format: 'ratio',
    },
  ],
  indexes: [
    { field: 'name', header: 'Index', title: 'Index', format: 'text' },
    { field: 'size', header: 'Size', title: 'Index size', format: 'bytes' },
    {
      field: 'share',
      header: '% coll.',
      title: 'Index size as a share of the collection data plus index size',
      format: 'percent',
    },
    { field: 'ops', header: 'Ops', title: 'Operations since the server started', format: 'count' },
    {
      field: 'since',
      header: 'Since',
      title: 'Counter start date (counted since)',
      format: 'date',
    },
  ],
};

/** Formats one cell. Null shows "n/a", which covers values the server did not report. */
function formatCell(value: number | string | null | undefined, format: CellFormat): string {
  if (value === null || value === undefined) {
    return 'n/a';
  }
  if (typeof value === 'string') {
    return format === 'date' ? formatShortDate(value) : value;
  }
  switch (format) {
    case 'bytes':
      return formatBytes(value);
    case 'count':
      return formatCount(value);
    case 'percent':
      return `${(value * 100).toFixed(1)}%`;
    case 'ratio':
      return value.toFixed(2);
    default:
      return String(value);
  }
}

/** An ISO date as YYYY-MM-DD in local time, or the input when it does not parse. */
function formatShortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('en-CA');
}

/**
 * The name cell carries the row test id. A failed collection shows its error on the same line.
 * The error keeps its full text, and the name gives way to it when the column is narrow.
 */
function NameCell({ data }: CustomCellRendererProps<StorageTableRow>) {
  if (data === undefined) {
    return null;
  }
  return (
    <Box
      data-testid={`storage-row-${data.id}`}
      style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, height: '100%' }}
    >
      {data.dot === undefined ? null : (
        <Box
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            border: '1px solid var(--mg-border)',
            background: data.dot,
            flex: '0 0 auto',
          }}
        />
      )}
      <Text size="sm" truncate="end" style={{ flex: '0 1 auto', minWidth: 0 }}>
        {formatCell(data.cells.name, 'text')}
      </Text>
      {data.error === undefined ? null : (
        <Text
          size="xs"
          c="red"
          title={data.error}
          style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}
        >
          {data.error}
        </Text>
      )}
    </Box>
  );
}

/** An inline bar as wide as the row's share of the largest row, with the size beside it. */
function BarCell({ value, context }: CustomCellRendererProps<StorageTableRow>) {
  const largest = (context as { largest: number }).largest;
  const bytes = typeof value === 'number' ? value : null;
  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: 8, height: '100%' }}>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Box
          style={{
            height: 10,
            width: `${bytes !== null && largest > 0 ? Math.max(1, (bytes / largest) * 100) : 0}%`,
            borderRadius: 5,
            border: '1px solid color-mix(in srgb, var(--mg-series-1) 55%, var(--mg-border))',
            background: 'color-mix(in srgb, var(--mg-series-1) 40%, var(--mg-surface-1))',
          }}
        />
      </Box>
      <Text size="xs" style={{ flex: '0 0 auto', width: 64, textAlign: 'right' }}>
        {formatCell(bytes, 'bytes')}
      </Text>
    </Box>
  );
}

// Cut-off cells end in an ellipsis. Headers stay on one line. Full names are in the header tooltip.
const DEFAULT_COL_DEF: ColDef<StorageTableRow> = {
  minWidth: 64,
  cellStyle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};

/** Sortable AG Grid table. The columns follow the drill level. */
export function StorageTable({ level, rows, onRowActivate, sizeKey }: StorageTableProps) {
  const scheme = useComputedColorScheme('light');
  const columns = COLUMNS[level];
  const largest = Math.max(0, ...rows.map((row) => Number(row.cells.bar ?? 0)));
  const context = useMemo(() => ({ largest }), [largest]);

  const columnDefs = useMemo<ColDef<StorageTableRow>[]>(
    () =>
      columns.map((column): ColDef<StorageTableRow> => {
        const isName = column.field === 'name';
        return {
          colId: column.field,
          headerName: column.header,
          headerTooltip: column.title,
          // The name takes the spare width. Numbers get a fixed width that fits their text.
          ...(isName
            ? { flex: 1, minWidth: 160 }
            : column.format === 'bar'
              ? { flex: 1, minWidth: 180, sort: 'desc' as const }
              : { width: column.format === 'date' ? 110 : 100 }),
          valueGetter: (params) => params.data?.cells[column.field] ?? null,
          valueFormatter: (params) => formatCell(params.value, column.format),
          cellRenderer: isName ? NameCell : column.format === 'bar' ? BarCell : undefined,
        };
      }),
    [columns],
  );

  return (
    <Box style={{ height: '100%', minHeight: 240 }}>
      <AgGridReact<StorageTableRow>
        key={`${level}:${sizeKey ?? ''}`}
        context={context}
        theme={scheme === 'dark' ? DARK_THEME : LIGHT_THEME}
        rowData={[...rows]}
        columnDefs={columnDefs}
        defaultColDef={DEFAULT_COL_DEF}
        rowHeight={ROW_HEIGHT_PX}
        headerHeight={ROW_HEIGHT_PX + 4}
        getRowId={(params) => params.data.id}
        getRowStyle={(params) => (params.data?.error === undefined ? undefined : { opacity: 0.5 })}
        onCellKeyDown={(event) => {
          const key = (event.event as KeyboardEvent | null)?.key;
          if (key === 'Enter' && event.data !== undefined) {
            onRowActivate?.(event.data.id);
          }
        }}
        onRowClicked={(event: RowClickedEvent<StorageTableRow>) => {
          if (event.data !== undefined) {
            onRowActivate?.(event.data.id);
          }
        }}
      />
    </Box>
  );
}
