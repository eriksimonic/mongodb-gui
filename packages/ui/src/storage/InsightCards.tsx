import { Box, Group, Paper, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { formatBytes, formatTimestamp } from '../diagnostics/format';
import type { StorageInsights } from './insights';

export interface InsightCardsProps {
  readonly insights: StorageInsights;
  /** Indexes whose operation count the server did not report. */
  readonly unknownOps: number;
  /** False until at least one database's collections have loaded. */
  readonly hasLoaded: boolean;
}

/** Cards above the treemap, computed from the loaded collections only. */
export function InsightCards({ insights, unknownOps, hasLoaded }: InsightCardsProps) {
  const { topCollections, topIndexes, unusedIndexes, indexHeavyCollections, reclaimableSize } =
    insights;
  const unusedSince = earliestSince(unusedIndexes.items.map((index) => index.since));

  if (!hasLoaded) {
    return (
      <Text size="xs" c="dimmed">
        Open a database to load collections
      </Text>
    );
  }

  return (
    <Box
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 'var(--mantine-spacing-sm)',
      }}
    >
      <Card title="Biggest collections">
        {topCollections.length === 0 ? (
          <Empty text="No collections in the loaded databases." />
        ) : (
          topCollections.map((collection) => (
            <Line
              key={`${collection.database}.${collection.name}`}
              text={`${collection.database}.${collection.name}`}
              value={formatBytes(collection.storageSize)}
            />
          ))
        )}
      </Card>
      <Card title="Biggest indexes">
        {topIndexes.length === 0 ? (
          <Empty text="No indexes in the loaded databases." />
        ) : (
          topIndexes.map((index) => (
            <Line
              key={`${index.database}.${index.collection}.${index.name}`}
              text={`${index.database}.${index.collection} ${index.name}`}
              value={formatBytes(index.size)}
            />
          ))
        )}
      </Card>
      <Card title="Unused indexes">
        <Text size="sm" fw={600}>
          {`${unusedIndexes.items.length} ${unusedIndexes.items.length === 1 ? 'index' : 'indexes'}, ${formatBytes(unusedIndexes.totalSize)}`}
        </Text>
        {unusedIndexes.items.length === 0 ? (
          <Empty text="No index with zero operations." />
        ) : (
          unusedIndexes.items.map((index) => (
            <Line
              key={`${index.database}.${index.collection}.${index.name}`}
              text={`${index.database}.${index.collection} ${index.name}`}
              value={formatBytes(index.size)}
            />
          ))
        )}
        <Text size="xs" c="dimmed" mt={4}>
          {`Candidates to drop, not a verdict.${unusedSince === undefined ? '' : ` Counted since ${formatTimestamp(unusedSince)}.`}`}
        </Text>
        {unknownOps === 0 ? null : (
          <Text size="xs" c="dimmed">
            {`${unknownOps} ${unknownOps === 1 ? 'index' : 'indexes'} could not be checked.`}
          </Text>
        )}
      </Card>
      <Card title="Index larger than data">
        {indexHeavyCollections.length === 0 ? (
          <Empty text="No collection has more index than data." />
        ) : (
          indexHeavyCollections.map((collection) => (
            <Line
              key={`${collection.database}.${collection.name}`}
              text={`${collection.database}.${collection.name}`}
              value={`${formatBytes(collection.totalIndexSize)} / ${formatBytes(collection.dataSize)}`}
            />
          ))
        )}
      </Card>
      {reclaimableSize === null ? null : (
        <Card title="Reclaimable space">
          <Text size="sm" fw={600}>
            {formatBytes(reclaimableSize)}
          </Text>
          <Text size="xs" c="dimmed">
            Free space inside the data files, as the server reports it.
          </Text>
        </Card>
      )}
    </Box>
  );
}

interface CardProps {
  readonly title: string;
  readonly children: ReactNode;
}

function Card({ title, children }: CardProps) {
  return (
    <Paper withBorder p="sm" radius="md" bg="var(--mg-surface-1)" style={{ minWidth: 0 }}>
      <Stack gap={4}>
        <Text size="sm" fw={600} c="dimmed">
          {title}
        </Text>
        {children}
      </Stack>
    </Paper>
  );
}

interface LineProps {
  readonly text: string;
  readonly value: string;
}

function Line({ text, value }: LineProps) {
  return (
    <Group justify="space-between" gap="xs" wrap="nowrap">
      <Text size="xs" truncate="end">
        {text}
      </Text>
      <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
        {value}
      </Text>
    </Group>
  );
}

function Empty({ text }: { readonly text: string }) {
  return (
    <Text size="xs" c="dimmed">
      {text}
    </Text>
  );
}

/** The earliest valid ISO date among the values, as ISO text, or undefined. */
function earliestSince(values: readonly (string | null)[]): string | undefined {
  const times = values
    .filter((value): value is string => value !== null)
    .map((value) => Date.parse(value))
    .filter((time) => !Number.isNaN(time));
  return times.length === 0 ? undefined : new Date(Math.min(...times)).toISOString();
}
