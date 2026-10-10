import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Stepper,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  MAX_IMPORT_BATCH_SIZE,
  toAppError,
  type AppError,
  type ImportFormat,
  type ImportMode,
  type ImportPreview,
  type TransferProgress,
} from '@mongo-gui/core';
import { useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { useAppStore } from '../../state/app-store-context';
import { errorText } from '../notify-error';
import { TransferProgressView } from './TransferProgressView';
import { cellText, DELIMITER_LABELS, DELIMITERS, FORMAT_LABELS } from './transfer-model';
import {
  csvOptionsFor,
  DEFAULT_IMPORT_DRAFT,
  FIELD_TYPES,
  importOptionsFor,
  importProblemsOf,
  isAbsolutePath,
  mappingRowsFrom,
  targetCollection,
  type FormatChoice,
  type ImportDraft,
  type ImportProblem,
  type MappingRow,
} from './import-model';

const PREVIEW_ROWS = 20;
const STEP_LABELS = ['Choose file', 'Preview and mapping', 'Options and run'] as const;
const DATA_FILE_FILTER = {
  name: 'JSON, NDJSON or CSV',
  extensions: ['json', 'ndjson', 'jsonl', 'csv'],
};

export interface ImportWizardProps {
  readonly connectionId: string;
  readonly database: string;
  /** Undefined creates the collection under the name typed in the first step. */
  readonly collection: string | undefined;
  readonly onClose: () => void;
}

/** Modal with the three steps of an import. A running import stays in the Output panel if closed. */
export function ImportWizard(props: ImportWizardProps) {
  return (
    <Modal opened onClose={props.onClose} title="Import data" size="xl" centered>
      <ImportWizardBody {...props} />
    </Modal>
  );
}

/** The wizard without its modal, so the steps can be tested and shown on their own. */
export function ImportWizardBody({
  connectionId,
  database,
  collection,
  onClose,
}: ImportWizardProps) {
  const { rpc } = useUiApi();
  const startTransferImport = useAppStore((state) => state.startTransferImport);
  const cancelTransfer = useAppStore((state) => state.cancelTransfer);
  const selectTree = useAppStore((state) => state.select);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<ImportDraft>({ ...DEFAULT_IMPORT_DRAFT });
  const [preview, setPreview] = useState<ImportPreview | undefined>(undefined);
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | undefined>(undefined);
  const [transferId, setTransferId] = useState<string | undefined>(undefined);
  const view = useAppStore((state) =>
    transferId === undefined ? undefined : state.transfers[transferId],
  );

  const collectionIsNew = collection === undefined;
  const target = targetCollection(draft, collection);
  const running = transferId !== undefined;
  const done = view?.progress.done === true;

  function patch(next: Partial<ImportDraft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  async function browse() {
    setError(undefined);
    try {
      const picked = await rpc.app.showOpenDialog({
        title: 'Choose a file to import',
        filters: [DATA_FILE_FILTER],
      });
      if (picked.path !== undefined) {
        patch({ path: picked.path });
      }
    } catch (failure) {
      setError(toError(failure));
    }
  }

  async function previewFile() {
    setError(undefined);
    if (!isAbsolutePath(draft.path)) {
      setError({ code: 'VALIDATION', message: 'Choose a file' });
      return;
    }
    if (collectionIsNew && target === '') {
      setError({ code: 'VALIDATION', message: 'Name the new collection' });
      return;
    }
    setBusy(true);
    try {
      const format = draft.formatChoice === 'auto' ? undefined : draft.formatChoice;
      const result = await rpc.transfer.previewImport({
        connectionId,
        path: draft.path,
        ...(format === undefined ? {} : { format }),
        ...(format === 'csv' ? { csv: csvOptionsFor(draft.csv) } : {}),
        sampleRows: PREVIEW_ROWS,
      });
      // With the format left to detect, the sniffed CSV settings replace the form values.
      if (
        draft.formatChoice === 'auto' &&
        result.detectedFormat === 'csv' &&
        result.csv !== undefined
      ) {
        patch({
          csv: {
            delimiter: result.csv.delimiter,
            hasHeader: result.csv.hasHeader,
            trim: result.csv.trim,
            nullText: result.csv.nullValues.filter((value) => value !== '').join(', '),
          },
        });
      }
      setPreview(result);
      setRows(mappingRowsFrom(result));
      setStep(1);
    } catch (failure) {
      setError(toError(failure));
    } finally {
      setBusy(false);
    }
  }

  const mappingProblems = importProblemsOf(draft, rows, collectionIsNew).filter(
    (problem) =>
      problem.field === 'mapping' || problem.field === 'upsertKey' || problem.field === 'batchSize',
  );
  const optionProblems = importProblemsOf(draft, rows, collectionIsNew).filter(
    (problem) => problem.field === 'upsertKey' || problem.field === 'batchSize',
  );

  async function start() {
    if (preview === undefined) {
      return;
    }
    setError(undefined);
    setBusy(true);
    try {
      const started = await startTransferImport({
        connectionId,
        database,
        collection: target,
        path: draft.path,
        options: importOptionsFor(draft, preview.detectedFormat, rows),
      });
      setTransferId(started);
    } catch (failure) {
      setError(toError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (transferId === undefined) {
      return;
    }
    try {
      await cancelTransfer(transferId);
    } catch (failure) {
      setError(toError(failure));
    }
  }

  function reset() {
    setTransferId(undefined);
    setPreview(undefined);
    setRows([]);
    setError(undefined);
    setDraft((current) => ({
      ...DEFAULT_IMPORT_DRAFT,
      csv: current.csv,
      path: '',
      newCollection: current.newCollection,
    }));
    setStep(0);
  }

  function openCollection() {
    selectTree({ connectionId, database, collection: target });
    onClose();
  }

  if (running) {
    return (
      <Stack gap="md">
        <Stepper active={2} allowNextStepsSelect={false} size="xs">
          {STEP_LABELS.map((label) => (
            <Stepper.Step key={label} label={label} />
          ))}
        </Stepper>
        <Title order={5}>Importing into {`${database}.${target}`}</Title>
        {view === undefined ? (
          <Text size="sm" c="dimmed">
            Starting the import
          </Text>
        ) : (
          <TransferProgressView
            kind="import"
            progress={view.progress}
            onCancel={() => {
              void cancel();
            }}
          />
        )}
        {done && view !== undefined ? (
          <ImportSummary
            progress={view.progress}
            database={database}
            collection={target}
            onOpen={openCollection}
            onAgain={reset}
            onClose={onClose}
          />
        ) : null}
        {error === undefined ? null : (
          <Alert color="red" role="alert">
            {errorText(error)}
          </Alert>
        )}
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <Stepper active={step} allowNextStepsSelect={false} size="xs">
        {STEP_LABELS.map((label) => (
          <Stepper.Step key={label} label={label} />
        ))}
      </Stepper>
      {step === 0 ? (
        <ChooseFileStep
          draft={draft}
          collectionIsNew={collectionIsNew}
          database={database}
          target={target}
          onChange={patch}
          onBrowse={() => {
            void browse();
          }}
        />
      ) : null}
      {step === 1 && preview !== undefined ? (
        <MappingStep
          preview={preview}
          rows={rows}
          problems={mappingProblems}
          onRowsChange={setRows}
        />
      ) : null}
      {step === 2 ? (
        <OptionsStep
          draft={draft}
          target={target}
          rowCount={preview?.estimatedRows}
          problems={optionProblems}
          onChange={patch}
        />
      ) : null}
      {error === undefined ? null : (
        <Alert color="red" role="alert">
          {errorText(error)}
        </Alert>
      )}
      <Group justify="space-between">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Group>
          {step > 0 ? (
            <Button
              variant="default"
              disabled={busy}
              onClick={() => {
                setError(undefined);
                setStep(step - 1);
              }}
            >
              Back
            </Button>
          ) : null}
          {step === 0 ? (
            <Button loading={busy} onClick={() => void previewFile()}>
              Next
            </Button>
          ) : null}
          {step === 1 ? (
            <Tooltip label={mappingProblems[0]?.message} disabled={mappingProblems.length === 0}>
              <Button
                disabled={mappingProblems.length > 0}
                onClick={() => {
                  setError(undefined);
                  setStep(2);
                }}
              >
                Next
              </Button>
            </Tooltip>
          ) : null}
          {step === 2 ? (
            <Tooltip label={optionProblems[0]?.message} disabled={optionProblems.length === 0}>
              <Button
                disabled={optionProblems.length > 0 || preview === undefined}
                loading={busy}
                onClick={() => void start()}
              >
                Start import
              </Button>
            </Tooltip>
          ) : null}
        </Group>
      </Group>
    </Stack>
  );
}

function toError(failure: unknown): AppError {
  return toAppError(failure);
}

export interface ChooseFileStepProps {
  readonly draft: ImportDraft;
  readonly collectionIsNew: boolean;
  readonly database: string;
  readonly target: string;
  readonly onChange: (patch: Partial<ImportDraft>) => void;
  readonly onBrowse: () => void;
}

const FORMAT_CHOICES: { value: FormatChoice; label: string }[] = [
  { value: 'auto', label: 'Detect from the file' },
  { value: 'json-array', label: FORMAT_LABELS['json-array'] },
  { value: 'ndjson', label: FORMAT_LABELS.ndjson },
  { value: 'csv', label: FORMAT_LABELS.csv },
];

/** Step one: the file, its format, the CSV options, and the new collection name. */
export function ChooseFileStep({
  draft,
  collectionIsNew,
  database,
  target,
  onChange,
  onBrowse,
}: ChooseFileStepProps) {
  const csvShown =
    draft.formatChoice === 'csv' ||
    (draft.formatChoice === 'auto' && draft.path.toLowerCase().endsWith('.csv'));
  return (
    <Stack gap="sm">
      <Group align="flex-end" wrap="nowrap">
        <TextInput
          label="File path"
          placeholder="Choose a file"
          value={draft.path}
          readOnly
          style={{ flex: 1 }}
        />
        <Button variant="default" onClick={onBrowse}>
          Browse
        </Button>
      </Group>
      <Select
        label="Format"
        data={FORMAT_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))}
        value={draft.formatChoice}
        onChange={(value) => {
          if (value !== null) {
            onChange({ formatChoice: value as FormatChoice });
          }
        }}
        allowDeselect={false}
      />
      {csvShown ? (
        <Stack gap="xs" aria-label="CSV options">
          <Select
            label="Delimiter"
            data={DELIMITERS.map((value) => ({ value, label: DELIMITER_LABELS[value] }))}
            value={draft.csv.delimiter}
            onChange={(value) => {
              if (value !== null) {
                onChange({
                  csv: { ...draft.csv, delimiter: value as ImportDraft['csv']['delimiter'] },
                  formatChoice: 'csv',
                });
              }
            }}
            allowDeselect={false}
          />
          <Switch
            label="First row is a header"
            checked={draft.csv.hasHeader}
            onChange={(event) =>
              onChange({
                csv: { ...draft.csv, hasHeader: event.currentTarget.checked },
                formatChoice: 'csv',
              })
            }
          />
          <Switch
            label="Trim spaces around values"
            checked={draft.csv.trim}
            onChange={(event) =>
              onChange({
                csv: { ...draft.csv, trim: event.currentTarget.checked },
                formatChoice: 'csv',
              })
            }
          />
          <TextInput
            label="Null values"
            description="Comma separated. Empty cells are always null."
            value={draft.csv.nullText}
            onChange={(event) =>
              onChange({
                csv: { ...draft.csv, nullText: event.currentTarget.value },
                formatChoice: 'csv',
              })
            }
          />
        </Stack>
      ) : null}
      {collectionIsNew ? (
        <TextInput
          label="New collection name"
          description={`Created in ${database}`}
          value={draft.newCollection}
          onChange={(event) => onChange({ newCollection: event.currentTarget.value })}
        />
      ) : (
        <Text size="sm" c="dimmed">
          Target: {database}.{target}
        </Text>
      )}
    </Stack>
  );
}

export interface MappingStepProps {
  readonly preview: ImportPreview;
  readonly rows: readonly MappingRow[];
  readonly problems: readonly ImportProblem[];
  readonly onRowsChange: (rows: MappingRow[]) => void;
}

/** Step two: the sample rows, the warnings, and one line per source field to map. */
export function MappingStep({ preview, rows, problems, onRowsChange }: MappingStepProps) {
  const update = (index: number, next: Partial<MappingRow>) => {
    onRowsChange(rows.map((row, position) => (position === index ? { ...row, ...next } : row)));
  };
  return (
    <Stack gap="md">
      {preview.warnings.length > 0 ? (
        <Alert color="yellow" title="Check before importing">
          <Stack gap={2}>
            {preview.warnings.map((warning) => (
              <Text key={warning} size="sm">
                {warning}
              </Text>
            ))}
          </Stack>
        </Alert>
      ) : null}
      <Text size="sm" c="dimmed">
        Detected {FORMAT_LABELS[preview.detectedFormat as ImportFormat]}
        {preview.estimatedRows === undefined
          ? ''
          : `, about ${preview.estimatedRows.toLocaleString('en-US')} records`}
        . Row numbers in errors count records, not lines.
      </Text>
      {rows.length === 0 ? (
        <Text size="sm">The file has no fields to map.</Text>
      ) : (
        <Table withTableBorder fz="sm" aria-label="Field mapping">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Source field</Table.Th>
              <Table.Th>Target field</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Skip</Table.Th>
              <Table.Th>Examples</Table.Th>
              <Table.Th>Nulls</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row, index) => (
              <Table.Tr key={row.source}>
                <Table.Td>{row.source}</Table.Td>
                <Table.Td>
                  <TextInput
                    aria-label={`Target for ${row.source}`}
                    size="xs"
                    value={row.target}
                    disabled={row.skip}
                    onChange={(event) => update(index, { target: event.currentTarget.value })}
                  />
                </Table.Td>
                <Table.Td>
                  <Select
                    aria-label={`Type for ${row.source}`}
                    size="xs"
                    data={FIELD_TYPES.map((type) => ({ value: type, label: type }))}
                    value={row.type}
                    allowDeselect={false}
                    disabled={row.skip}
                    description={
                      preview.detectedFormat !== 'csv' && row.type === row.inferredType && !row.skip
                        ? 'Inferred. Sent as auto.'
                        : undefined
                    }
                    onChange={(value) => {
                      if (value !== null) {
                        update(index, { type: value as MappingRow['type'] });
                      }
                    }}
                  />
                </Table.Td>
                <Table.Td>
                  <Switch
                    aria-label={`Skip ${row.source}`}
                    checked={row.skip}
                    onChange={(event) => update(index, { skip: event.currentTarget.checked })}
                  />
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed" lineClamp={1}>
                    {row.examples.join(', ')}
                  </Text>
                </Table.Td>
                <Table.Td>{row.nullCount}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {problems.length > 0 ? (
        <Stack gap={2}>
          {problems.map((problem) => (
            <Text key={problem.message} size="sm" c="red">
              {problem.message}
            </Text>
          ))}
        </Stack>
      ) : null}
      {preview.sampleRows.length > 0 ? (
        <SampleRows
          rows={preview.sampleRows}
          fields={rows.filter((row) => !row.skip).map((row) => row.source)}
        />
      ) : null}
    </Stack>
  );
}

function SampleRows({
  rows,
  fields,
}: {
  rows: readonly Record<string, unknown>[];
  fields: readonly string[];
}) {
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        Sample rows
      </Text>
      <div style={{ overflowX: 'auto' }}>
        <Table withTableBorder fz="xs" aria-label="Sample rows">
          <Table.Thead>
            <Table.Tr>
              {fields.map((field) => (
                <Table.Th key={field}>{field}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.slice(0, PREVIEW_ROWS).map((row, index) => (
              <Table.Tr key={index}>
                {fields.map((field) => (
                  <Table.Td key={field}>{cellText(row[field])}</Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
    </Stack>
  );
}

export interface OptionsStepProps {
  readonly draft: ImportDraft;
  readonly target: string;
  readonly rowCount: number | undefined;
  readonly problems: readonly ImportProblem[];
  readonly onChange: (patch: Partial<ImportDraft>) => void;
}

/** Step three: insert or upsert, the batch size, and whether an error stops the import. */
export function OptionsStep({ draft, target, rowCount, problems, onChange }: OptionsStepProps) {
  return (
    <Stack gap="sm">
      <Text size="sm">
        Importing{' '}
        {rowCount === undefined ? 'the file' : `about ${rowCount.toLocaleString('en-US')} records`}{' '}
        into <strong>{target}</strong>.
      </Text>
      <Select
        label="Mode"
        data={[
          { value: 'insert', label: 'Insert new documents' },
          { value: 'upsert', label: 'Replace documents that match the upsert key, or insert them' },
        ]}
        value={draft.mode}
        allowDeselect={false}
        onChange={(value) => {
          if (value !== null) {
            onChange({ mode: value as ImportMode });
          }
        }}
      />
      {draft.mode === 'upsert' ? (
        <TextInput
          label="Upsert key"
          description="A field of the target documents, for example _id or sku"
          value={draft.upsertKey}
          onChange={(event) => onChange({ upsertKey: event.currentTarget.value })}
        />
      ) : null}
      <NumberInput
        label="Batch size"
        description={`Documents written per round trip, 1 to ${MAX_IMPORT_BATCH_SIZE}`}
        min={1}
        max={MAX_IMPORT_BATCH_SIZE}
        value={draft.batchSize}
        onChange={(value) => {
          if (typeof value === 'number') {
            onChange({ batchSize: value });
          }
        }}
      />
      <Switch
        label="Stop at the first error"
        checked={draft.stopOnError}
        onChange={(event) => onChange({ stopOnError: event.currentTarget.checked })}
      />
      {problems.length > 0 ? (
        <Stack gap={2}>
          {problems.map((problem) => (
            <Text key={problem.message} size="sm" c="red">
              {problem.message}
            </Text>
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
}

export interface ImportSummaryProps {
  readonly progress: TransferProgress;
  readonly database: string;
  readonly collection: string;
  readonly onOpen: () => void;
  readonly onAgain: () => void;
  readonly onClose: () => void;
}

/** The result of a finished import, with the next steps the user can take. */
export function ImportSummary({
  progress,
  database,
  collection,
  onOpen,
  onAgain,
  onClose,
}: ImportSummaryProps) {
  const cancelled = progress.error?.code === 'CANCELLED';
  const failed = progress.error !== undefined && !cancelled;
  const message = cancelled
    ? `The import was cancelled. ${progress.inserted.toLocaleString('en-US')} documents were written and kept.`
    : `Inserted ${progress.inserted.toLocaleString('en-US')}, updated ${progress.updated.toLocaleString('en-US')}, failed ${progress.failed.toLocaleString('en-US')} of ${progress.processed.toLocaleString('en-US')} records into ${database}.${collection}.`;
  return (
    <Stack gap="sm" data-testid="import-summary">
      <Alert
        color={failed ? 'red' : cancelled || progress.failed > 0 ? 'yellow' : 'green'}
        title={failed ? 'The import stopped' : cancelled ? 'Cancelled' : 'Import finished'}
      >
        {message}
      </Alert>
      <Group justify="flex-end">
        <Button variant="default" onClick={onAgain}>
          Import another
        </Button>
        <Button variant="default" onClick={onOpen}>
          Open collection
        </Button>
        <Button onClick={onClose}>Close</Button>
      </Group>
    </Stack>
  );
}
