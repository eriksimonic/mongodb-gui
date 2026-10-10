import { ActionIcon, Badge, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { CopyIcon, LoadState, RefreshButton } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import { formatTimestamp } from './format';
import { childEntries, matchingPaths } from './tree-search';

export interface ServerStatusTabProps {
  readonly store: DiagnosticsStore;
}

const INDENT_PX = 16;

/** The serverStatus document as an explorable tree, with a path search and copy of any subtree. */
export function ServerStatusTab({ store }: ServerStatusTabProps) {
  const state = useStore(store, (current) => current.serverStatus);
  const load = useStore(store, (current) => current.loadServerStatus);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => matchingPaths(state.data?.document, query), [state.data, query]);

  function toggle(path: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  return (
    <Stack gap="xs" p="sm">
      <Group gap="xs" align="flex-end">
        <TextInput
          aria-label="Search paths"
          placeholder="Search paths, for example wiredTiger.cache"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          w={360}
          size="xs"
        />
        <RefreshButton loading={state.loading} onRefresh={() => void load()} />
        {state.data === undefined ? null : (
          <Text size="xs" c="dimmed">
            Read at {formatTimestamp(state.data.at)}. Stripped:{' '}
            {state.data.stripped.join(', ') || 'none'}
          </Text>
        )}
      </Group>
      <LoadState state={state}>
        {(reply) => (
          <div style={{ fontFamily: 'monospace', fontSize: 12 }}>
            {childEntries(reply.document).map(([key, child]) => (
              <TreeNode
                key={key}
                name={key}
                path={key}
                value={child}
                depth={0}
                open={open}
                visible={visible}
                query={query}
                onToggle={toggle}
              />
            ))}
          </div>
        )}
      </LoadState>
    </Stack>
  );
}

interface TreeNodeProps {
  readonly name: string;
  readonly path: string;
  readonly value: unknown;
  readonly depth: number;
  readonly open: ReadonlySet<string>;
  readonly visible: ReadonlySet<string> | undefined;
  readonly query: string;
  readonly onToggle: (path: string) => void;
}

/** One node and, when open, its children. A search shows matching branches open. */
function TreeNode({ name, path, value, depth, open, visible, query, onToggle }: TreeNodeProps) {
  if (visible !== undefined && !visible.has(path)) {
    return null;
  }
  const children = childEntries(value);
  const expandable = children.length > 0;
  const expanded = query.trim() !== '' || open.has(path);
  return (
    <>
      <Group gap={4} wrap="nowrap" style={{ paddingLeft: depth * INDENT_PX, minHeight: 22 }}>
        {expandable ? (
          <ActionIcon
            variant="subtle"
            size="xs"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name}`}
            aria-expanded={expanded}
            onClick={() => onToggle(path)}
          >
            {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </ActionIcon>
        ) : (
          <span style={{ width: 20, display: 'inline-block' }} />
        )}
        <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap' }}>
          {name}
        </Text>
        {expandable ? (
          <Badge size="xs" variant="light" color="gray">
            {children.length}
          </Badge>
        ) : (
          <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
            {previewOf(value)}
          </Text>
        )}
        {expandable ? (
          <CopyIcon text={JSON.stringify(value, null, 2) ?? ''} label={`Copy ${path}`} />
        ) : null}
      </Group>
      {expandable && expanded
        ? children.map(([key, child]) => (
            <TreeNode
              key={key}
              name={key}
              path={`${path}.${key}`}
              value={child}
              depth={depth + 1}
              open={open}
              visible={visible}
              query={query}
              onToggle={onToggle}
            />
          ))
        : null}
    </>
  );
}

function previewOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
