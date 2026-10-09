import { errorText } from '../notify-error';
import {
  Alert,
  Button,
  CopyButton,
  Group,
  Loader,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import {
  MAX_VALIDATION_SAMPLE_SIZE,
  type ValidationAction,
  type ValidationCheckResult,
  type ValidationLevel,
} from '@mongo-gui/core';
import { useEffect, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { JsonEditor } from '../../editor/JsonEditor';
import { formatJson, parseJsonObject } from '../../management/input-rules';
import { runReported } from '../notify-error';
import type { CollectionPanelProps } from './IndexesPanel';

const DEFAULT_SAMPLE_SIZE = 1000;

const LEVEL_OPTIONS: { value: ValidationLevel; label: string }[] = [
  { value: 'strict', label: 'Strict, every insert and update' },
  { value: 'moderate', label: 'Moderate, existing invalid documents are skipped' },
  { value: 'off', label: 'Off' },
];

const ACTION_OPTIONS: { value: ValidationAction; label: string }[] = [
  { value: 'error', label: 'Error, reject the write' },
  { value: 'warn', label: 'Warn, log and accept' },
];

interface Draft {
  readonly validatorEjson: string;
  readonly level: ValidationLevel;
  readonly action: ValidationAction;
}

interface Stored {
  readonly draft: Draft | undefined;
  readonly error: string | undefined;
}

function parseLevel(value: string | null): ValidationLevel {
  return value === 'off' || value === 'moderate' ? value : 'strict';
}

function parseAction(value: string | null): ValidationAction {
  return value === 'warn' ? 'warn' : 'error';
}

/** Validator, level and action for one collection, with a save and a check against a sample. */
export function ValidationPanel({ connectionId, database, collection }: CollectionPanelProps) {
  const { rpc } = useUiApi();
  const [stored, setStored] = useState<Stored>({ draft: undefined, error: undefined });
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [sampleSize, setSampleSize] = useState(String(DEFAULT_SAMPLE_SIZE));
  const [check, setCheck] = useState<ValidationCheckResult | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    rpc.management.getValidation({ connectionId, database, collection }).then(
      (rules) => {
        if (active) {
          const parsed = parseJsonObject(rules.validatorEjson);
          const loaded: Draft = {
            validatorEjson: parsed.ok ? formatJson(parsed.value) : rules.validatorEjson,
            level: rules.validationLevel,
            action: rules.validationAction,
          };
          setStored({ draft: loaded, error: undefined });
          setDraft(loaded);
        }
      },
      (failure: unknown) => {
        if (active) {
          setStored({ draft: undefined, error: errorText(failure) });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, connectionId, database, collection]);

  if (stored.error !== undefined) {
    return (
      <Alert color="red" variant="light" m="sm">
        {stored.error}
      </Alert>
    );
  }
  if (draft === undefined) {
    return <Loader size="xs" m="sm" aria-label="Loading validation" />;
  }
  const current: Draft = draft;

  const validatorProblem = parseJsonObject(draft.validatorEjson);
  const sampleValue = Number(sampleSize);
  const sampleProblem =
    Number.isInteger(sampleValue) && sampleValue >= 1 && sampleValue <= MAX_VALIDATION_SAMPLE_SIZE
      ? undefined
      : `Use a whole number from 1 to ${MAX_VALIDATION_SAMPLE_SIZE}`;

  function update(patch: Partial<Draft>) {
    setDraft((current) => (current === undefined ? current : { ...current, ...patch }));
    setCheck(undefined);
    // A message describes the last save or check. Once the draft changes, it no longer applies.
    setMessage(undefined);
  }

  function save() {
    if (!validatorProblem.ok) {
      setMessage(validatorProblem.message);
      return;
    }
    setBusy(true);
    setMessage(undefined);
    void runReported(async () => {
      try {
        await rpc.management.setValidation({
          connectionId,
          database,
          collection,
          rules: {
            validatorEjson: current.validatorEjson,
            validationLevel: current.level,
            validationAction: current.action,
          },
        });
        setStored({ draft: current, error: undefined });
        setMessage('Saved');
      } finally {
        setBusy(false);
      }
    });
  }

  function runCheck() {
    if (!validatorProblem.ok) {
      setMessage(validatorProblem.message);
      return;
    }
    if (sampleProblem !== undefined) {
      setMessage(sampleProblem);
      return;
    }
    setBusy(true);
    setMessage(undefined);
    void runReported(async () => {
      try {
        const result = await rpc.management.checkValidation({
          connectionId,
          database,
          collection,
          sampleSize: sampleValue,
          validatorEjson: current.validatorEjson,
        });
        setCheck(result);
      } finally {
        setBusy(false);
      }
    });
  }

  const dirty =
    stored.draft !== undefined && JSON.stringify(stored.draft) !== JSON.stringify(draft);
  const failingText = check?.failingIds.join('\n') ?? '';

  return (
    <Stack gap="sm" p="sm">
      <JsonEditor
        label="Validator as EJSON"
        height={260}
        value={draft.validatorEjson}
        onChange={(value) => update({ validatorEjson: value })}
      />
      <Group grow align="flex-start">
        <Select
          label="Validation level"
          data={LEVEL_OPTIONS}
          value={draft.level}
          onChange={(value) => update({ level: parseLevel(value) })}
          allowDeselect={false}
        />
        <Select
          label="Validation action"
          data={ACTION_OPTIONS}
          value={draft.action}
          onChange={(value) => update({ action: parseAction(value) })}
          allowDeselect={false}
        />
      </Group>

      <Group justify="space-between" align="flex-end">
        <Button disabled={!dirty || busy} loading={busy} onClick={save}>
          Save
        </Button>
        <Group align="flex-end" gap="xs">
          <NumberInput
            label="Sample size"
            min={1}
            max={MAX_VALIDATION_SAMPLE_SIZE}
            allowDecimal={false}
            value={sampleSize}
            onChange={(value) => setSampleSize(String(value))}
            error={sampleProblem}
            w={140}
          />
          <Button variant="light" disabled={busy} onClick={runCheck}>
            Check against sample
          </Button>
        </Group>
      </Group>

      {message === undefined ? null : (
        <Text size="sm" c={message === 'Saved' ? 'green' : 'red'}>
          {message}
        </Text>
      )}

      {check === undefined ? null : check.ok ? (
        <Alert color="green" variant="light">
          The sample passes the validator.
        </Alert>
      ) : (
        <Stack gap="xs">
          <Alert color="red" variant="light">
            {check.errors[0]?.message ?? 'Some sampled documents fail the validator.'}
          </Alert>
          <Textarea
            label="Failing _id values"
            description="The first 20 failing ids"
            value={failingText}
            readOnly
            autosize
            minRows={3}
            maxRows={8}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
          <CopyButton value={failingText}>
            {({ copied, copy }) => (
              <Button size="xs" variant="default" onClick={copy} w="fit-content">
                {copied ? 'Copied' : 'Copy ids'}
              </Button>
            )}
          </CopyButton>
        </Stack>
      )}
      {dirty ? (
        <Text size="xs" c="dimmed">
          The check uses the draft validator. Save to keep it.
        </Text>
      ) : null}
    </Stack>
  );
}
