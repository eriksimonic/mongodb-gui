import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconCheck, IconCopy, IconRefresh } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { copyText } from './copy';
import type { Loadable } from './diagnostics-store';

export interface CopyIconProps {
  /** The text, or a function that builds it when the button is pressed. */
  readonly text: string | (() => string);
  readonly label: string;
}

/** An icon button that copies its text. It shows a check for a moment after the copy. */
export function CopyIcon({ text, label }: CopyIconProps) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip label={label} withArrow>
      <ActionIcon
        variant="subtle"
        size="sm"
        aria-label={label}
        onClick={() => {
          void copyText(typeof text === 'string' ? text : text(), 'Copied').then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </ActionIcon>
    </Tooltip>
  );
}

export interface RefreshButtonProps {
  readonly loading: boolean;
  readonly onRefresh: () => void;
}

export function RefreshButton({ loading, onRefresh }: RefreshButtonProps) {
  return (
    <Button
      variant="default"
      size="xs"
      leftSection={<IconRefresh size={14} />}
      loading={loading}
      onClick={onRefresh}
    >
      Refresh
    </Button>
  );
}

export interface LoadStateProps<T> {
  readonly state: Loadable<T>;
  readonly children: (data: T) => ReactNode;
}

/** Shows the loader before the first answer, the error text, or the data. */
export function LoadState<T>({ state, children }: LoadStateProps<T>) {
  if (state.data === undefined) {
    if (state.error !== undefined) {
      return (
        <Alert color="red" variant="light">
          {state.error}
        </Alert>
      );
    }
    return <Loader size="sm" />;
  }
  return (
    <>
      {state.error === undefined ? null : (
        <Alert color="red" variant="light" mb="xs">
          {state.error}
        </Alert>
      )}
      {children(state.data)}
    </>
  );
}

export interface KeyValueRow {
  readonly label: string;
  readonly value: ReactNode;
}

/** Label and value pairs, one per row. Values that are missing read as a dash. */
export function KeyValueTable({ rows }: { readonly rows: readonly KeyValueRow[] }) {
  return (
    <Table withTableBorder verticalSpacing={4} fz="sm" layout="fixed">
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row.label}>
            <Table.Td w="40%" c="dimmed">
              {row.label}
            </Table.Td>
            <Table.Td style={{ wordBreak: 'break-word' }}>
              {row.value === undefined || row.value === '' ? <Text c="dimmed">-</Text> : row.value}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export interface SectionProps {
  readonly title: string;
  readonly children: ReactNode;
}

/** A titled block inside a tab. */
export function Section({ title, children }: SectionProps) {
  return (
    <section>
      <Group justify="space-between" mb={4}>
        <Text fw={600} size="sm">
          {title}
        </Text>
      </Group>
      {children}
    </section>
  );
}

export interface ScrollLayoutProps {
  /** Stays in view while the content scrolls, so the search box and Refresh are always reachable. */
  readonly toolbar: ReactNode;
  readonly gap?: 'xs' | 'md';
  readonly children: ReactNode;
}

/** A tab body with a fixed toolbar and a scrolling content area under it. */
export function ScrollLayout({ toolbar, gap = 'xs', children }: ScrollLayoutProps) {
  return (
    <Stack gap={0} style={{ flex: 1, minHeight: 0 }}>
      <Box
        px="md"
        py="sm"
        style={{
          flexShrink: 0,
          borderBottom: '1px solid var(--mantine-color-default-border)',
        }}
      >
        {toolbar}
      </Box>
      <Stack gap={gap} px="md" py="sm" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {children}
      </Stack>
    </Stack>
  );
}

export interface ToolbarProps {
  readonly loading: boolean;
  readonly onRefresh: () => void;
  /** Inputs, selects, switches and actions, in that order. */
  readonly children?: ReactNode;
  /** Dimmed text at the right edge, such as a count or the time of the last read. */
  readonly status?: ReactNode;
}

/** The control row of every tab. Refresh comes first, so it is always in the same place. */
export function Toolbar({ loading, onRefresh, children, status }: ToolbarProps) {
  return (
    <Group gap={8} align="center" wrap="wrap">
      <RefreshButton loading={loading} onRefresh={onRefresh} />
      {children}
      {status === undefined ? null : (
        <Text size="xs" c="dimmed" ml="auto">
          {status}
        </Text>
      )}
    </Group>
  );
}
