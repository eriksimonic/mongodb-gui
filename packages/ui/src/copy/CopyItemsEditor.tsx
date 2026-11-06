import { Button, Checkbox, Group, Stack, TextInput, Textarea } from '@mantine/core';
import { useId, useState } from 'react';
import type { CopyRow, CopyVariant } from './copy-model';

export interface CopyItemsEditorProps {
  readonly variant: CopyVariant;
  readonly rows: readonly CopyRow[];
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
              <Textarea
                id={filterId}
                aria-label={`Extended JSON filter for ${row.source}`}
                placeholder='{"status": "paid"}'
                description="Extended JSON object. Empty copies every document."
                autosize
                minRows={2}
                value={row.filter}
                disabled={!row.included}
                error={filterError}
                onChange={(event) => {
                  onChange(index, { filter: event.currentTarget.value });
                }}
              />
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );
}
