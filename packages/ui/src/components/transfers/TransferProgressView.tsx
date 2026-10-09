import { Alert, Button, Group, Progress, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import type { TransferKind, TransferProgress } from '@mongo-gui/core';
import { errorText } from '../notify-error';
import { transferFraction } from '../../state/transfer-state';
import { bytesLine, elapsedLine, errorsAsText } from './transfer-model';

export interface TransferProgressViewProps {
  readonly kind: TransferKind;
  readonly progress: TransferProgress;
  /** Shown while the transfer runs. Omitted once it has finished. */
  readonly onCancel?: (() => void) | undefined;
  readonly cancelling?: boolean;
}

const COUNTERS: { label: string; pick: (progress: TransferProgress) => number }[] = [
  { label: 'Processed', pick: (progress) => progress.processed },
  { label: 'Inserted', pick: (progress) => progress.inserted },
  { label: 'Updated', pick: (progress) => progress.updated },
  { label: 'Failed', pick: (progress) => progress.failed },
];

/** Counters only an import changes. An export shows the processed count alone. */
const IMPORT_ONLY = ['Inserted', 'Updated', 'Failed'];

/**
 * Live progress of one import or export. Row numbers in the error table count data records,
 * not lines in the file, because the backend counts records.
 */
export function TransferProgressView({
  kind,
  progress,
  onCancel,
  cancelling = false,
}: TransferProgressViewProps) {
  const fraction = transferFraction(progress);
  const bytes = bytesLine(progress);
  const running = !progress.done;
  return (
    <Stack gap="sm" data-testid="transfer-progress">
      {running ? (
        <Progress
          value={fraction === undefined ? 100 : fraction * 100}
          animated={fraction === undefined}
          striped={fraction === undefined}
          aria-label={kind === 'import' ? 'Import progress' : 'Export progress'}
        />
      ) : null}
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
        {COUNTERS.filter(
          (counter) => kind === 'import' || !IMPORT_ONLY.includes(counter.label),
        ).map((counter) => (
          <Stack key={counter.label} gap={0}>
            <Text size="xs" c="dimmed">
              {counter.label}
            </Text>
            <Text size="lg" fw={600} data-testid={`count-${counter.label.toLowerCase()}`}>
              {counter.pick(progress).toLocaleString('en-US')}
            </Text>
          </Stack>
        ))}
      </SimpleGrid>
      <Text size="sm" c="dimmed">
        {bytes === undefined ? null : `${bytes}. `}Elapsed {elapsedLine(progress)}
      </Text>
      {progress.warnings.length > 0 ? (
        <Stack gap={2}>
          {progress.warnings.map((warning) => (
            <Text key={warning} size="sm">
              {warning}
            </Text>
          ))}
        </Stack>
      ) : null}
      {progress.errors.length > 0 ? (
        <Stack gap="xs">
          <Group justify="space-between">
            <Text size="sm" fw={500}>
              First errors
            </Text>
            <Button
              variant="subtle"
              size="xs"
              onClick={() => {
                void copyText(errorsAsText(progress));
              }}
            >
              Copy all
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            Row numbers count data records, not lines in the file.
          </Text>
          <Table striped withTableBorder fz="sm" aria-label="Row errors">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Row</Table.Th>
                <Table.Th>Message</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {progress.errors.map((error) => (
                <Table.Tr key={`${error.row}-${error.message}`}>
                  <Table.Td>{error.row}</Table.Td>
                  <Table.Td>{error.message}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      ) : null}
      {progress.error !== undefined && progress.error.code !== 'CANCELLED' ? (
        <Alert color="red" role="alert" title="The transfer failed">
          {errorText(progress.error)}
        </Alert>
      ) : null}
      {running && onCancel !== undefined ? (
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel} loading={cancelling}>
            Cancel
          </Button>
        </Group>
      ) : null}
    </Stack>
  );
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The clipboard can be unavailable, for example in a test browser. The table stays readable.
  }
}
