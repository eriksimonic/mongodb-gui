import { Button, Group, Progress, Stack, Text } from '@mantine/core';
import { useEffect } from 'react';
import { useAppStore } from '../../state/app-store-context';
import { listTransfers, transferFraction, type TransferView } from '../../state/transfer-state';
import { runReported } from '../notify-error';
import { countLine, statusLine } from './transfer-model';

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

function TransferLine({ view }: { view: TransferView }) {
  const cancelTransfer = useAppStore((state) => state.cancelTransfer);
  const progress = view.progress;
  const fraction = transferFraction(progress);
  const label =
    view.kind === 'import'
      ? `Import into ${view.database}.${view.collection}`
      : `Export ${view.database}.${view.collection}`;
  return (
    <Stack gap={4} data-testid={`transfer-${view.transferId}`}>
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={500} truncate>
          {label}
        </Text>
        <Text size="xs" c="dimmed">
          {statusLine(progress)}
        </Text>
      </Group>
      <Progress
        value={progress.done ? 100 : fraction === undefined ? 100 : fraction * 100}
        animated={!progress.done && fraction === undefined}
        color={progress.error === undefined || progress.error.code === 'CANCELLED' ? 'blue' : 'red'}
        size="sm"
        aria-label={`${label} progress`}
      />
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          {countLine(progress)}
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
