import {
  ActionIcon,
  Alert,
  Button,
  Checkbox,
  Code,
  Group,
  Modal,
  NumberInput,
  Progress,
  Select,
  Stack,
  TagsInput,
  Text,
  TextInput,
} from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import {
  DEFAULT_GENERATE_COUNT,
  GENERATOR_TYPES,
  MAX_GENERATE_COUNT,
  MAX_GENERATE_FIELDS,
  MAX_PICK_VALUES,
  type GenerateProgress,
  type GeneratorSpec,
} from '@mongo-gui/core';
import { useEffect, useRef, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { errorText } from '../notify-error';
import {
  defaultGenerator,
  GENERATOR_LABELS,
  jobInputResult,
  newFieldDraft,
  previewDocuments,
  starterFields,
  type FieldDraft,
} from './generate-model';
import { useGenerateDialog, type GenerateTarget } from './generate-store';

const MAX_PATH_DEPTH = 6;

/** Renders the generate-data dialog while the store holds a target. */
export function GenerateDataDialog() {
  const target = useGenerateDialog((state) => state.target);
  if (target === undefined) {
    return null;
  }
  return (
    <GenerateDataModal
      key={`${target.connectionId}/${target.database}/${target.collection}`}
      target={target}
    />
  );
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}

/** Number inputs hold text while the user types. An empty input becomes NaN, which the schema refuses. */
function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number.NaN;
}

interface RunningJob {
  readonly jobId: string;
  readonly total: number;
}

