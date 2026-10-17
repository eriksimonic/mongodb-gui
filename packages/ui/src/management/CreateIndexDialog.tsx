import {
  ActionIcon,
  Alert,
  Autocomplete,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { IconCopy, IconPlus, IconTrash } from '@tabler/icons-react';
import type { IndexInfo } from '@mongo-gui/core';
import { errorText } from '../kit/notify-error';
import { useEffect, useState } from 'react';
import { useUiApi } from '../api/ui-api';
import { JsonEditor } from '../kit/code/JsonEditor';
import { formatJson } from '../kit/input-rules';
import { topLevelKeys } from './document-rows';
import {
  buildIndexRequest,
  defaultNameFor,
  draftFromIndex,
  EMPTY_INDEX_DRAFT,
  hasTextKey,
  INDEX_ORDERS,
  previewCommand,
  type IndexDraft,
  type IndexOrder,
} from './index-builder';

export interface CreateIndexDialogProps {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  /** A field to put in the key builder first, for example from the schema panel. */
  readonly initialField?: string | undefined;
  /**
   * The index to replace. The dialog then opens with its definition, and saving drops it and
   * creates the new definition.
   */
  readonly editing?: IndexInfo | undefined;
  readonly onClose: () => void;
}

function draftFor(initialField: string | undefined, editing: IndexInfo | undefined): IndexDraft {
  if (editing !== undefined) {
    return draftFromIndex(editing);
  }
  return initialField === undefined
    ? EMPTY_INDEX_DRAFT
    : { ...EMPTY_INDEX_DRAFT, fields: [{ field: initialField, order: '1' }] };
}

const ORDER_LABELS: Readonly<Record<IndexOrder, string>> = {
  '1': 'Ascending (1)',
  '-1': 'Descending (-1)',
  text: 'Text',
  '2dsphere': '2dsphere',
  hashed: 'Hashed',
  '2d': '2d',
};

const ORDER_DATA = INDEX_ORDERS.map((value) => ({ value, label: ORDER_LABELS[value] }));
const SUGGESTION_SAMPLE = 20;
const BOX = {
  border: '1px solid var(--mg-border)',
  borderRadius: 'var(--mantine-radius-md)',
  background: 'var(--mg-surface-1)',
};

/** The shell form of the previewed spec: createIndex(key, options). */
function createIndexCommand(collection: string, command: Record<string, unknown>): string {
  const [spec] = command.indexes as [Record<string, unknown>];
  const { key, ...options } = spec;
  const lines = [`db.${collection}.createIndex(`, `  ${formatJson(key).trimEnd()}`];
  if (Object.keys(options).length > 0) {
    lines[1] += ',';
    lines.push(`  ${formatJson(options).trimEnd().replace(/\n/g, '\n  ')}`);
  }
  lines.push(')');
  return lines.join('\n');
}

function isIndexOrder(value: string | null): value is IndexOrder {
  return INDEX_ORDERS.some((order) => order === value);
}

/**
 * Builds an index from a key builder, options, and a read-only preview of the command. With
 * `editing`, it replaces an existing index: saving drops that index, then creates the new one.
 */
export function CreateIndexDialog({
  connectionId,
  database,
  collection,
  initialField,
  editing,
  onClose,
}: CreateIndexDialogProps) {
  const { rpc } = useUiApi();
  const [draft, setDraft] = useState<IndexDraft>(() => draftFor(initialField, editing));
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dropped, setDropped] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [ttlOn, setTtlOn] = useState(draft.ttlSeconds.trim() !== '');
  const [partialOn, setPartialOn] = useState(draft.partialEjson.trim() !== '');
  const [wildcardOn, setWildcardOn] = useState(
    draft.wildcardEjson.trim() !== '' || draft.fields.some((item) => item.field.includes('$**')),
  );
  const request = buildIndexRequest(draft);
  const keyFields = draft.fields.map((item) => item.field.trim()).filter((field) => field !== '');
  const previewName =
    request.ok && draft.name.trim() === '' ? defaultNameFor(request.keys) : draft.name.trim();

  useEffect(() => {
    let active = true;
    rpc.management
      .sampleDocuments({ connectionId, database, collection, limit: SUGGESTION_SAMPLE })
      .then(
        (documents) => {
          if (active) {
            setSuggestions(topLevelKeys(documents));
          }
        },
        () => {
          // Suggestions are a convenience. Typing a field name works without them.
        },
      );
    return () => {
      active = false;
    };
  }, [rpc, connectionId, database, collection]);

  function update(patch: Partial<IndexDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function setField(index: number, patch: Partial<IndexDraft['fields'][number]>) {
    update({
      fields: draft.fields.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    });
  }

  async function submit() {
    // Enter in a field submits the form even while a save runs. A second run could drop twice.
    if (busy) {
      return;
    }
    if (!request.ok) {
      setError(request.message);
      return;
    }
    setBusy(true);
    setError(undefined);
    // Whether the old index is gone by now. A failed create after the drop leaves it gone, so a
    // retry skips the drop.
    let removed = dropped;
    try {
      if (editing !== undefined && !dropped) {
        await rpc.management.dropIndex({ connectionId, database, collection, name: editing.name });
        removed = true;
        setDropped(true);
      }
      await rpc.management.createIndex({
        connectionId,
        database,
        collection,
        keys: request.keys,
        options: request.options,
      });
      onClose();
    } catch (failure) {
      setError(
        editing !== undefined && removed
          ? `The index ${editing.name} was dropped, but the new index was not created. ${errorText(failure)}`
          : errorText(failure),
      );
    } finally {
      setBusy(false);
    }
  }

  const preview = request.ok
    ? createIndexCommand(collection, previewCommand(collection, request))
    : `db.${collection}.createIndex({})`;

  return (
    <Modal
      opened
      onClose={onClose}
      title={
        editing === undefined
          ? `New index on ${database}.${collection}`
          : `Edit index ${editing.name}`
      }
      centered
      size={790}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap="lg">
          {editing === undefined ? null : (
            <Alert color="yellow" variant="light">
              MongoDB cannot change an index in place. Saving drops {editing.name} and creates the
              new definition. If the create fails after the drop, the collection has no{' '}
              {editing.name} index until you save a definition that works.
            </Alert>
          )}
          <Stack gap="sm" p="md" style={BOX}>
          <Text size="sm" fw={500} c="dimmed">
            Keys
          </Text>
          {draft.fields.map((item, index) => (
            <Group key={index} gap="sm" wrap="nowrap" align="center">
              <Text size="sm" c="dimmed" w={12}>
                {index + 1}
              </Text>
              <Autocomplete
                ff="monospace"
                aria-label={`Field ${index + 1}`}
                placeholder="Field name"
                data={suggestions}
                value={item.field}
                onChange={(value) => setField(index, { field: value })}
                style={{ flex: 1 }}
                autoComplete="off"
              />
              <Select
                aria-label={`Order of field ${index + 1}`}
                data={ORDER_DATA}
                value={item.order}
                onChange={(value) => {
                  if (isIndexOrder(value)) {
                    setField(index, { order: value });
                  }
                }}
                allowDeselect={false}
                w={180}
              />
              <ActionIcon
                aria-label="Remove field"
                variant="subtle"
                color="red"
                disabled={draft.fields.length === 1}
                onClick={() =>
                  update({ fields: draft.fields.filter((_, position) => position !== index) })
                }
              >
                <IconTrash size={14} />
              </ActionIcon>
            </Group>
          ))}
          <Group gap="md">
            <Button
              variant="subtle"
              leftSection={<IconPlus size={14} />}
              onClick={() => update({ fields: [...draft.fields, { field: '', order: '1' }] })}
            >
              Add key
            </Button>
            <Text size="xs" c="dimmed">
              Types: ascending, descending, text, 2dsphere, hashed, wildcard
            </Text>
          </Group>
          </Stack>

          <Group grow align="flex-start" gap="md">
          <TextInput
            label="Name"
            description="Generated from the keys when empty. Type to override."
            placeholder={previewName}
            value={draft.name}
            onChange={(event) => update({ name: event.currentTarget.value })}
            autoComplete="off"
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
          <TextInput
            label="Collation"
            aria-label="Collation as EJSON"
            description="Server default when empty"
            placeholder='{ "locale": "en" }'
            value={draft.collationEjson}
            onChange={(event) => update({ collationEjson: event.currentTarget.value })}
            autoComplete="off"
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
          </Group>

          <Stack gap="md" p="md" style={BOX}>
            <Text size="sm" fw={500} c="dimmed">
              Options
            </Text>
            <SimpleGrid cols={3} spacing="sm" verticalSpacing="sm">
              <Checkbox
                label="Unique"
                description="Reject documents with a duplicate key"
                checked={draft.unique}
                onChange={(event) => update({ unique: event.currentTarget.checked })}
              />
              <Checkbox
                label="Sparse"
                description="Skip documents without the field"
                checked={draft.sparse}
                onChange={(event) => update({ sparse: event.currentTarget.checked })}
              />
              <Checkbox
                label="Hidden"
                description="Build now, let the planner use it later"
                checked={draft.hidden}
                onChange={(event) => update({ hidden: event.currentTarget.checked })}
              />
              <Checkbox
                label="TTL"
                description="Needs a single date key"
                checked={ttlOn}
                onChange={(event) => {
                  setTtlOn(event.currentTarget.checked);
                  if (!event.currentTarget.checked) {
                    update({ ttlSeconds: '' });
                  }
                }}
              />
              <Checkbox
                label="Partial filter"
                description="Index only matching documents"
                checked={partialOn}
                onChange={(event) => {
                  setPartialOn(event.currentTarget.checked);
                  if (!event.currentTarget.checked) {
                    update({ partialEjson: '' });
                  }
                }}
              />
              <Checkbox
                label="Wildcard projection"
                description="Only for $** keys"
                checked={wildcardOn}
                onChange={(event) => {
                  setWildcardOn(event.currentTarget.checked);
                  if (!event.currentTarget.checked) {
                    update({ wildcardEjson: '' });
                  }
                }}
              />
            </SimpleGrid>
            {ttlOn ? (
              <NumberInput
                label="Expire after seconds (TTL)"
                min={0}
                allowDecimal={false}
                value={draft.ttlSeconds}
                onChange={(value) => update({ ttlSeconds: String(value) })}
              />
            ) : null}
            {partialOn ? (
              <Stack gap={4}>
                <Text size="sm">Only index documents that match</Text>
                <JsonEditor
                  label="Partial filter expression as EJSON"
                  height={72}
                  value={draft.partialEjson}
                  onChange={(value) => update({ partialEjson: value })}
                />
              </Stack>
            ) : null}
            {wildcardOn ? (
              <JsonEditor
                label="Wildcard projection as EJSON"
                height={72}
                value={draft.wildcardEjson}
                onChange={(value) => update({ wildcardEjson: value })}
              />
            ) : null}
          </Stack>

          {hasTextKey(draft) ? (
            <Group grow align="flex-start">
              <Textarea
                label="Text weights"
                description="One field: weight per line"
                value={draft.weights}
                onChange={(event) => update({ weights: event.currentTarget.value })}
                autosize
                minRows={2}
              />
              <TextInput
                label="Default language"
                placeholder="english"
                value={draft.defaultLanguage}
                onChange={(event) => update({ defaultLanguage: event.currentTarget.value })}
              />
            </Group>
          ) : null}

          <Stack gap="sm">
            <Text size="sm" fw={500} c="dimmed">
              Command
            </Text>
            <JsonEditor label="createIndexes command preview" readOnly height={150} value={preview} />
          </Stack>

          {request.ok || keyFields.length === 0 ? null : (
            <Text size="xs" c="red">
              {request.message}
            </Text>
          )}
          {error === undefined ? null : (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Text size="xs" c="dimmed" maw={340}>
              Reads and writes continue during the build. Progress shows in the Indexes panel.
            </Text>
            <Group gap="sm" wrap="nowrap">
            <Button
              variant="default"
              leftSection={<IconCopy size={14} />}
              onClick={() => void navigator.clipboard.writeText(preview)}
            >
              Copy command
            </Button>
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!request.ok} loading={busy} type="submit">
              {editing === undefined ? 'Create index' : 'Replace index'}
            </Button>
            </Group>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
