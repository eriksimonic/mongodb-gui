import {
  Accordion,
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { type ValidationAction, type ValidationLevel } from '@mongo-gui/core';
import { errorText } from '../notify-error';
import { useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { JsonEditor } from '../../editor/JsonEditor';
import {
  buildCollectionRequest,
  EMPTY_COLLECTION_DRAFT,
  type CollectionDraft,
  type Granularity,
} from '../../management/collection-draft';
import { collectionNameError } from '../../management/input-rules';

export interface CreateCollectionDialogProps {
  readonly connectionId: string;
  readonly database: string;
  readonly onClose: () => void;
}

const LEVEL_OPTIONS: { value: ValidationLevel; label: string }[] = [
  { value: 'strict', label: 'Strict, every write' },
  { value: 'moderate', label: 'Moderate, existing invalid documents are skipped' },
  { value: 'off', label: 'Off' },
];

const ACTION_OPTIONS: { value: ValidationAction; label: string }[] = [
  { value: 'error', label: 'Error, reject the write' },
  { value: 'warn', label: 'Warn, log and accept' },
];

const GRANULARITY_OPTIONS: { value: Granularity; label: string }[] = [
  { value: 'seconds', label: 'Seconds' },
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
];

/** Create a collection with optional capped, time series and clustered settings. */
export function CreateCollectionDialog({
  connectionId,
  database,
  onClose,
}: CreateCollectionDialogProps) {
  const { rpc } = useUiApi();
  const [draft, setDraft] = useState<CollectionDraft>(EMPTY_COLLECTION_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const nameProblem = draft.name === '' ? undefined : collectionNameError(draft.name.trim());
  const request = buildCollectionRequest(draft);

  function update(patch: Partial<CollectionDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function submit() {
    if (!request.ok) {
      setError(request.message);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await rpc.management.createCollection({ connectionId, database, ...request.value });
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title={`New collection in ${database}`} centered size="lg">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label="Collection name"
            value={draft.name}
            onChange={(event) => update({ name: event.currentTarget.value })}
            error={nameProblem}
            autoFocus
            autoComplete="off"
          />

          <Switch
            label="Capped collection"
            description="A fixed size. The oldest documents are overwritten when it is full."
            checked={draft.capped}
            onChange={(event) => update({ capped: event.currentTarget.checked, timeseries: false })}
          />
          {draft.capped ? (
            <Group grow align="flex-start">
              <NumberInput
                label="Size in bytes"
                min={1}
                allowDecimal={false}
                value={draft.cappedSizeBytes}
                onChange={(value) => update({ cappedSizeBytes: String(value) })}
              />
              <NumberInput
                label="Maximum documents"
                min={1}
                allowDecimal={false}
                value={draft.cappedMaxDocuments}
                onChange={(value) => update({ cappedMaxDocuments: String(value) })}
              />
            </Group>
          ) : null}

          <Switch
            label="Time series collection"
            checked={draft.timeseries}
            onChange={(event) => update({ timeseries: event.currentTarget.checked, capped: false })}
          />
          {draft.timeseries ? (
            <Group grow align="flex-start">
              <TextInput
                label="Time field"
                value={draft.timeField}
                onChange={(event) => update({ timeField: event.currentTarget.value })}
              />
              <TextInput
                label="Meta field"
                value={draft.metaField}
                onChange={(event) => update({ metaField: event.currentTarget.value })}
              />
              <Select
                label="Granularity"
                data={GRANULARITY_OPTIONS}
                value={draft.granularity === '' ? null : draft.granularity}
                onChange={(value) => update({ granularity: parseGranularity(value) })}
                clearable
              />
              <NumberInput
                label="Expire after seconds"
                min={1}
                allowDecimal={false}
                value={draft.expireAfterSeconds}
                onChange={(value) => update({ expireAfterSeconds: String(value) })}
              />
            </Group>
          ) : null}

          <Checkbox
            label="Clustered by _id"
            checked={draft.clustered}
            onChange={(event) => update({ clustered: event.currentTarget.checked })}
          />

          <Accordion variant="contained" multiple>
            <Accordion.Item value="collation">
              <Accordion.Control>Collation (EJSON)</Accordion.Control>
              <Accordion.Panel>
                <JsonEditor
                  label="Collation as EJSON"
                  height={120}
                  value={draft.collationEjson}
                  onChange={(value) => update({ collationEjson: value })}
                />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="validator">
              <Accordion.Control>Validator (EJSON)</Accordion.Control>
              <Accordion.Panel>
                <Stack gap="xs">
                  <JsonEditor
                    label="Validator as EJSON"
                    height={180}
                    value={draft.validatorEjson}
                    onChange={(value) => update({ validatorEjson: value })}
                  />
                  <Group grow align="flex-start">
                    <Select
                      label="Validation level"
                      data={LEVEL_OPTIONS}
                      value={draft.validationLevel}
                      onChange={(value) => update({ validationLevel: parseLevel(value) })}
                      allowDeselect={false}
                    />
                    <Select
                      label="Validation action"
                      data={ACTION_OPTIONS}
                      value={draft.validationAction}
                      onChange={(value) => update({ validationAction: parseAction(value) })}
                      allowDeselect={false}
                    />
                  </Group>
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>

          {error === undefined ? null : (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          {request.ok || nameProblem !== undefined || draft.name === '' ? null : (
            <Text size="xs" c="red">
              {request.message}
            </Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!request.ok} loading={busy} type="submit">
              Create collection
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function parseGranularity(value: string | null): Granularity | '' {
  return value === 'seconds' || value === 'minutes' || value === 'hours' ? value : '';
}

function parseLevel(value: string | null): ValidationLevel {
  return value === 'off' || value === 'moderate' ? value : 'strict';
}

function parseAction(value: string | null): ValidationAction {
  return value === 'warn' ? 'warn' : 'error';
}
