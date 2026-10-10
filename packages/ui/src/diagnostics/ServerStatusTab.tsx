import { ActionIcon, Badge, Group, Stack, Text, TextInput } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { CopyIcon, LoadState, RefreshButton } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import { formatTimestamp } from './format';
import { relaxEjson } from './relax-ejson';
import {
  childEntries,
  matchingPaths,
  pathKey,
  valueAtPath,
  type PathSegments,
} from './tree-search';

export interface ServerStatusTabProps {
  readonly store: DiagnosticsStore;
}

const INDENT_PX = 16;

/**
 * The serverStatus document as an explorable tree, with a path search and copy of any subtree. The
 * tree shows numbers and dates in plain form. A copy takes the canonical EJSON of the subtree.
 */
export function ServerStatusTab({ store }: ServerStatusTabProps) {
  const state = useStore(store, (current) => current.serverStatus);
  const load = useStore(store, (current) => current.loadServerStatus);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    void load();
  }, [load]);

  const canonical = state.data?.document;
  const relaxed = useMemo(
    () => (canonical === undefined ? undefined : relaxEjson(canonical)),
    [canonical],
  );
  const visible = useMemo(() => matchingPaths(relaxed, query), [relaxed, query]);

  function toggle(key: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
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
        {() =>
          relaxed === undefined || canonical === undefined ? null : (
            <div style={{ fontFamily: 'monospace', fontSize: 12 }}>
              {childEntries(relaxed).map(([key, child]) => (
                <TreeNode
                  key={key}
                  label={key}
                  segments={[key]}
                  value={child}
                  canonical={canonical}
                  depth={0}
                  open={open}
                  visible={visible}
                  query={query}
                  onToggle={toggle}
                />
              ))}
            </div>
          )
        }
      </LoadState>
    </Stack>
  );
}

interface TreeNodeProps {
  readonly label: string;
  readonly segments: PathSegments;
  /** The relaxed value shown in the tree. */
  readonly value: unknown;
  /** The canonical document, read again for a copy. */
  readonly canonical: Record<string, unknown>;
  readonly depth: number;
  readonly open: ReadonlySet<string>;
  readonly visible: ReadonlySet<string> | undefined;
  readonly query: string;
  readonly onToggle: (key: string) => void;
}

/** One node and, when open, its children. A search shows the matching branches open. */
function TreeNode({
  label,
  segments,
  value,
  canonical,
  depth,
  open,
  visible,
  query,
  onToggle,
}: TreeNodeProps) {
  const key = pathKey(segments);
  if (visible !== undefined && !visible.has(key)) {
    return null;
  }
  const children = childEntries(value);
  const expandable = children.length > 0;
  const expanded = query.trim() !== '' || open.has(key);
  return (
    <>
      <Group gap={4} wrap="nowrap" style={{ paddingLeft: depth * INDENT_PX, minHeight: 22 }}>
        {expandable ? (
          <ActionIcon
            variant="subtle"
            size="xs"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
            aria-expanded={expanded}
            onClick={() => onToggle(key)}
          >
            {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </ActionIcon>
        ) : (
          <span style={{ width: 20, display: 'inline-block' }} />
        )}
        <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap' }}>
          {label}
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
          <CopyIcon
            text={() => JSON.stringify(valueAtPath(canonical, segments), null, 2) ?? ''}
            label={`Copy ${segments.join('.')}`}
          />
        ) : null}
      </Group>
      {expandable && expanded
        ? children.map(([childKey, child]) => (
            <TreeNode
              key={childKey}
              label={Array.isArray(value) ? `[${childKey}]` : childKey}
              segments={[...segments, childKey]}
              value={child}
              canonical={canonical}
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
