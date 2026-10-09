import { Box, Button, Group, Tabs, Text } from '@mantine/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef } from 'react';
import { useAppStore, useAppStoreApi } from '../../state/app-store-context';
import type { PrintLine } from '../../state/editors';
import { clockTime } from './labels';
import { FavouritesPanel } from './FavouritesPanel';
import { HistoryPanel } from './HistoryPanel';

const LINE_HEIGHT_PX = 20;

/**
 * The bottom panel. Output lists the print lines of every editor and the errors of their runs, with
 * the time and the database of each. History and Favourites are the other tabs.
 */
export function OutputPanel() {
  return (
    <Tabs
      defaultValue="output"
      keepMounted={false}
      styles={{
        root: { height: '100%', display: 'flex', flexDirection: 'column' },
        panel: { flex: 1, minHeight: 0, padding: 8 },
      }}
    >
      <Tabs.List>
        <Tabs.Tab value="output">Output</Tabs.Tab>
        <Tabs.Tab value="history">History</Tabs.Tab>
        <Tabs.Tab value="favourites">Favourites</Tabs.Tab>
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
    </Tabs>
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
  const virtualizer = useVirtualizer({
    count: output.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => LINE_HEIGHT_PX,
    overscan: 20,
  });

  return (
    <>
      <Group justify="space-between" mb={4}>
        <Text size="xs" c="dimmed">
          {output.length === 0 ? 'No output yet' : `${output.length} lines`}
        </Text>
        <Button
          size="xs"
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
                  minHeight: LINE_HEIGHT_PX,
                  transform: `translateY(${item.start}px)`,
                  display: 'flex',
                  gap: 8,
                  fontFamily: 'var(--mantine-font-family-monospace)',
                  fontSize: 12,
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
