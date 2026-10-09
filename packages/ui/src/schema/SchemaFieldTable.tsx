import {
  ActionIcon,
  Badge,
  Box,
  Menu,
  Text,
  Tooltip,
  UnstyledButton,
  VisuallyHidden,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconDots,
  IconSelector,
} from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, type CSSProperties } from 'react';
import type { SchemaField } from '@mongo-gui/core';
import { runReported } from '../components/notify-error';
import { useAppStore } from '../state/app-store-context';
import {
  examplesText,
  formatPercent,
  formatRatio,
  missingFieldQuery,
  queryPath,
  rangeLabels,
  typeColor,
  typeSegments,
  typeShares,
  type SchemaRow,
  type SchemaSort,
  type SchemaSortKey,
} from './schema-model';
import type { SchemaTarget } from './schema-store';

const ROW_HEIGHT_PX = 44;
const INDENT_PX = 16;
const OVERSCAN_ROWS = 8;
/** Scroll element class. The browser shims give it a fixed viewport under jsdom. */
const SCHEMA_SCROLLER = 'mg-schema-scroll';

// The columns: path, types, presence, distinct, range, examples, actions.
const COLUMNS =
  'minmax(200px, 2fr) minmax(170px, 1.5fr) 150px 70px minmax(150px, 1.2fr) minmax(170px, 2fr) 36px';

const SORT_LABELS: Readonly<Record<SchemaSortKey, string>> = {
  name: 'Path',
  types: 'Types',
  presence: 'Presence',
};

export interface SchemaFieldTableProps {
  readonly rows: readonly SchemaRow[];
  readonly sort: SchemaSort;
  readonly target: SchemaTarget;
  readonly onSort: (key: SchemaSortKey) => void;
  readonly onToggle: (path: string) => void;
}

/** A virtualised table of fields. Rows are a fixed height, so only the visible ones render. */
export function SchemaFieldTable({ rows, sort, target, onSort, onToggle }: SchemaFieldTableProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: OVERSCAN_ROWS,
  });

  return (
    <Box
      ref={scrollRef}
      className={SCHEMA_SCROLLER}
      data-testid="schema-table"
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        border: '1px solid var(--mantine-color-dark-4)',
        borderRadius: 4,
      }}
    >
      <div
        role="table"
        aria-label="Fields"
        aria-rowcount={rows.length + 1}
        style={{ minWidth: 960 }}
      >
        <div
          role="row"
          aria-rowindex={1}
          style={{
            ...gridRow(),
            position: 'sticky',
            top: 0,
            zIndex: 1,
            background: 'var(--mantine-color-dark-6)',
            borderBottom: '1px solid var(--mantine-color-dark-4)',
            height: 32,
          }}
        >
          <SortHeader label="Path" sortKey="name" sort={sort} onSort={onSort} />
          <SortHeader label="Types" sortKey="types" sort={sort} onSort={onSort} />
          <SortHeader label="Presence" sortKey="presence" sort={sort} onSort={onSort} />
          <div role="columnheader">Distinct</div>
          <div role="columnheader">Range</div>
          <div role="columnheader">Examples</div>
          <div role="columnheader">
            <VisuallyHidden>Actions</VisuallyHidden>
          </div>
        </div>
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed" p="sm" role="status">
            No fields match the filters.
          </Text>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (row === undefined) {
                return null;
              }
              return (
                <FieldRow
                  key={row.field.path}
                  row={row}
                  rowIndex={item.index + 2}
                  target={target}
                  onToggle={onToggle}
                  style={{
                    ...gridRow(),
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: ROW_HEIGHT_PX,
                    transform: `translateY(${item.start}px)`,
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </Box>
  );
}

function gridRow(): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: COLUMNS,
    alignItems: 'center',
    gap: 8,
    padding: '0 8px',
    minWidth: 960,
  };
}

interface SortHeaderProps {
  readonly label: string;
  readonly sortKey: SchemaSortKey;
  readonly sort: SchemaSort;
  readonly onSort: (key: SchemaSortKey) => void;
}

function SortHeader({ label, sortKey, sort, onSort }: SortHeaderProps) {
  const active = sort.key === sortKey;
  const Icon = !active ? IconSelector : sort.direction === 'asc' ? IconChevronUp : IconChevronDown;
  return (
    <div
      role="columnheader"
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <UnstyledButton
        onClick={() => onSort(sortKey)}
        aria-label={`Sort by ${SORT_LABELS[sortKey]}`}
        style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}
      >
        {label}
        <Icon size={12} aria-hidden="true" />
      </UnstyledButton>
    </div>
  );
}

interface FieldRowProps {
  readonly row: SchemaRow;
  readonly rowIndex: number;
  readonly target: SchemaTarget;
  readonly onToggle: (path: string) => void;
  readonly style: CSSProperties;
}

