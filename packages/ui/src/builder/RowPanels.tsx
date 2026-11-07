import {
  ActionIcon,
  Button,
  Checkbox,
  Group,
  NumberInput,
  SegmentedControl,
  Stack,
} from '@mantine/core';
import { type FieldInfo, type ProjectionRow, type SortRow } from '@mongo-gui/core';
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react';
import { mongoshText } from './condition-model';
import { FieldPicker } from './FieldPicker';
import { RawText } from './RawText';

export interface ProjectionPanelProps {
  readonly rows: readonly ProjectionRow[];
  /** The fields of the collection. They are suggestions only. */
  readonly fields: readonly FieldInfo[];
  readonly onChange: (rows: ProjectionRow[]) => void;
}

/** Projection rows. A field row is `include` or `exclude`. Any other value is a raw row. */
export function ProjectionPanel({ rows, fields, onChange }: ProjectionPanelProps) {
  const replace = (index: number, next: ProjectionRow) =>
    onChange(rows.map((row, i) => (i === index ? next : row)));
  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));

  return (
    <Stack gap="xs">
      {rows.map((row, index) => (
        <Group key={index} gap="xs" wrap="nowrap" align="flex-start">
          <Checkbox
            aria-label="Enable row"
            checked={row.enabled}
            onChange={(event) => replace(index, { ...row, enabled: event.currentTarget.checked })}
          />
          <FieldPicker
            label="Projection field"
            fields={fields}
            value={row.field}
            onChange={(field) => replace(index, { ...row, field })}
          />
          {row.kind === 'field' ? (
            <SegmentedControl
              size="xs"
              data={[
                { label: 'Include', value: 'include' },
                { label: 'Exclude', value: 'exclude' },
              ]}
              value={row.include ? 'include' : 'exclude'}
              onChange={(value) => replace(index, { ...row, include: value === 'include' })}
            />
          ) : (
            <RawText
              key={mongoshText(row.value)}
              value={row.value}
              ariaLabel="Raw value"
              width="calc(240px * var(--mg-font-scale, 1))"
              onCommit={(value) => {
                replace(index, { ...row, value });
                return undefined;
              }}
            />
          )}
          <ActionIcon
            size="input-xs"
            variant="default"
            aria-label="Remove row"
            onClick={() => remove(index)}
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconPlus size={14} />}
          onClick={() =>
            onChange([...rows, { kind: 'field', enabled: true, field: '', include: true }])
          }
        >
          Add field
        </Button>
      </Group>
    </Stack>
  );
}

export interface SortPanelProps {
  readonly rows: readonly SortRow[];
  /** The fields of the collection. They are suggestions only. */
  readonly fields: readonly FieldInfo[];
  readonly onChange: (rows: SortRow[]) => void;
}

/** Sort rows in order. The first row sorts first. */
export function SortPanel({ rows, fields, onChange }: SortPanelProps) {
  const replace = (index: number, next: SortRow) =>
    onChange(rows.map((row, i) => (i === index ? next : row)));
  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));
  const move = (index: number, to: number) => {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    if (row) next.splice(to, 0, row);
    onChange(next);
  };

  return (
    <Stack gap="xs">
      {rows.map((row, index) => (
        <Group key={index} gap="xs" wrap="nowrap" align="flex-start">
          <Checkbox
            aria-label="Enable row"
            checked={row.enabled}
            onChange={(event) => replace(index, { ...row, enabled: event.currentTarget.checked })}
          />
          <FieldPicker
            label="Sort field"
            fields={fields}
            value={row.field}
            onChange={(field) => replace(index, { ...row, field })}
          />
          <SegmentedControl
            size="xs"
            data={[
              { label: 'Ascending', value: '1' },
              { label: 'Descending', value: '-1' },
            ]}
            value={row.direction === 1 ? '1' : '-1'}
            onChange={(value) => replace(index, { ...row, direction: value === '1' ? 1 : -1 })}
          />
          <ActionIcon
            size="input-xs"
            variant="default"
            aria-label="Move up"
            disabled={index === 0}
            onClick={() => move(index, index - 1)}
          >
            <IconArrowUp size={14} />
          </ActionIcon>
          <ActionIcon
            size="input-xs"
            variant="default"
            aria-label="Move down"
            disabled={index === rows.length - 1}
            onClick={() => move(index, index + 1)}
          >
            <IconArrowDown size={14} />
          </ActionIcon>
          <ActionIcon
            size="input-xs"
            variant="default"
            aria-label="Remove row"
            onClick={() => remove(index)}
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconPlus size={14} />}
          onClick={() => onChange([...rows, { enabled: true, field: '', direction: 1 }])}
        >
          Add sort field
        </Button>
      </Group>
    </Stack>
  );
}

export interface SkipLimitRowProps {
  readonly skip: number | null;
  readonly limit: number | null;
  readonly onChange: (next: {
    readonly skip: number | null;
    readonly limit: number | null;
  }) => void;
}

/** Skip and limit. An empty box, or 0, means the value is not set. */
export function SkipLimitRow({ skip, limit, onChange }: SkipLimitRowProps) {
  return (
    <Group gap="xs" align="flex-end">
      <NumberInput
        size="xs"
        label="Skip"
        min={0}
        allowDecimal={false}
        value={skip ?? ''}
        onChange={(value) => onChange({ skip: countOf(value), limit })}
        w="calc(120px * var(--mg-font-scale, 1))"
      />
      <NumberInput
        size="xs"
        label="Limit"
        min={0}
        allowDecimal={false}
        value={limit ?? ''}
        onChange={(value) => onChange({ skip, limit: countOf(value) })}
        w="calc(120px * var(--mg-font-scale, 1))"
      />
    </Group>
  );
}

/** A count above 0. An empty box gives an empty string, and 0 means not set, so both give null. */
function countOf(value: number | string): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
}
