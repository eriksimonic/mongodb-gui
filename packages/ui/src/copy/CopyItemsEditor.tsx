import { Button, Checkbox, Group, Input, Stack, TextInput } from '@mantine/core';
import { useId, useState } from 'react';
import { FilterEditor } from '../editor/FilterEditor';
import type { CopyRow, CopyVariant } from './copy-model';

export interface CopyItemsEditorProps {
  readonly variant: CopyVariant;
  readonly rows: readonly CopyRow[];
  /** The connection the source collections live on. The filter completes their fields. */
  readonly sourceConnectionId: string;
  readonly sourceDatabase: string;
  /** The target name error of each row, in the order of `rows`. */
  readonly nameErrors: readonly (string | undefined)[];
  /** The filter error of each row, in the order of `rows`. */
  readonly filterErrors: readonly (string | undefined)[];
  readonly onChange: (index: number, patch: Partial<CopyRow>) => void;
}

/** One row per collection: a target name, and a filter that opens below the row. */
export function CopyItemsEditor({
  variant,
  rows,
  sourceConnectionId,
  sourceDatabase,
  nameErrors,
  filterErrors,
  onChange,
}: CopyItemsEditorProps) {
  const baseId = useId();
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const several = variant !== 'one';

  return (
    <Stack gap="sm">
      {rows.map((row, index) => {
        const open = expanded.includes(row.source);
        const filterId = `${baseId}-filter-${index}`;
        const filterError = filterErrors[index];
        // One collection shows its target with a visible label. Several rows name it in an aria label.
        const targetLabel = several
          ? { 'aria-label': `Target collection for ${row.source}` }
          : { label: 'Target collection' };
        return (
          <Stack gap={4} key={row.source}>
            <Group align="flex-end" wrap="nowrap">
              {several ? (
                <Checkbox
                  label={row.source}
                  checked={row.included}
                  onChange={(event) => {
                    onChange(index, { included: event.currentTarget.checked });
                  }}
                />
              ) : (
                <TextInput label="Source collection" value={row.source} readOnly />
              )}
              <TextInput
                {...targetLabel}
                value={row.target}
                disabled={!row.included}
                error={nameErrors[index]}
                onChange={(event) => {
                  onChange(index, { target: event.currentTarget.value });
                }}
                style={{ flex: 1 }}
              />
              <Button
                variant="default"
                size="xs"
                {...(filterError === undefined ? {} : { color: 'red' })}
                disabled={!row.included}
                aria-label={`Filter for ${row.source}`}
                aria-expanded={open}
                {...(open ? { 'aria-controls': filterId } : {})}
                onClick={() => {
                  setExpanded((current) =>
                    current.includes(row.source)
                      ? current.filter((name) => name !== row.source)
                      : [...current, row.source],
                  );
                }}
              >
                Filter
              </Button>
            </Group>
            {open ? (
              <Stack gap={4} id={filterId}>
                <Input.Description>
                  Extended JSON object. Empty copies every document.
                </Input.Description>
                <FilterEditor
                  ariaLabel={`Extended JSON filter for ${row.source}`}
                  value={row.filter}
                  readOnly={!row.included}
                  error={filterError}
                  fields={{
                    connectionId: sourceConnectionId,
                    database: sourceDatabase,
                    collection: row.source,
                  }}
                  onChange={(filter) => {
                    onChange(index, { filter });
                  }}
                />
              </Stack>
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );
}
