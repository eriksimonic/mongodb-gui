import { ActionIcon, Badge, Group, Paper, SimpleGrid, Text, TextInput } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { CopyIcon, LoadState, ScrollLayout, Toolbar } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import { formatBytes, formatCount, formatDuration, formatTimestamp, unitHint } from './format';
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
    <ScrollLayout
      toolbar={
        <Toolbar
          loading={state.loading}
          onRefresh={() => void load()}
          status={
            state.data === undefined
              ? undefined
              : `Read at ${formatTimestamp(state.data.at)}. Stripped: ${state.data.stripped.join(', ') || 'none'}`
          }
        >
          <TextInput
            aria-label="Search paths"
            placeholder="Search paths, for example wiredTiger.cache"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            w={320}
            size="xs"
          />
        </Toolbar>
      }
    >
      <LoadState state={state}>
        {() =>
          relaxed === undefined || canonical === undefined ? null : (
            <>
              <SummaryCards document={relaxed} />
              <div
                style={{
                  fontFamily: 'monospace',
                  fontSize: 'calc(var(--mg-font-scale, 1) * 12px)',
                }}
              >
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
            </>
          )
        }
      </LoadState>
    </ScrollLayout>
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
            {hintOf(label, value)}
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

function hintOf(label: string, value: unknown) {
  const hint = typeof value === 'number' ? unitHint(label, value) : undefined;
  return hint === undefined ? null : (
    <Text span inherit c="blue">
      {' '}
      ({hint})
    </Text>
  );
}

function numberAt(document: unknown, ...path: string[]): number | undefined {
  let current: unknown = document;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'number' ? current : undefined;
}

/** The numbers most people look for first, above the full tree. */
function SummaryCards({ document }: { readonly document: unknown }) {
  const uptime = numberAt(document, 'uptime');
  const current = numberAt(document, 'connections', 'current');
  const available = numberAt(document, 'connections', 'available');
  const resident = numberAt(document, 'mem', 'resident');
  const operations = ['insert', 'query', 'update', 'delete', 'getmore', 'command']
    .map((name) => numberAt(document, 'opcounters', name))
    .reduce<number | undefined>(
      (sum, value) => (value === undefined ? sum : (sum ?? 0) + value),
      undefined,
    );
  const version = (document as { version?: unknown }).version;
  const cards: { label: string; value: string | undefined }[] = [
    { label: 'Version', value: typeof version === 'string' ? version : undefined },
    { label: 'Uptime', value: uptime === undefined ? undefined : formatDuration(uptime) },
    {
      label: 'Connections',
      value:
        current === undefined
          ? undefined
          : `${formatCount(current)}${available === undefined ? '' : ` of ${formatCount(current + available)}`}`,
    },
    {
      label: 'Resident memory',
      value: resident === undefined ? undefined : formatBytes(resident * 1024 * 1024),
    },
    {
      label: 'Operations since start',
      value: operations === undefined ? undefined : formatCount(operations),
    },
  ];
  return (
    <SimpleGrid cols={{ base: 2, sm: 5 }} spacing="xs" mb="xs">
      {cards
        .filter((card) => card.value !== undefined)
        .map((card) => (
          <Paper key={card.label} withBorder p="xs">
            <Text size="xs" c="dimmed">
              {card.label}
            </Text>
            <Text fw={600}>{card.value}</Text>
          </Paper>
        ))}
    </SimpleGrid>
  );
}
