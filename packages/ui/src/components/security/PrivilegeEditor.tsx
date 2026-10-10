import {
  ActionIcon,
  Button,
  Group,
  MultiSelect,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { PrivilegeActionCatalog } from '@mongo-gui/core';
import { useMemo } from 'react';
import { databaseNameError } from '../../management/input-rules';
import {
  actionGroups,
  collectionError,
  newPrivilegeDraft,
  RESOURCE_OPTIONS,
  type PrivilegeDraft,
  type ResourceKind,
} from '../../security/privilege-model';

export interface PrivilegeEditorProps {
  readonly drafts: readonly PrivilegeDraft[];
  readonly onChange: (drafts: PrivilegeDraft[]) => void;
  /** The database the panel shows. A "this database" row names it. */
  readonly database: string;
  readonly actions: PrivilegeActionCatalog | undefined;
  /** Hides the controls that change rows. The rows still show what the role grants. */
  readonly readOnly?: boolean;
  /** Makes the next key for a row. The dialog owns the counter, so keys never repeat. */
  readonly nextKey: () => string;
}

/** The rows of a role's privileges: a resource and the actions it allows on that resource. */
export function PrivilegeEditor({
  drafts,
  onChange,
  database,
  actions,
  readOnly = false,
  nextKey,
}: PrivilegeEditorProps) {
  const groups = useMemo(() => (actions === undefined ? [] : actionGroups(actions)), [actions]);
  const data = groups.map((group) => ({ group: group.label, items: [...group.items] }));

  function update(key: string, change: Partial<PrivilegeDraft>) {
    onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)));
  }

  function remove(key: string) {
    onChange(drafts.filter((draft) => draft.key !== key));
  }

  return (
    <Stack gap="sm">
      {drafts.length === 0 ? (
        <Text size="sm" c="dimmed">
          No privileges. The role grants only what its inherited roles grant.
        </Text>
      ) : null}
      {drafts.map((draft) => (
        <Stack key={draft.key} gap={6} p="xs" style={{ border: '1px solid var(--mg-border)' }}>
          <Group gap="xs" wrap="nowrap" align="flex-start">
            <Select
              aria-label="Resource"
              data={resourceData(draft.kind)}
              value={draft.kind}
              allowDeselect={false}
              disabled={readOnly || draft.kind === 'systemBuckets'}
              onChange={(value) => {
                if (value !== null) {
                  update(draft.key, { kind: value as ResourceKind });
                }
              }}
              w={200}
            />
            {draft.kind === 'collection' ? (
              <TextInput
                aria-label="Database of the collection"
                placeholder={database}
                value={draft.db}
                disabled={readOnly}
                error={draft.db === '' ? undefined : databaseNameError(draft.db)}
                onChange={(event) => update(draft.key, { db: event.currentTarget.value })}
                w={160}
              />
            ) : null}
            {draft.kind === 'collection' || draft.kind === 'collectionInAnyDatabase' ? (
              <TextInput
                aria-label="Collection"
                value={draft.collection}
                disabled={readOnly}
                error={draft.collection === '' ? undefined : collectionError(draft.collection)}
                onChange={(event) => update(draft.key, { collection: event.currentTarget.value })}
                w={200}
              />
            ) : null}
            {draft.kind === 'database' ? (
              <Text size="sm" pt={6}>
                {database}
              </Text>
            ) : null}
            {draft.kind === 'systemBuckets' ? (
              <Text size="sm" pt={6}>
                Time series buckets of {draft.db}.{draft.collection}
              </Text>
            ) : null}
            {readOnly ? null : (
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label="Remove privilege"
                onClick={() => remove(draft.key)}
              >
                <IconTrash size={16} />
              </ActionIcon>
            )}
          </Group>
          <MultiSelect
            aria-label="Actions"
            placeholder="Choose actions"
            data={data}
            value={[...draft.actions]}
            searchable
            clearable={!readOnly}
            disabled={readOnly}
            hidePickedOptions
            nothingFoundMessage="No action matches"
            onChange={(value) => update(draft.key, { actions: value })}
          />
        </Stack>
      ))}
      {readOnly ? null : (
        <Button
          variant="default"
          leftSection={<IconPlus size={14} />}
          onClick={() => onChange([...drafts, newPrivilegeDraft(nextKey(), database)])}
          w="fit-content"
        >
          Add privilege
        </Button>
      )}
    </Stack>
  );
}

/** The options of the resource picker. A time series row keeps its own option, which is disabled. */
function resourceData(kind: ResourceKind) {
  const options = RESOURCE_OPTIONS.map((option) => ({ value: option.value, label: option.label }));
  if (kind === 'systemBuckets') {
    options.push({ value: 'systemBuckets', label: 'Time series buckets' });
  }
  return options;
}