function GenerateDataModal({ target }: { readonly target: GenerateTarget }) {
  const { rpc, onEvent } = useUiApi();
  const close = useGenerateDialog((state) => state.close);
  const [count, setCount] = useState<number | string>(DEFAULT_GENERATE_COUNT);
  const [seed, setSeed] = useState<number | string>(randomSeed);
  const [fields, setFields] = useState<FieldDraft[]>(starterFields);
  const [preview, setPreview] = useState<string[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<RunningJob | undefined>(undefined);
  const [progress, setProgress] = useState<GenerateProgress | undefined>(undefined);
  // The job id is known only when the start call returns, and an event can arrive before that.
  // Progress for an id not yet known waits here, so the final event is never lost.
  const jobIdRef = useRef<string | undefined>(undefined);
  const earlyProgress = useRef(new Map<string, GenerateProgress>());

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type !== 'generate:progress') {
          return;
        }
        if (event.jobId === jobIdRef.current) {
          setProgress(event.progress);
        } else {
          earlyProgress.current.set(event.jobId, event.progress);
        }
      }),
    [onEvent],
  );

  const running = job !== undefined && progress?.done !== true;
  const finished = progress?.done === true;

  function draft() {
    return {
      connectionId: target.connectionId,
      database: target.database,
      collection: target.collection,
      count,
      seed,
      fields,
    };
  }

  function patchField(id: string, patch: Partial<FieldDraft>) {
    setFields((current) =>
      current.map((field) => (field.id === id ? { ...field, ...patch } : field)),
    );
  }

  function moveField(index: number, delta: number) {
    setFields((current) => {
      const destination = index + delta;
      if (destination < 0 || destination >= current.length) {
        return current;
      }
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved !== undefined) {
        next.splice(destination, 0, moved);
      }
      return next;
    });
  }

  function previewClick() {
    const result = jobInputResult(draft());
    if (!result.ok) {
      setPreview(undefined);
      setProblem(result.message);
      return;
    }
    setProblem(undefined);
    setPreview(previewDocuments(result.value.fields, result.value.seed));
  }

  async function startClick() {
    const result = jobInputResult(draft());
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    setProblem(undefined);
    setStarting(true);
    try {
      const started = await rpc.generate.start(result.value);
      jobIdRef.current = started.jobId;
      const known = earlyProgress.current.get(started.jobId);
      if (known !== undefined) {
        setProgress(known);
      }
      setJob({ jobId: started.jobId, total: result.value.count });
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setStarting(false);
    }
  }

  function cancelClick() {
    if (job === undefined) {
      return;
    }
    rpc.generate.cancel({ jobId: job.jobId }).catch((error: unknown) => {
      setProblem(errorText(error));
    });
  }

  return (
    <Modal
      opened
      onClose={() => {
        if (!running) {
          close();
        }
      }}
      title="Generate data"
      size="xl"
      centered
    >
      <Stack gap="md">
        <Text size="sm">
          Writes generated documents into {target.database}.{target.collection}. Each field has a
          name, a generator and an optional unique flag. A dotted name such as address.city writes a
          nested field.
        </Text>

        <Group align="flex-end" grow>
          <NumberInput
            label="Documents"
            value={count}
            min={1}
            max={MAX_GENERATE_COUNT}
            allowDecimal={false}
            disabled={job !== undefined}
            onChange={setCount}
          />
          <NumberInput
            label="Seed"
            description="The same seed and fields give the same documents."
            value={seed}
            min={0}
            max={0xffff_ffff}
            allowDecimal={false}
            disabled={job !== undefined}
            onChange={setSeed}
          />
          <Button
            variant="default"
            leftSection={<IconRefresh size={16} />}
            disabled={job !== undefined}
            onClick={() => {
              setSeed(randomSeed());
            }}
          >
            New seed
          </Button>
        </Group>

        <Stack gap="xs">
          {fields.map((field, index) => (
            <Stack
              key={field.id}
              gap="xs"
              p="sm"
              style={{
                border: '1px solid var(--mantine-color-default-border)',
                borderRadius: 'var(--mantine-radius-sm)',
              }}
            >
              <Group align="flex-end" wrap="nowrap">
                <TextInput
                  label="Name"
                  placeholder="address.city"
                  value={field.name}
                  disabled={job !== undefined}
                  onChange={(event) => {
                    patchField(field.id, { name: event.currentTarget.value });
                  }}
                  style={{ flex: 1 }}
                />
                <Select
                  label="Generator"
                  allowDeselect={false}
                  data={GENERATOR_TYPES.map((type) => ({
                    value: type,
                    label: GENERATOR_LABELS[type],
                  }))}
                  value={field.generator.type}
                  disabled={job !== undefined}
                  onChange={(value) => {
                    const type = GENERATOR_TYPES.find((item) => item === value);
                    if (type !== undefined) {
                      patchField(field.id, { generator: defaultGenerator(type) });
                    }
                  }}
                  style={{ flex: 1 }}
                />
                <Checkbox
                  label="Unique"
                  checked={field.unique}
                  disabled={job !== undefined}
                  onChange={(event) => {
                    patchField(field.id, { unique: event.currentTarget.checked });
                  }}
                />
                <ActionIcon
                  variant="subtle"
                  aria-label="Move field up"
                  disabled={job !== undefined || index === 0}
                  onClick={() => {
                    moveField(index, -1);
                  }}
                >
                  <IconArrowUp size={16} />
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  aria-label="Move field down"
                  disabled={job !== undefined || index === fields.length - 1}
                  onClick={() => {
                    moveField(index, 1);
                  }}
                >
                  <IconArrowDown size={16} />
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label="Remove field"
                  disabled={job !== undefined || fields.length === 1}
                  onClick={() => {
                    setFields((current) => current.filter((item) => item.id !== field.id));
                  }}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
              <GeneratorOptions
                generator={field.generator}
                disabled={job !== undefined}
                onChange={(generator) => {
                  patchField(field.id, { generator });
                }}
              />
            </Stack>
          ))}
        </Stack>

        <Group>
          <Button
            variant="default"
            leftSection={<IconPlus size={16} />}
            disabled={job !== undefined || fields.length >= MAX_GENERATE_FIELDS}
            onClick={() => {
              setFields((current) => [
                ...current,
                newFieldDraft(`field${current.length + 1}`, 'word'),
              ]);
            }}
          >
            Add field
          </Button>
          <Button variant="default" disabled={job !== undefined} onClick={previewClick}>
            Preview
          </Button>
          {job === undefined ? (
            <Button loading={starting} onClick={() => void startClick()}>
              Start
            </Button>
          ) : null}
          {running ? (
            <Button color="red" variant="light" onClick={cancelClick}>
              Cancel job
            </Button>
          ) : null}
          <Button variant="default" disabled={running} onClick={close}>
            Close
          </Button>
        </Group>

        {problem !== undefined ? (
          <Alert color="red" role="alert">
            {problem}
          </Alert>
        ) : null}

        {preview !== undefined ? (
          <Stack gap="xs">
            <Text size="sm" fw={500}>
              Three sample documents. The preview runs in the window. The run writes ObjectIds as
              values, so the preview shows their hex text.
            </Text>
            {preview.map((document, index) => (
              <Code block key={index}>
                {document}
              </Code>
            ))}
          </Stack>
        ) : null}

        {job !== undefined ? <JobProgress progress={progress} total={job.total} /> : null}
        {finished && progress !== undefined ? <JobSummary progress={progress} /> : null}
      </Stack>
    </Modal>
  );
}

function JobProgress({
  progress,
  total,
}: {
  readonly progress: GenerateProgress | undefined;
  readonly total: number;
}) {
  const inserted = progress?.inserted ?? 0;
  const failed = progress?.failed ?? 0;
  const percent = total === 0 ? 0 : Math.min(100, ((inserted + failed) / total) * 100);
  return (
    <Stack gap="xs">
      <Progress value={percent} animated={progress?.done !== true} />
      <Text size="sm">
        {String(inserted)} of {String(total)} inserted
      </Text>
      <Text size="sm" c="dimmed">
        {String(progress?.ratePerSecond ?? 0)} documents per second, elapsed{' '}
        {((progress?.elapsedMs ?? 0) / 1000).toFixed(1)} s
      </Text>
    </Stack>
  );
}

