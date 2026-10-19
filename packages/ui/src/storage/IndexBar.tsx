import { Box, Stack, Text, Tooltip } from '@mantine/core';
import { useState } from 'react';
import { formatBytes } from '../diagnostics/format';
import { fillFor, TONE_COLOR, type SegmentTone } from './tones';
export interface IndexBarItem {
  /** Shown in the test id `storage-tile-<id>`. */
  readonly id: string;
  readonly label: string;
  readonly bytes: number;
  readonly tone: SegmentTone;
  /** Extra tooltip lines after the size. */
  readonly extra?: readonly string[] | undefined;
}

export interface IndexBarProps {
  readonly items: readonly IndexBarItem[];
  /** Data plus index bytes. The share base. Free space is not part of it. */
  readonly whole: number;
}

const MIN_SEGMENT_SHARE = 0.02;
const MORE_ID = 'more';
const CHAR_PX = 7;
const INNER_INSET_PX = 14;

function percent(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '0%';
}

interface Segment {
  readonly item: IndexBarItem;
  readonly lines: readonly string[];
  readonly position: number;
}

/** One full-width bar. Segment width follows the bytes. Narrow indexes merge into one segment. */
export function IndexBar({ items, whole }: IndexBarProps) {
  const total = items.reduce((sum, item) => sum + item.bytes, 0);
  const small = (item: IndexBarItem) =>
    item.tone === 'index' && total > 0 && item.bytes / total < MIN_SEGMENT_SHARE;
  const tiny = items.filter(small);
  const merge = tiny.length >= 2;
  const kept = merge ? items.filter((item) => !small(item)) : items;

  const lineFor = (item: IndexBarItem): string[] => [
    item.label,
    `Size: ${formatBytes(item.bytes)}`,
    ...(item.tone === 'free' ? [] : [`Share of data and index: ${percent(item.bytes, whole)}`]),
    ...(item.extra ?? []),
  ];

  const segments: Segment[] = kept.map((item, position) => ({
    item,
    lines: lineFor(item),
    position,
  }));
  if (merge) {
    const bytes = tiny.reduce((sum, item) => sum + item.bytes, 0);
    segments.push({
      item: { id: MORE_ID, label: `${tiny.length} more indexes`, bytes, tone: 'index' },
      lines: [
        `${tiny.length} more indexes`,
        ...tiny.map(
          (item) => `${item.label}: ${formatBytes(item.bytes)} (${percent(item.bytes, whole)})`,
        ),
      ],
      position: kept.length,
    });
  }

  return (
    <Stack gap="xs">
      <Box
        data-testid="storage-index-bar"
        style={{
          display: 'flex',
          height: 56,
          gap: 1,
          borderRadius: 'var(--mantine-radius-md)',
          overflow: 'hidden',
          border: '1px solid var(--mg-border)',
        }}
      >
        {segments.map((segment) => (
          <SegmentView key={segment.item.id} segment={segment} total={total} />
        ))}
      </Box>
    </Stack>
  );
}

function SegmentView({ segment, total }: { segment: Segment; total: number }) {
  const { item } = segment;
  const [hover, setHover] = useState(false);
  const fraction = total > 0 ? item.bytes / total : 0;
  const sizeText = formatBytes(item.bytes);
  // Unmeasured in tests, so the 1200px guess keeps the label logic stable there.
  const inner = fraction * 1200 - INNER_INSET_PX;
  const labelShown = item.label.length * CHAR_PX <= inner;
  const sizeShown = labelShown && sizeText.length * CHAR_PX <= inner;

  return (
    <Tooltip
      label={
        <Stack gap={0}>
          {segment.lines.map((line) => (
            <Text key={line} size="xs">
              {line}
            </Text>
          ))}
        </Stack>
      }
      multiline
      w={260}
      withArrow
      openDelay={250}
    >
      <Box
        data-testid={`storage-tile-${item.id}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          flex: `${item.bytes} 1 0`,
          minWidth: 2,
          boxSizing: 'border-box',
          padding: '0 8px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          overflow: 'hidden',
          background: fillFor(item, segment.position, hover),
          boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${TONE_COLOR[item.tone]} ${hover ? 80 : 45}%, var(--mg-border))`,
          color: 'var(--mg-text-strong)',
          transition: 'background 120ms, box-shadow 120ms',
        }}
      >
        {labelShown ? (
          <Text size="xs" fw={500} style={{ whiteSpace: 'nowrap' }}>
            {item.label}
          </Text>
        ) : null}
        {sizeShown ? (
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {sizeText}
          </Text>
        ) : null}
      </Box>
    </Tooltip>
  );
}
