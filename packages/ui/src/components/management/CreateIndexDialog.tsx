import {
  ActionIcon,
  Accordion,
  Alert,
  Autocomplete,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import type { IndexInfo } from '@mongo-gui/core';
import { errorText } from '../notify-error';
import { useEffect, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { JsonEditor } from '../../editor/JsonEditor';
import { formatJson } from '../../management/input-rules';
import { topLevelKeys } from '../../management/document-rows';
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
} from '../../management/index-builder';

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

  const preview = request.ok ? formatJson(previewCommand(collection, request)) : '{}\n';

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
      size="xl"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          {editing === undefined ? null : (
            <Alert color="yellow" variant="light">
              MongoDB cannot change an index in place. Saving drops {editing.name} and creates the
              new definition. If the create fails after the drop, the collection has no{' '}
              {editing.name} index until you save a definition that works.
            </Alert>
          )}
          <Text size="sm" fw={500}>
            Key fields
          </Text>
          {draft.fields.map((item, index) => (
            <Group key={index} gap="xs" wrap="nowrap" align="flex-end">
              <Autocomplete
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
          <Group>
            <Button
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => update({ fields: [...draft.fields, { field: '', order: '1' }] })}
            >
              Add field
            </Button>
            <Text size="xs" c="dimmed">
              Name: {keyFields.length === 0 ? '-' : previewName || '-'}
            </Text>
          </Group>

          <Group grow align="flex-start">
            <TextInput
              label="Index name"
              placeholder="Generated from the keys when empty"
              value={draft.name}
              onChange={(event) => update({ name: event.currentTarget.value })}
              autoComplete="off"
            />
            <NumberInput
              label="Expire after seconds (TTL)"
              min={0}
              allowDecimal={false}
              value={draft.ttlSeconds}
              onChange={(value) => update({ ttlSeconds: String(value) })}
            />
          </Group>
          <Group>
            <Checkbox
              label="Unique"
              checked={draft.unique}
              onChange={(event) => update({ unique: event.currentTarget.checked })}
            />
            <Checkbox
              label="Sparse"
              checked={draft.sparse}
              onChange={(event) => update({ sparse: event.currentTarget.checked })}
            />
            <Checkbox
              label="Hidden"
              checked={draft.hidden}
              onChange={(event) => update({ hidden: event.currentTarget.checked })}
            />
          </Group>

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

          <Accordion variant="contained" multiple>
            <Accordion.Item value="partial">
              <Accordion.Control>Partial filter (EJSON)</Accordion.Control>
              <Accordion.Panel>
                <JsonEditor
                  label="Partial filter expression as EJSON"
                  height={110}
                  value={draft.partialEjson}
                  onChange={(value) => update({ partialEjson: value })}
                />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="collation">
              <Accordion.Control>Collation (EJSON)</Accordion.Control>
              <Accordion.Panel>
                <JsonEditor
                  label="Collation as EJSON"
                  height={110}
                  value={draft.collationEjson}
                  onChange={(value) => update({ collationEjson: value })}
                />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="wildcard">
              <Accordion.Control>Wildcard projection (EJSON)</Accordion.Control>
              <Accordion.Panel>
                <JsonEditor
                  label="Wildcard projection as EJSON"
                  height={110}
                  value={draft.wildcardEjson}
                  onChange={(value) => update({ wildcardEjson: value })}
                />
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>

          <Text size="sm" fw={500}>
            Command preview
          </Text>
          <JsonEditor label="createIndexes command preview" readOnly height={200} value={preview} />

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
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!request.ok} loading={busy} type="submit">
              {editing === undefined ? 'Create index' : 'Replace index'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
