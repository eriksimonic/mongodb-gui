import { Box, Stack, Text } from '@mantine/core';
import { formatBytes } from '../diagnostics/format';

export interface DiskStripProps {
  /** The disk size. The panel does not render the strip when the server does not report it. */
  readonly totalBytes: number;
  /** Used disk space, or null when the server does not report it. */
  readonly usedBytes: number | null;
  /** Sum of the database sizes on disk, drawn inside the used part. */
  readonly databaseBytes: number;
}

/** A bar of the disk: grey for used space, blue for the databases inside it. */
export function DiskStrip({ totalBytes, usedBytes, databaseBytes }: DiskStripProps) {
  const percentOf = (bytes: number) => Math.min(100, Math.max(0, (bytes / totalBytes) * 100));
  const usedPercent = usedBytes === null ? 0 : percentOf(usedBytes);
  const databasePercent = percentOf(databaseBytes);
  const summary =
    usedBytes === null
      ? `Disk ${formatBytes(totalBytes)}, usage not reported.`
      : `Disk ${formatBytes(usedBytes)} used of ${formatBytes(totalBytes)}, ${formatBytes(totalBytes - usedBytes)} free.`;

  return (
    <Stack gap={4}>
      <Box
        role="img"
        aria-label={`${summary} Databases ${formatBytes(databaseBytes)}.`}
        style={{
          position: 'relative',
          height: 12,
          borderRadius: 4,
          overflow: 'hidden',
          background: 'var(--mg-surface-2)',
          border: '1px solid var(--mg-border)',
        }}
      >
        <Box
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${usedPercent}%`,
            background: 'var(--mg-border-strong)',
          }}
        />
        <Box
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${databasePercent}%`,
            background: 'var(--mg-series-1)',
          }}
        />
      </Box>
      <Text size="xs" c="dimmed">
        {`${summary} Databases ${formatBytes(databaseBytes)}.`}
      </Text>
    </Stack>
  );
}
