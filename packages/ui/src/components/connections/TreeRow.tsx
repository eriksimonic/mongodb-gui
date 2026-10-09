import { ActionIcon, Box, Group, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import type { MouseEvent, ReactNode } from 'react';

const INDENT_PX = 16;

export interface TreeRowProps {
  readonly depth: number;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly trailing?: ReactNode;
  readonly expandable?: boolean;
  readonly expanded?: boolean;
  readonly selected?: boolean;
  readonly onToggle?: () => void;
  readonly onSelect?: () => void;
  readonly onDoubleClick?: () => void;
  readonly onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
}

/** One line of the connection tree. Indents by depth and shows an expander when it has children. */
export function TreeRow({
  depth,
  label,
  icon,
  trailing,
  expandable = false,
  expanded = false,
  selected = false,
  onToggle,
  onSelect,
  onDoubleClick,
  onContextMenu,
}: TreeRowProps) {
  return (
    <Group
      gap={2}
      wrap="nowrap"
      h={24}
      pl={`${depth * INDENT_PX}px`}
      pr={4}
      bg={selected ? 'var(--mantine-primary-color-light)' : 'transparent'}
      style={{ borderRadius: 'var(--mantine-radius-sm)' }}
    >
      {expandable ? (
        <ActionIcon
          size="xs"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </ActionIcon>
      ) : (
        <Box w={18} />
      )}
      <UnstyledButton
        flex={1}
        miw={0}
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <Group gap={6} wrap="nowrap">
          {icon}
          <Text size="sm" truncate="end">
            {label}
          </Text>
        </Group>
      </UnstyledButton>
      {trailing}
    </Group>
  );
}

export interface TreeMessageProps {
  readonly depth: number;
  readonly tone?: 'dimmed' | 'red';
  readonly children: ReactNode;
}

/** A status line under a node: loading, not connected, or an error. */
export function TreeMessage({ depth, tone = 'dimmed', children }: TreeMessageProps) {
  return (
    <Text size="xs" c={tone} pl={`${depth * INDENT_PX + 24}px`} py={2} role="status">
      {children}
    </Text>
  );
}