function JobSummary({ progress }: { readonly progress: GenerateProgress }) {
  if (progress.error !== undefined) {
    return (
      <Alert color="red" role="alert">
        {errorText(progress.error)}. {String(progress.inserted)} documents were inserted before it
        stopped.
      </Alert>
    );
  }
  const seconds = (progress.elapsedMs / 1000).toFixed(1);
  const refused = progress.failed > 0 ? `, ${String(progress.failed)} refused by the server` : '';
  if (progress.cancelled) {
    return (
      <Alert color="yellow">
        Cancelled after {String(progress.inserted)} documents{refused}.
      </Alert>
    );
  }
  return (
    <Alert color="green">
      Inserted {String(progress.inserted)} documents in {seconds} s{refused}.
    </Alert>
  );
}

function GeneratorOptions({
  generator,
  disabled,
  onChange,
}: {
  readonly generator: GeneratorSpec;
  readonly disabled: boolean;
  readonly onChange: (next: GeneratorSpec) => void;
}) {
  switch (generator.type) {
    case 'integer':
      return (
        <Group grow>
          <NumberInput
            label="Min"
            value={generator.min}
            allowDecimal={false}
            disabled={disabled}
            onChange={(value) => {
              onChange({ ...generator, min: toNumber(value) });
            }}
          />
          <NumberInput
            label="Max"
            value={generator.max}
            allowDecimal={false}
            disabled={disabled}
            onChange={(value) => {
              onChange({ ...generator, max: toNumber(value) });
            }}
          />
        </Group>
      );
    case 'decimal':
      return (
        <Group grow>
          <NumberInput
            label="Min"
            value={generator.min}
            disabled={disabled}
            onChange={(value) => {
              onChange({ ...generator, min: toNumber(value) });
            }}
          />
          <NumberInput
            label="Max"
            value={generator.max}
            disabled={disabled}
            onChange={(value) => {
              onChange({ ...generator, max: toNumber(value) });
            }}
          />
          <NumberInput
            label="Precision"
            description="Decimal places"
            value={generator.precision}
            min={0}
            max={10}
            allowDecimal={false}
            disabled={disabled}
            onChange={(value) => {
              onChange({ ...generator, precision: toNumber(value) });
            }}
          />
        </Group>
      );
    case 'boolean':
      return (
        <NumberInput
          label="True probability"
          value={generator.trueProbability}
          min={0}
          max={1}
          step={0.05}
          decimalScale={2}
          disabled={disabled}
          onChange={(value) => {
            onChange({ ...generator, trueProbability: toNumber(value) });
          }}
        />
      );
    case 'dateTime':
      return (
        <Group grow>
          <TextInput
            label="From (ISO 8601)"
            value={generator.from}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...generator, from: event.currentTarget.value });
            }}
          />
          <TextInput
            label="To (ISO 8601)"
            value={generator.to}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...generator, to: event.currentTarget.value });
            }}
          />
        </Group>
      );
    case 'path':
      return (
        <Group grow>
          <NumberInput
            label="Directories"
            value={generator.depth}
            min={1}
            max={MAX_PATH_DEPTH}
            allowDecimal={false}
            disabled={disabled}
            onChange={(value) => {
              onChange({ ...generator, depth: toNumber(value) });
            }}
          />
          <TagsInput
            label="Extensions"
            value={generator.extensions}
            disabled={disabled}
            onChange={(extensions) => {
              onChange({ ...generator, extensions });
            }}
          />
        </Group>
      );
    case 'email':
      return (
        <TagsInput
          label="Domains"
          value={generator.domains}
          disabled={disabled}
          onChange={(domains) => {
            onChange({ ...generator, domains });
          }}
        />
      );
    case 'pick':
      return (
        <Group grow>
          <TagsInput
            label="Values"
            description={`Up to ${String(MAX_PICK_VALUES)}. Values are text.`}
            value={generator.values.map(String)}
            disabled={disabled}
            onChange={(values) => {
              // A new list of values drops the weights, which belong to the old list.
              onChange({ type: 'pick', values });
            }}
          />
          <TextInput
            label="Weights"
            description="Optional, comma separated, one per value"
            value={generator.weights?.join(', ') ?? ''}
            disabled={disabled}
            onChange={(event) => {
              const text = event.currentTarget.value.trim();
              if (text === '') {
                onChange({ type: 'pick', values: generator.values });
                return;
              }
              const weights = text.split(',').map((part) => Number(part.trim()));
              onChange({ type: 'pick', values: generator.values, weights });
            }}
          />
        </Group>
      );
    case 'sequence':
      return (
        <Group grow>
          <NumberInput
            label="Start"
            value={generator.start}
            allowDecimal={false}
            disabled={disabled}
            onChange={(value) => {
              onChange({ ...generator, start: toNumber(value) });
            }}
          />
          <NumberInput
            label="Step"
            value={generator.step}
            allowDecimal={false}
            disabled={disabled}
            onChange={(value) => {
              onChange({ ...generator, step: toNumber(value) });
            }}
          />
        </Group>
      );
    default:
      return null;
  }
}
