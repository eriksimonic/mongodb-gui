import { ActionIcon, Badge, Group, SimpleGrid, Text, TextInput } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { StatCard } from '../kit/StatCard';
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
const KEY_COLUMN_PX = 220;
/** The sections open at first, since they hold the numbers people read most. */
const OPEN_AT_FIRST = ['connections', 'opcounters'];

/**
 * The serverStatus document as an explorable tree, with a path search and copy of any subtree. The
 * tree shows numbers and dates in plain form. A copy takes the canonical EJSON of the subtree.
 */
export function ServerStatusTab({ store }: ServerStatusTabProps) {
  const state = useStore(store, (current) => current.serverStatus);
  const load = useStore(store, (current) => current.loadServerStatus);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(OPEN_AT_FIRST.map((name) => pathKey([name]))),
  );
  const hostLoad = useStore(store, (current) => current.loadHostAndBuild);
  const hostMemMb = useStore(store, (current) => current.hostAndBuild.data?.host.memSizeMb);

  useEffect(() => {
    void load();
    void hostLoad();
  }, [load, hostLoad]);

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
              : `Read at ${formatTimestamp(state.data.at)}${
                  state.data.stripped.length === 0
                    ? ''
                    : ` · stripped ${state.data.stripped.join(', ')}`
                }`
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
              <SummaryCards document={relaxed} readAt={state.data?.at} hostMemMb={hostMemMb} />
              <div
                style={{
                  fontFamily: 'var(--mantine-font-family-monospace)',
                  fontSize: 'calc(var(--mg-font-scale, 1) * 12px)',
                  margin: '0 calc(var(--mantine-spacing-md) * -1)',
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
  const header = depth === 0 && expandable;
  return (
    <>
      <Group
        gap={4}
        wrap="nowrap"
        px="md"
        style={{
          paddingLeft: `calc(var(--mantine-spacing-md) + ${depth * INDENT_PX}px)`,
          minHeight: header ? 30 : 26,
          background: header ? 'var(--mg-surface-2)' : undefined,
          borderBottom: header ? '1px solid var(--mg-border)' : undefined,
        }}
      >
        {expandable ? (
          <ActionIcon
            variant="transparent"
            color="gray"
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
        {expandable ? (
          <>
            <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap' }}>
              {label}
            </Text>
            <Badge size="xs" variant="light" color="gray">
              {children.length}
            </Badge>
            <span style={{ marginLeft: 'auto' }}>
              <CopyIcon
                text={() => JSON.stringify(valueAtPath(canonical, segments), null, 2) ?? ''}
                label={`Copy ${segments.join('.')}`}
              />
            </span>
          </>
        ) : (
          <>
            <Text
              size="xs"
              c="dimmed"
              style={{ width: KEY_COLUMN_PX - depth * INDENT_PX, flexShrink: 0 }}
            >
              {label}
            </Text>
            <Text size="xs" c={valueColour(value)} style={{ wordBreak: 'break-all' }}>
              {previewOf(value)}
              {hintOf(label, value)}
            </Text>
          </>
        )}
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

/** Numbers, strings and booleans get the code colours, so a value stands out from its key. */
function valueColour(value: unknown): string {
  if (typeof value === 'number') {
    return 'var(--mg-code-number)';
  }
  if (typeof value === 'string') {
    return 'var(--mg-code-string)';
  }
  if (typeof value === 'boolean') {
    return 'var(--mg-code-keyword)';
  }
  return 'var(--mg-text-muted)';
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

interface SummaryCardsProps {
  readonly document: unknown;
  readonly readAt: string | undefined;
  readonly hostMemMb: number | undefined;
}

function stringAt(document: unknown, key: string): string | undefined {
  const value = (document as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** The numbers most people look for first, above the full tree. */
function SummaryCards({ document, readAt, hostMemMb }: SummaryCardsProps) {
  const uptime = numberAt(document, 'uptime');
  const current = numberAt(document, 'connections', 'current');
  const available = numberAt(document, 'connections', 'available');
  const resident = numberAt(document, 'mem', 'resident');
  const counters = ['insert', 'query', 'update', 'delete', 'getmore', 'command']
    .map((name) => numberAt(document, 'opcounters', name))
    .filter((value): value is number => value !== undefined);
  const operations = counters.reduce((sum, value) => sum + value, 0);
  const version = stringAt(document, 'version');
  const pid = numberAt(document, 'pid');
  const processName = stringAt(document, 'process');
  const startedAt =
    uptime === undefined || readAt === undefined
      ? undefined
      : new Date(Date.parse(readAt) - uptime * 1000);
  return (
    <SimpleGrid cols={{ base: 2, sm: 5 }} spacing="sm" mb="xs">
      {version === undefined ? null : (
        <StatCard label="Version" value={version}>
          {processName === undefined
            ? null
            : `${processName}${pid === undefined ? '' : ` · pid ${pid}`}`}
        </StatCard>
      )}
      {uptime === undefined ? null : (
        <StatCard label="Uptime" value={formatDuration(uptime)}>
          {startedAt === undefined || Number.isNaN(startedAt.getTime())
            ? null
            : `since ${startedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
        </StatCard>
      )}
      {current === undefined ? null : (
        <StatCard label="Connections" value={formatCount(current)}>
          {available === undefined ? null : `of ${formatCount(current + available)} available`}
        </StatCard>
      )}
      {resident === undefined ? null : (
        <StatCard label="Resident memory" value={formatBytes(resident * 1024 * 1024)}>
          {hostMemMb === undefined ? null : `of ${formatBytes(hostMemMb * 1024 * 1024)} host`}
        </StatCard>
      )}
      {counters.length === 0 ? null : (
        <StatCard label="Operations since start" value={formatCount(operations)}>
          {`${counters.length} counters`}
        </StatCard>
      )}
    </SimpleGrid>
  );
}
