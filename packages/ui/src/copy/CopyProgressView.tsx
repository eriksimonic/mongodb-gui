import {
  Alert,
  Anchor,
  Button,
  Code,
  Collapse,
  Group,
  Progress,
  ScrollArea,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import type { CopyProgress } from '@mongo-gui/core';
import { useState } from 'react';
import { errorText } from '../kit/notify-error';
import type { CopyItemState, CopyItemStatus, CopyJob } from './copy-store';

const STATUS_LABELS: Readonly<Record<CopyItemStatus, string>> = {
  queued: 'Queued',
  copying: 'Copying',
  done: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

export interface CopyProgressViewProps {
  /** Undefined before the first event arrives. The view then shows that the copy is starting. */
  readonly job: CopyJob | undefined;
  /** Undefined hides the cancel button, for example in a test that only reads the view. */
  readonly onCancel?: (() => void) | undefined;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** The service sends the cancelled flag and a CANCELLED error together. Either one means cancelled. */
function isCancelled(progress: CopyProgress): boolean {
  return progress.cancelled || progress.error?.code === 'CANCELLED';
}

/** Documents handled over the job total. Undefined without a usable total, so the bar has no value. */
function documentFractionOf(progress: CopyProgress): number | undefined {
  const total = progress.totalDocuments;
  if (!total) {
    return undefined;
  }
  return Math.min(1, progress.processedDocuments / total);
}

/** Collections done over collections. A stopped job without a total shows this. */
function collectionFractionOf(progress: CopyProgress): number {
  return progress.collectionsTotal === 0 ? 0 : progress.collectionsDone / progress.collectionsTotal;
}

/**
 * The document counts of the top line. While the job runs, a live position reads as processed,
 * with the restored count when it differs. The final line keeps the restored count.
 */
function documentsTextOf(progress: CopyProgress, running: boolean): string {
  const total =
    progress.totalDocuments === undefined ? '' : ` of ${count(progress.totalDocuments)}`;
  if (!running) {
    return `${count(progress.documents)}${total} documents`;
  }
  const restored =
    progress.documents === progress.processedDocuments
      ? ''
      : `, ${count(progress.documents)} restored`;
  return `${count(progress.processedDocuments)}${total} processed${restored}`;
}

/** A bar with a value. Without one it is animated and has no aria-valuenow. */
function BarOf({
  label,
  percent,
  size,
}: {
  readonly label: string;
  readonly percent: number | undefined;
  readonly size: 'sm' | 'md';
}) {
  if (percent !== undefined) {
    return <Progress value={percent} size={size} aria-label={label} />;
  }
  return (
    <Progress.Root size={size} role="progressbar" aria-label={label}>
      <Progress.Section value={100} striped animated withAria={false} />
    </Progress.Root>
  );
}

function resultTitle(result: CopyProgress): string {
  if (isCancelled(result)) {
    return 'Cancelled';
  }
  return result.error === undefined ? 'Copy finished' : 'The copy failed';
}

/** Green when it worked, yellow when cancelled or some documents failed, red when it failed. */
function resultColor(result: CopyProgress): 'blue' | 'yellow' | 'red' {
  if (result.error !== undefined && !isCancelled(result)) {
    return 'red';
  }
  return isCancelled(result) || result.failedDocuments > 0 ? 'yellow' : 'blue';
}

/** The line above the bar while the job runs. The summary alert titles a finished job. */
function headingOf(job: CopyJob | undefined): string {
  const progress = job?.progress;
  if (progress === undefined) {
    return 'Starting';
  }
  if (progress.phase === 'preparing') {
    return 'Preparing';
  }
  return progress.current === undefined ? 'Copying' : `Copying ${progress.current}`;
}

/** Progress, collections, log and result of a copy job. The copy progress dialog shows it. */
export function CopyProgressView({ job, onCancel }: CopyProgressViewProps) {
  const [logOpen, setLogOpen] = useState(false);
  const progress = job?.progress;
  const result = job?.result;
  // The final event carries every note of the job, so it wins over the latest progress event.
  const warnings = result?.notes ?? progress?.notes ?? [];
  const running = result === undefined;
  const fraction = progress === undefined ? undefined : documentFractionOf(progress);
  let percent: number | undefined = 0;
  if (result !== undefined && result.error === undefined && !isCancelled(result)) {
    percent = 100;
  } else if (running) {
    percent = fraction === undefined ? undefined : fraction * 100;
  } else if (progress !== undefined) {
    percent = (fraction ?? collectionFractionOf(progress)) * 100;
  }
  return (
    <Stack gap="sm" data-testid="copy-progress">
      {running ? (
        <Text size="sm" fw={500}>
          {headingOf(job)}
        </Text>
      ) : null}
      <BarOf label="Copy progress" percent={percent} size="md" />
      {progress === undefined ? null : (
        <Text size="sm" c="dimmed">
          {documentsTextOf(progress, running)}, {count(progress.skippedDocuments)} skipped
          {progress.failedDocuments > 0 ? `, ${count(progress.failedDocuments)} failed` : ''},{' '}
          {progress.collectionsDone} of {progress.collectionsTotal} collections, elapsed{' '}
          {(progress.elapsedMs / 1000).toFixed(1)} s
        </Text>
      )}
      {job === undefined || job.itemStates.length === 0 ? null : (
        <ScrollArea.Autosize mah={260}>
          <Table withTableBorder aria-label="Collections">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Collection</Table.Th>
                <Table.Th>Documents</Table.Th>
                <Table.Th>Skipped</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Progress</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {job.itemStates.map((item) => (
                <ItemRow key={item.target} item={item} />
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      )}
      {warnings.map((warning, index) => (
        <Alert key={index} color="yellow" role="status">
          {warning}
        </Alert>
      ))}
      {running && onCancel !== undefined ? (
        <Group justify="flex-end">
          <Button color="red" variant="light" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      ) : null}
      {job === undefined || job.lines.length === 0 ? null : (
        <Stack gap={4}>
          <Anchor
            component="button"
            type="button"
            size="sm"
            aria-expanded={logOpen}
            onClick={() => {
              setLogOpen((open) => !open);
            }}
          >
            {logOpen ? 'Hide log' : 'Show log'}
          </Anchor>
          <Collapse in={logOpen}>
            <ScrollArea h={160} type="auto">
              <Code
                block
                data-testid="copy-log"
                style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}
              >
                {job.lines.join('\n')}
              </Code>
            </ScrollArea>
          </Collapse>
        </Stack>
      )}
      {result === undefined ? null : <JobSummary result={result} hasNotes={warnings.length > 0} />}
    </Stack>
  );
}

/** An item's share of its own documents. The copying item has no value until its total is known. */
function itemPercentOf(item: CopyItemState): number | undefined {
  if (item.status === 'done') {
    return 100;
  }
  if (item.status !== 'copying') {
    return 0;
  }
  if (!item.total) {
    return undefined;
  }
  return Math.min(100, (item.processed / item.total) * 100);
}

function ItemRow({ item }: { readonly item: CopyItemState }) {
  const name = item.source === item.target ? item.target : `${item.source} to ${item.target}`;
  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm" truncate>
          {name}
        </Text>
      </Table.Td>
      <Table.Td>{count(item.documents)}</Table.Td>
      <Table.Td>{count(item.skipped)}</Table.Td>
      <Table.Td>{STATUS_LABELS[item.status]}</Table.Td>
      <Table.Td>
        <BarOf label={`Progress for ${name}`} percent={itemPercentOf(item)} size="sm" />
      </Table.Td>
    </Table.Tr>
  );
}

/**
 * The end of the job. A stopped job counts documents that a replace or a merge may have rolled
 * back, so its counts read as "processed before the stop". Notes mean the target may be partly
 * written, so they replace the claim about what stays.
 */
function JobSummary({
  result,
  hasNotes,
}: {
  readonly result: CopyProgress;
  readonly hasNotes: boolean;
}) {
  const color = resultColor(result);
  const stopped = result.error !== undefined || isCancelled(result);
  const tally = stopped
    ? `Processed ${count(result.documents)} documents before the stop`
    : `Copied ${count(result.documents)} documents`;
  const keptLine = hasNotes
    ? 'The target may be partly written. Read the warnings above.'
    : 'Collections that finished stay in the target. The collection being written when the job stopped may be partly filled.';
  return (
    <Alert color={color} title={resultTitle(result)} role={color === 'red' ? 'alert' : 'status'}>
      <Stack gap={4}>
        {result.error !== undefined && !isCancelled(result) ? (
          <Text size="sm">{errorText(result.error)}</Text>
        ) : null}
        <Text size="sm">
          {tally} in {result.collectionsDone} of {result.collectionsTotal} collections.{' '}
          {count(result.skippedDocuments)} skipped
          {result.failedDocuments > 0 ? `, ${count(result.failedDocuments)} failed` : ''}. Took{' '}
          {(result.elapsedMs / 1000).toFixed(1)} s.
        </Text>
        {stopped ? <Text size="sm">{keptLine}</Text> : null}
      </Stack>
    </Alert>
  );
}
