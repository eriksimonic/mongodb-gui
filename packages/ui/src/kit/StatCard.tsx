import { Box, Text } from '@mantine/core';
import type { ReactNode } from 'react';

export interface StatCardProps {
  readonly label: string;
  readonly value: string;
  /** Monospace value, for a host name. */
  readonly mono?: boolean;
  /** A dimmed line under the value. */
  readonly children?: ReactNode;
}

/** A bordered card with a label, a large value and an optional dimmed line. */
export function StatCard({ label, value, mono = false, children }: StatCardProps) {
  return (
    <Box
      p="sm"
      style={{ border: '1px solid var(--mg-border)', borderRadius: 8 }}
      data-testid={`stat-${label}`}
    >
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fz={22} fw={600} ff={mono ? 'monospace' : 'text'}>
        {value}
      </Text>
      <Text size="xs" c="dimmed" mih={16}>
        {children}
      </Text>
    </Box>
  );
}
