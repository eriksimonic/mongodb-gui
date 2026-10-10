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
import type { BackupProgress, BackupResult } from '@mongo-gui/core';
import { useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { formatBytes } from '../../management/input-rules';
import { errorText, runReported } from '../notify-error';
import type { BackupJobView } from './use-backup-job';

const PHASE_LABELS: Record<BackupProgress['phase'], string> = {
  preparing: 'Preparing',
  verifying: 'Verifying the backup',
  running: 'Running',
  hashing: 'Computing the checksum',
  'writing-sidecar': 'Writing the description file',
  finished: 'Finished',
};

const SHORT_HASH_LENGTH = 12;

export interface BackupProgressViewProps {
  readonly view: BackupJobView | undefined;
  readonly kind: 'dump' | 'restore';
  /** Undefined hides the cancel button, for a finished job. */
  readonly onCancel?: () => void;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** Progress, log and result of a backup or restore job. Both dialogs show it once the job starts. */
export function BackupProgressView({ view, kind, onCancel }: BackupProgressViewProps) {
  const [logOpen, setLogOpen] = useState(false);
  const progress = view?.progress;
  const done = progress?.done === true;
  const warnings = view?.warnings ?? [];
  const percent = progress?.fraction === undefined ? 100 : progress.fraction * 100;
  return (
    <Stack gap="sm" data-testid="backup-progress">
      <Text size="sm" fw={500}>
        {progress === undefined ? 'Starting' : PHASE_LABELS[progress.phase]}
      </Text>
      <Progress
        value={done ? 100 : percent}
        striped={!done && progress?.fraction === undefined}
        animated={!done && progress?.fraction === undefined}
        aria-label={kind === 'dump' ? 'Backup progress' : 'Restore progress'}
      />
      {progress === undefined ? null : <Counters progress={progress} kind={kind} />}
      {progress === undefined || progress.active.length === 0 || done ? null : (
        <Stack gap={4}>
          {progress.active.map((item) => (
            <div key={item.namespace}>
              <Group justify="space-between" gap="xs" wrap="nowrap">
                <Text size="xs" truncate>
                  {item.namespace}
                </Text>
                <Text size="xs" c="dimmed">
                  {count(item.documents)}
                  {item.total === undefined ? '' : ` of ${count(item.total)}`}
                </Text>
              </Group>
              <Progress
                size="xs"
                value={
                  item.total === undefined || item.total === 0
                    ? 100
                    : Math.min(100, (item.documents / item.total) * 100)
                }
                striped={item.total === undefined}
                animated={item.total === undefined}
                aria-label={item.namespace}
              />
            </div>
          ))}
        </Stack>
      )}
      {warnings.map((warning, index) => (
        <Alert key={index} color="yellow" role="status">
          {warning}
        </Alert>
      ))}
      {!done && onCancel !== undefined ? (
        <Group justify="flex-end">
          <Button color="red" variant="light" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      ) : null}
      {view === undefined || view.lines.length === 0 ? null : (
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
              <Code block data-testid="backup-log" style={{ fontFamily: 'monospace' }}>
                {view.lines.join('\n')}
              </Code>
            </ScrollArea>
          </Collapse>
        </Stack>
      )}
      {done && progress !== undefined ? <JobResult progress={progress} kind={kind} /> : null}
    </Stack>
  );
}

function Counters({
  progress,
  kind,
}: {
  readonly progress: BackupProgress;
  readonly kind: 'dump' | 'restore';
}) {
  const documents =
    progress.totalDocuments === undefined
      ? count(progress.documents)
      : `${count(progress.documents)} of ${count(progress.totalDocuments)}`;
  const namespaces =
    progress.totalNamespaces === undefined
      ? count(progress.finishedNamespaces)
      : `${count(progress.finishedNamespaces)} of ${count(progress.totalNamespaces)}`;
  return (
    <Text size="sm" c="dimmed">
      {documents} documents, {namespaces} collections
      {kind === 'dump' ? `, ${formatBytes(progress.bytes)}` : ''}
      {progress.failedDocuments > 0 ? `, ${count(progress.failedDocuments)} failed` : ''}, elapsed{' '}
      {(progress.elapsedMs / 1000).toFixed(1)} s
    </Text>
  );
}

/** Green when it worked, yellow when cancelled or some documents failed, red otherwise. */
function resultColor(progress: BackupProgress): 'green' | 'yellow' | 'red' {
  if (progress.error !== undefined) {
    return progress.error.code === 'CANCELLED' ? 'yellow' : 'red';
  }
  if (progress.cancelled || progress.failedDocuments > 0) {
    return 'yellow';
  }
  if (progress.result?.kind === 'restore' && progress.result.failed > 0) {
    return 'yellow';
  }
  return 'green';
}

function JobResult({
  progress,
  kind,
}: {
  readonly progress: BackupProgress;
  readonly kind: 'dump' | 'restore';
}) {
  const { result } = progress;
  const color = resultColor(progress);
  const cancelled = progress.cancelled || progress.error?.code === 'CANCELLED';
  return (
    <Stack gap="sm" data-testid="backup-result">
      <Alert
        color={color}
        title={resultTitle(progress)}
        role={color === 'red' ? 'alert' : 'status'}
      >
        {progress.error !== undefined && !cancelled ? errorText(progress.error) : null}
        {cancelled ? 'The job was cancelled.' : null}
        {progress.failedDocuments > 0
          ? ` ${count(progress.failedDocuments)} documents failed.`
          : null}
      </Alert>
      {result?.kind === 'dump' ? <DumpResult result={result} /> : null}
      {result?.kind === 'restore' ? <RestoreResult result={result} /> : null}
      {cancelled && kind === 'restore' ? (
        <Text size="sm" c="dimmed">
          Collections already written stay in the target.
        </Text>
      ) : null}
    </Stack>
  );
}

function resultTitle(progress: BackupProgress): string {
  const kind = progress.result?.kind;
  if (progress.cancelled || progress.error?.code === 'CANCELLED') {
    return 'Cancelled';
  }
  if (progress.error !== undefined) {
    return kind === 'dump' ? 'The backup failed' : 'The job failed';
  }
  if (kind === 'restore') {
    return progress.result?.kind === 'restore' && progress.result.dryRun
      ? 'Dry run finished'
      : 'Restore finished';
  }
  return 'Backup finished';
}

function DumpResult({ result }: { readonly result: Extract<BackupResult, { kind: 'dump' }> }) {
  const { rpc } = useUiApi();
  const [copied, setCopied] = useState(false);
  return (
    <Stack gap={4}>
      <Text size="sm">
        Output <Code>{result.outputPath}</Code>
      </Text>
      <Text size="sm">
        Description <Code>{result.sidecarPath}</Code>
      </Text>
      <Text size="sm">
        {formatBytes(result.bytes)}, {count(result.documents)} documents in{' '}
        {count(result.namespaces)} collections
      </Text>
      {result.sha256 === undefined ? null : (
        <Group gap="xs">
          <Text size="sm">
            SHA-256 <Code title={result.sha256}>{result.sha256.slice(0, SHORT_HASH_LENGTH)}</Code>
          </Text>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => {
              const hash = result.sha256;
              if (hash !== undefined) {
                void runReported(async () => {
                  await navigator.clipboard.writeText(hash);
                  setCopied(true);
                });
              }
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </Group>
      )}
      <Group>
        <Button
          variant="default"
          onClick={() => {
            void runReported(() => rpc.app.showItemInFolder({ path: result.outputPath }));
          }}
        >
          Show in folder
        </Button>
      </Group>
    </Stack>
  );
}

function RestoreResult({
  result,
}: {
  readonly result: Extract<BackupResult, { kind: 'restore' }>;
}) {
  if (result.dryRun) {
    return (
      <Stack gap="xs">
        <Text size="sm">Nothing was written. The restore would write these namespaces.</Text>
        <ScrollArea.Autosize mah={220}>
          <Table withTableBorder data-testid="restore-plan">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>From</Table.Th>
                <Table.Th>To</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {result.plan.map((row) => (
                <Table.Tr key={`${row.from}>${row.to}`}>
                  <Table.Td>{row.from}</Table.Td>
                  <Table.Td>{row.to}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      </Stack>
    );
  }
  return (
    <Text size="sm">
      Restored {count(result.restored)} documents, {count(result.failed)} failed, into{' '}
      {result.databases.join(', ')}.
    </Text>
  );
}
