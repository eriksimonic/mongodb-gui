import { ActionIcon, Button, Group, Stack, TextInput, Text } from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import { duplicateTagKey, type TagRow } from './replication-model';

export interface TagsEditorProps {
  readonly rows: readonly TagRow[];
  readonly onChange: (rows: TagRow[]) => void;
}

/** Key and value rows for member tags. A duplicate key is named below the rows. */
export function TagsEditor({ rows, onChange }: TagsEditorProps) {
  const duplicate = duplicateTagKey(rows);
  return (
    <Stack gap={6}>
      <Text size="sm" fw={500}>
        Tags
      </Text>
      {rows.map((row, index) => (
        <Group key={index} gap={6} wrap="nowrap">
          <TextInput
            aria-label={`Tag ${index + 1} key`}
            placeholder="key"
            value={row.key}
            style={{ flex: 1 }}
            onChange={(event) => {
              const value = event.currentTarget.value;
              onChange(
                rows.map((item, position) => (position === index ? { ...item, key: value } : item)),
              );
            }}
          />
          <TextInput
            aria-label={`Tag ${index + 1} value`}
            placeholder="value"
            value={row.value}
            style={{ flex: 1 }}
            onChange={(event) => {
              const value = event.currentTarget.value;
              onChange(
                rows.map((item, position) => (position === index ? { ...item, value } : item)),
              );
            }}
          />
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={`Remove tag ${index + 1}`}
            onClick={() => onChange(rows.filter((_, position) => position !== index))}
          >
            <IconX size={16} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={() => onChange([...rows, { key: '', value: '' }])}
        >
          Add tag
        </Button>
      </Group>
      {duplicate === undefined ? null : (
        <Text size="xs" c="red">
          The tag {duplicate} appears twice.
        </Text>
      )}
    </Stack>
  );
}
