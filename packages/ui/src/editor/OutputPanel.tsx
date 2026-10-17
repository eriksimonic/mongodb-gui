import { Box, Button, Group, Tabs, Text } from '@mantine/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useUiApi } from '../api/ui-api';
import { useFontScale } from '../theme/font-scale';
import { useAppStore, useAppStoreApi } from '../state/app-store-context';
import type { PrintLine } from '../state/editors';
import { clockTime, countOf } from './labels';
import { FavouritesPanel } from './FavouritesPanel';
import { HistoryPanel } from './HistoryPanel';
import { TransfersPanel } from '../transfers';

const LINE_HEIGHT_PX = 20;

/**
 * The bottom panel. Output lists the print lines of every editor and the errors of their runs, with
 * the time and the database of each. History, Favourites and Transfers are the other tabs.
 */
export function OutputPanel() {
  const { rpc } = useUiApi();
  const [counts, setCounts] = useState<{ history?: number; favourites?: number }>({});
  useEffect(() => {
    let active = true;
    void rpc.history.list({ limit: 1000 }).then(
      (rows) => active && setCounts((current) => ({ ...current, history: rows.length })),
      () => undefined,
    );
    void rpc.favourites.list().then(
      (rows) => active && setCounts((current) => ({ ...current, favourites: rows.length })),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [rpc]);
  return (
    <Tabs className="mg-tab-separators"
      defaultValue="output"
      keepMounted={false}
      styles={{
        root: { height: '100%', display: 'flex', flexDirection: 'column' },
        tab: { padding: '6px 14px' },
        panel: { flex: 1, minHeight: 0, padding: '8px 14px 10px' },
      }}
    >
      <Tabs.List px={6}>
        <Tabs.Tab value="output">Output</Tabs.Tab>
        <Tabs.Tab value="history" rightSection={count(counts.history)}>
          History
        </Tabs.Tab>
        <Tabs.Tab value="favourites" rightSection={count(counts.favourites)}>
          Favourites
        </Tabs.Tab>
        <Tabs.Tab value="transfers">Transfers</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="output" style={{ display: 'flex', flexDirection: 'column' }}>
        <OutputLines />
      </Tabs.Panel>
      <Tabs.Panel value="history" style={{ display: 'flex', flexDirection: 'column' }}>
        <HistoryPanel />
      </Tabs.Panel>
      <Tabs.Panel value="favourites" style={{ display: 'flex', flexDirection: 'column' }}>
        <FavouritesPanel />
      </Tabs.Panel>
      <Tabs.Panel value="transfers">
        <TransfersPanel />
      </Tabs.Panel>
    </Tabs>
  );
}

function count(value: number | undefined) {
  return value === undefined || value === 0 ? null : (
    <Text span size="xs" c="dimmed" ff="monospace">
      {value}
    </Text>
  );
}

/** Print lines and run errors, newest last. The list is virtualised, and it follows new lines. */
export function OutputLines() {
  const store = useAppStoreApi();
  const output = useAppStore((state) => state.editors.output);
  const tabs = useAppStore((state) => state.editors.tabs);
  const scroller = useRef<HTMLDivElement>(null);
  const names = useMemo(
    () => new Map(Object.values(tabs).map((tab) => [tab.id, tab.database] as const)),
    [tabs],
  );
  const lineHeight = Math.round(LINE_HEIGHT_PX * useFontScale());
  const virtualizer = useVirtualizer({
    count: output.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => lineHeight,
    overscan: 20,
  });

  return (
    <>
      <Group justify="space-between" mb={6} wrap="nowrap" style={{ flex: '0 0 auto' }}>
        <Text size="xs" c="dimmed">
          {output.length === 0 ? 'No output yet' : countOf(output.length, 'line')}
        </Text>
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => store.getState().clearOutput()}
          disabled={output.length === 0}
        >
          Clear
        </Button>
      </Group>
      <div
        ref={scroller}
        role="log"
        className="mg-virtual-scroll"
        aria-label="Output"
        aria-live="polite"
        style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const line = output[item.index];
            if (line === undefined) {
              return null;
            }
            return (
              <Box
                key={line.id}
                ref={virtualizer.measureElement}
                data-index={item.index}
                data-line-kind={line.kind}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  minHeight: lineHeight,
                  transform: `translateY(${item.start}px)`,
                  display: 'flex',
                  gap: 8,
                  fontFamily: 'var(--mantine-font-family-monospace)',
                  fontSize: 'calc(var(--mg-font-scale, 1) * 12px)',
                  whiteSpace: 'pre',
                  overflow: 'hidden',
                }}
              >
                <span style={{ color: 'var(--mantine-color-dimmed)', flex: '0 0 auto' }}>
                  {clockTime(line.at)}
                </span>
                <span
                  style={{
                    color: 'var(--mantine-color-dimmed)',
                    flex: '0 0 auto',
                    maxWidth: 120,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {tabLabel(line, names)}
                </span>
                <span
                  style={{
                    color: line.kind === 'error' ? 'var(--mantine-color-red-4)' : undefined,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {line.text}
                </span>
              </Box>
            );
          })}
        </div>
      </div>
    </>
  );
}

function tabLabel(line: PrintLine, names: ReadonlyMap<string, string>): string {
  if (line.tabId === undefined) {
    return '';
  }
  return names.get(line.tabId) ?? '';
}
