import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  ActionIcon,
} from '@mantine/core';
import type { ShardCollectionSummary } from '@mongo-gui/core';
import { useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { createShardingStore, type ShardCollectionTarget } from '../../sharding/sharding-store';
import { errorText } from '../notify-error';

export interface ShardCollectionDialogProps {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly onClose: () => void;
}

type KeyKind = 'ranged' | 'descending' | 'hashed';

interface KeyPart {
  readonly id: number;
  readonly field: string;
  readonly kind: KeyKind;
}

const KIND_OPTIONS: readonly { value: KeyKind; label: string }[] = [
  { value: 'ranged', label: 'Ranged ascending (1)' },
  { value: 'descending', label: 'Ranged descending (-1)' },
  { value: 'hashed', label: 'Hashed' },
];

const KIND_VALUE: Record<KeyKind, 1 | -1 | 'hashed'> = {
  ranged: 1,
  descending: -1,
  hashed: 'hashed',
};

/** The key as Extended JSON, or undefined while a field name is empty or repeated. */
function keyEjsonOf(parts: readonly KeyPart[]): string | undefined {
  const fields = parts.map((part) => part.field.trim());
  if (fields.length === 0 || fields.some((field) => field === '')) {
    return undefined;
  }
  if (new Set(fields).size !== fields.length) {
    return undefined;
  }
  const key = Object.fromEntries(parts.map((part) => [part.field.trim(), KIND_VALUE[part.kind]]));
  return JSON.stringify(key);
}

/**
 * Shards one collection. The user builds the key, previews what the server will do, types the
 * namespace, and only then can apply. Changing the key or the options drops the preview.
 */
export function ShardCollectionDialog({
  connectionId,
  database,
  collection,
  onClose,
}: ShardCollectionDialogProps) {
  const { rpc } = useUiApi();
  const [store] = useState(() => createShardingStore(connectionId, rpc.sharding));
  const namespace = `${database}.${collection}`;
  const [parts, setParts] = useState<KeyPart[]>([{ id: 1, field: '', kind: 'ranged' }]);
  const [nextId, setNextId] = useState(2);
  const [unique, setUnique] = useState(false);
  const [presplit, setPresplit] = useState(false);
  const [typed, setTyped] = useState('');
  const [preview, setPreview] = useState<
    { signature: string; summary: ShardCollectionSummary } | undefined
  >(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const hashed = parts.some((part) => part.kind === 'hashed');
  const keyEjson = keyEjsonOf(parts);
  // The unique and presplit options only apply to the key they were chosen with.
  const uniqueAllowed = !hashed;
  const presplitAllowed = hashed;
  const target: ShardCollectionTarget | undefined =
    keyEjson === undefined
      ? undefined
      : {
          database,
          collection,
          keyEjson,
          unique: uniqueAllowed && unique,
          presplitHashedZones: presplitAllowed && presplit,
        };
  const signature = target === undefined ? undefined : JSON.stringify(target);
  const previewCurrent = preview !== undefined && preview.signature === signature;
  const applyEnabled = previewCurrent && typed === namespace && !busy;

  function updatePart(id: number, change: Partial<Omit<KeyPart, 'id'>>) {
    setParts((current) => current.map((part) => (part.id === id ? { ...part, ...change } : part)));
    setPreview(undefined);
  }

  async function runPreview() {
    if (target === undefined) {
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const summary = await store.getState().previewShardCollection(target);
      setPreview({ signature: JSON.stringify(target), summary });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (target === undefined) {
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      await store.getState().applyShardCollection(target);
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title="Shard collection" centered size="lg">
      <Stack gap="sm">
        <Text size="sm">
          Collection <strong>{namespace}</strong>. Shard it on a key the queries filter on.
        </Text>
        {error === undefined ? null : (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Stack gap={6}>
          <Text size="sm" fw={500}>
            Shard key
          </Text>
          {parts.map((part, index) => (
            <Group key={part.id} gap="xs" wrap="nowrap" align="flex-end">
              <TextInput
                label={`Field ${index + 1}`}
                aria-label={`Field ${index + 1}`}
                value={part.field}
                onChange={(event) => updatePart(part.id, { field: event.currentTarget.value })}
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1 }}
              />
              <Select
                label="Kind"
                aria-label={`Kind of field ${index + 1}`}
                data={KIND_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                value={part.kind}
                allowDeselect={false}
                onChange={(value) => {
                  const kind = KIND_OPTIONS.find((option) => option.value === value);
                  if (kind !== undefined) {
                    updatePart(part.id, { kind: kind.value });
                  }
                }}
                style={{ flex: 1 }}
              />
              <ActionIcon
                variant="default"
                size="lg"
                aria-label={`Remove field ${index + 1}`}
                disabled={parts.length === 1}
                onClick={() => {
                  setParts((current) => current.filter((item) => item.id !== part.id));
                  setPreview(undefined);
                }}
              >
                ×
              </ActionIcon>
            </Group>
          ))}
          <Group>
            <Button
              size="xs"
              variant="default"
              onClick={() => {
                setParts((current) => [...current, { id: nextId, field: '', kind: 'ranged' }]);
                setNextId((value) => value + 1);
                setPreview(undefined);
              }}
            >
              Add field
            </Button>
          </Group>
          {keyEjson === undefined ? (
            <Text size="xs" c="dimmed">
              Name each field once. The key needs at least one field.
            </Text>
          ) : null}
        </Stack>
        <Checkbox
          label="Unique"
          checked={unique}
          disabled={!uniqueAllowed}
          onChange={(event) => {
            setUnique(event.currentTarget.checked);
            setPreview(undefined);
          }}
          description={uniqueAllowed ? undefined : 'A hashed key cannot be unique.'}
        />
        <Checkbox
          label="Presplit hashed zones"
          checked={presplit}
          disabled={!presplitAllowed}
          onChange={(event) => {
            setPresplit(event.currentTarget.checked);
            setPreview(undefined);
          }}
          description={presplitAllowed ? undefined : 'Available with a hashed key.'}
        />
        <Group>
          <Button
            variant="default"
            disabled={target === undefined}
            loading={busy}
            onClick={() => void runPreview()}
          >
            Preview
          </Button>
        </Group>
        {preview === undefined ? null : (
          <Stack gap={4} aria-label="Preview">
            {preview.summary.warnings.map((warning) => (
              <Alert key={warning} color="yellow" variant="light">
                {warning}
              </Alert>
            ))}
            <Text size="sm" fw={500}>
              What the server will do
            </Text>
            <Text size="xs" ff="monospace">
              {preview.summary.keyText}
            </Text>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {preview.summary.steps.map((step) => (
                <li key={step}>
                  <Text size="sm">{step}</Text>
                </li>
              ))}
            </ul>
          </Stack>
        )}
        <TextInput
          label={`Type ${namespace} to confirm`}
          aria-label={`Type ${namespace} to confirm`}
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button color="blue" disabled={!applyEnabled} loading={busy} onClick={() => void apply()}>
            Apply
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
