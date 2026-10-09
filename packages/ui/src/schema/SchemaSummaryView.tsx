import { Box, Group, Paper, Stack, Text, useComputedColorScheme } from '@mantine/core';
import {
  formatCount,
  formatPercent,
  typeColor,
  typeBucket,
  type SchemaTotals,
  type TypeTotal,
} from './schema-model';

export interface SchemaSummaryViewProps {
  readonly totals: SchemaTotals;
  /** Values per BSON type across the top-level fields. */
  readonly topTypes: readonly TypeTotal[];
  /** Buckets the sample uses, in legend order. */
  readonly legend: readonly string[];
}

/** Stat tiles, the top-level type bars and the colour legend used by every type bar. */
export function SchemaSummaryView({ totals, topTypes, legend }: SchemaSummaryViewProps) {
  const largest = topTypes[0]?.count ?? 0;
  const scheme = useComputedColorScheme('dark');
  return (
    <Group align="stretch" gap="sm" wrap="nowrap" style={{ minHeight: 0 }}>
      <Stack gap="xs" w={240} style={{ flex: '0 0 240px' }}>
        <Group gap="xs" grow>
          <StatTile label="Fields" value={totals.fields} />
          <StatTile label="Mixed types" value={totals.mixed} />
        </Group>
        <Group gap="xs" grow>
          <StatTile label="Sparse under 50%" value={totals.sparse} />
          <StatTile label="Max depth" value={totals.maxDepth} />
        </Group>
      </Stack>
      <Paper withBorder p="xs" radius="sm" style={{ flex: 1, minWidth: 0 }}>
        <Text size="xs" fw={600} mb={4}>
          Values by type, top-level fields
        </Text>
        {topTypes.length === 0 ? (
          <Text size="xs" c="dimmed">
            No top-level fields in the sample.
          </Text>
        ) : (
          <Stack gap={4} role="list" aria-label="Values by type">
            {topTypes.map((item) => (
              <Group key={item.type} gap="xs" wrap="nowrap" role="listitem">
                <Text size="xs" w={96} truncate="end">
                  {item.type}
                </Text>
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Box
                    role="img"
                    aria-label={`${item.type}: ${formatCount(item.count)} values, ${formatPercent(item.share)}`}
                    style={{
                      height: 10,
                      width: `${largest === 0 ? 0 : Math.max(2, (item.count / largest) * 100)}%`,
                      background: typeColor(typeBucket(item.type), scheme),
                      borderRadius: 2,
                    }}
                  />
                </Box>
                <Text size="xs" c="dimmed" w={110} ta="right">
                  {formatCount(item.count)} ({formatPercent(item.share)})
                </Text>
              </Group>
            ))}
          </Stack>
        )}
        {legend.length === 0 ? null : (
          <Group gap="sm" mt={8} aria-label="Type colours">
            {legend.map((bucket) => (
              <Group key={bucket} gap={4} wrap="nowrap">
                <Box
                  aria-hidden="true"
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: typeColor(bucket, scheme),
                  }}
                />
                <Text size="xs" c="dimmed">
                  {bucket}
                </Text>
              </Group>
            ))}
          </Group>
        )}
      </Paper>
    </Group>
  );
}

function StatTile({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <Paper withBorder p="xs" radius="sm">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="lg" fw={600}>
        {formatCount(value)}
      </Text>
    </Paper>
  );
}
