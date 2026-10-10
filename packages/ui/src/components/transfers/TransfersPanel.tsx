import { Badge, Button, Group, Progress, Stack, Text } from '@mantine/core';
import type { TransferProgress } from '@mongo-gui/core';
import { useEffect } from 'react';
import { useAppStore } from '../../state/app-store-context';
import { listTransfers, transferFraction, type TransferView } from '../../state/transfer-state';
import { runReported } from '../notify-error';
import { progressLine, statusLine } from './transfer-model';

/**
 * Imports and exports of this session, running ones first, with a cancel button for each one
 * that is still running. Progress comes from transfer:progress events.
 */
export function TransfersPanel() {
  const transfers = useAppStore((state) => state.transfers);
  const refreshTransfers = useAppStore((state) => state.refreshTransfers);
  useEffect(() => {
    void runReported(refreshTransfers);
  }, [refreshTransfers]);
  const views = listTransfers(transfers);
  if (views.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        No transfers yet.
      </Text>
    );
  }
  return (
    <Stack gap="sm" aria-label="Transfers">
      {views.map((view) => (
        <TransferLine key={view.transferId} view={view} />
      ))}
    </Stack>
  );
}

/** Blue while running or done, red on failure, grey when the user cancelled. */
function barColor(progress: TransferProgress): string {
  if (progress.error?.code === 'CANCELLED') {
    return 'gray';
  }
  return progress.error === undefined ? 'blue' : 'red';
}

/** The name of a transfer as the list shows it. GridFS jobs name their file and bucket. */
function transferLabel(view: TransferView): string {
  if (view.kind === 'import') {
    return `Import into ${view.database}.${view.collection}`;
  }
  if (view.kind === 'export') {
    return `Export ${view.database}.${view.collection}`;
  }
  const name = view.path.split(/[\\/]/).pop() ?? view.path;
  return view.kind === 'gridfs-upload'
    ? `Upload ${name} to ${view.database} · ${view.collection}`
    : `Download ${name} from ${view.database} · ${view.collection}`;
}

/** One transfer with its progress bar and a cancel button while it runs. Also used by GridFS. */
export function TransferLine({ view }: { view: TransferView }) {
  const cancelTransfer = useAppStore((state) => state.cancelTransfer);
  const progress = view.progress;
  const fraction = transferFraction(progress);
  const label = transferLabel(view);
  return (
    <Stack gap={4} data-testid={`transfer-${view.transferId}`}>
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={500} truncate>
          {label}
        </Text>
        {progress.error?.code === 'CANCELLED' ? (
          <Badge color="gray" variant="light" size="sm">
            Cancelled
          </Badge>
        ) : (
          <Text size="xs" c="dimmed">
            {statusLine(progress)}
          </Text>
        )}
      </Group>
      <Progress
        value={progress.done ? 100 : fraction === undefined ? 100 : fraction * 100}
        animated={!progress.done && fraction === undefined}
        color={barColor(progress)}
        size="sm"
        aria-label={`${label} progress`}
      />
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          {progressLine(view.kind, progress)}
          {progress.failed > 0 ? `, ${progress.failed.toLocaleString('en-US')} failed` : ''}
        </Text>
        {progress.done ? null : (
          <Button
            variant="subtle"
            size="xs"
            onClick={() => {
              void runReported(() => cancelTransfer(view.transferId));
            }}
          >
            Cancel
          </Button>
        )}
      </Group>
    </Stack>
  );
}

/** A finished GridFS job as one line: the file, the outcome and the bytes. */
export function TransferSummaryLine({ view }: { view: TransferView }) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      gap="sm"
      data-testid={`transfer-${view.transferId}`}
    >
      <Text size="xs" truncate>
        {transferLabel(view)}
      </Text>
      <Group gap="sm" wrap="nowrap">
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {statusLine(view.progress)}
        </Text>
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {progressLine(view.kind, view.progress)}
        </Text>
      </Group>
    </Group>
  );
}