function FieldRow({ row, rowIndex, target, onToggle, style }: FieldRowProps) {
  const { field, depth } = row;
  return (
    <div role="row" aria-rowindex={rowIndex} aria-level={depth + 1} style={style}>
      <div
        role="cell"
        style={{
          display: 'flex',
          alignItems: 'center',
          minWidth: 0,
          paddingLeft: depth * INDENT_PX,
        }}
      >
        {row.hasChildren ? (
          <ActionIcon
            variant="subtle"
            aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${field.path}`}
            aria-expanded={row.expanded}
            onClick={() => onToggle(field.path)}
          >
            {row.expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          </ActionIcon>
        ) : (
          <Box w={22} aria-hidden="true" />
        )}
        <Text size="sm" ff="monospace" truncate="end" title={field.path}>
          {field.path}
        </Text>
        {field.isIdLike === true ? (
          <Badge size="xs" variant="light" color="gray" ml={6}>
            id
          </Badge>
        ) : null}
      </div>
      <div role="cell" style={{ minWidth: 0 }}>
        <TypeCell field={field} />
      </div>
      <div role="cell">
        <PresenceBar presence={field.presence} />
      </div>
      <div role="cell">
        <Text size="xs" c="dimmed">
          {field.uniqueRatio === undefined ? '' : formatRatio(field.uniqueRatio)}
        </Text>
      </div>
      <div role="cell" style={{ minWidth: 0 }}>
        <Text size="xs" c="dimmed" truncate="end" title={rangeLabels(field).join('; ')}>
          {rangeLabels(field).join('; ')}
        </Text>
      </div>
      <div role="cell" style={{ minWidth: 0 }}>
        <Tooltip
          label={examplesText(field) === '' ? 'No scalar values' : examplesText(field)}
          multiline
          maw={420}
          position="top-start"
          openDelay={300}
        >
          <Text size="xs" ff="monospace" truncate="end">
            {examplesText(field)}
          </Text>
        </Tooltip>
      </div>
      <div role="cell">
        <RowActions field={field} target={target} />
      </div>
    </div>
  );
}

/** Stacked bar of the BSON types, with the types named as chips. */
function TypeCell({ field }: { readonly field: SchemaField }) {
  const segments = typeSegments(field);
  const shares = typeShares(field);
  const total = shares.reduce((sum, [, count]) => sum + count, 0);
  const summary = segments
    .map((segment) => `${segment.types.join(', ')} ${formatPercent(segment.share)}`)
    .join('; ');
  return (
    <Box>
      <Box
        role="img"
        aria-label={`Types: ${summary}`}
        style={{ display: 'flex', gap: 2, height: 8, width: '100%', minWidth: 60 }}
      >
        {segments.map((segment) => (
          <Box
            key={segment.bucket}
            title={`${segment.types.join(', ')}: ${formatPercent(segment.share)}`}
            style={{
              flex: `${segment.share} 0 0`,
              background: typeColor(segment.bucket),
              borderRadius: 2,
            }}
          />
        ))}
      </Box>
      <Text size="xs" c="dimmed" truncate="end" mt={3}>
        {shares
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .map(([type, count]) => `${type} ${formatPercent(total === 0 ? 0 : count / total)}`)
          .join(', ')}
      </Text>
    </Box>
  );
}

function PresenceBar({ presence }: { readonly presence: number }) {
  const label = `${formatPercent(presence)} of documents`;
  return (
    <Box>
      <Box
        role="img"
        aria-label={label}
        style={{
          height: 8,
          width: '100%',
          background: 'var(--mantine-color-dark-5)',
          borderRadius: 2,
        }}
      >
        <Box
          style={{
            height: 8,
            width: `${Math.round(presence * 100)}%`,
            background: 'var(--mantine-color-blue-6)',
            borderRadius: 2,
          }}
        />
      </Box>
      <Text size="xs" c="dimmed" mt={3}>
        {label}
      </Text>
    </Box>
  );
}

interface RowActionsProps {
  readonly field: SchemaField;
  readonly target: SchemaTarget;
}

/** The actions of one field. Each reaches the shell through the store or the clipboard. */
function RowActions({ field, target }: RowActionsProps) {
  const setManagementDialog = useAppStore((state) => state.setManagementDialog);
  const requestPanel = useAppStore((state) => state.requestPanel);
  const requestValidationField = useAppStore((state) => state.requestValidationField);
  const { connectionId, database, collection } = target;

  return (
    <Menu position="bottom-end" withinPortal shadow="md" width={260}>
      <Menu.Target>
        <ActionIcon aria-label={`Actions for ${field.path}`}>
          <IconDots size={14} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          onClick={() =>
            setManagementDialog({
              kind: 'createIndex',
              connectionId,
              database,
              collection,
              field: queryPath(field.path),
            })
          }
        >
          Create index on this field
        </Menu.Item>
        <Menu.Item
          onClick={() => {
            requestValidationField({
              connectionId,
              database,
              collection,
              path: field.path,
              types: field.types,
            });
            requestPanel({ panel: 'validation', connectionId, database, collection });
          }}
        >
          Add to validation rule
        </Menu.Item>
        <Menu.Item
          onClick={() => {
            void runReported(() => navigator.clipboard.writeText(field.path));
          }}
        >
          Copy path
        </Menu.Item>
        <Menu.Item
          onClick={() => {
            // No editor tab exists yet, so the query goes to the clipboard for the editor to take.
            const query = missingFieldQuery(collection, field.path);
            void runReported(async () => {
              await navigator.clipboard.writeText(query);
              notifications.show({
                message: 'Copied the query. Paste it into the editor to list the documents.',
              });
            });
          }}
        >
          Find documents where this field is missing
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
