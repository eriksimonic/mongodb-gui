import { ActionIcon, Group, Menu, Paper, Stack, Text } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { SeriesUnit } from '@mongo-gui/core';
import { CHART_HEIGHT_PX, type ChartMode, type ChartSeries, type ChartWindow } from './chart-types';
import { formatValue } from './format';
import { UPlotChart } from './UPlotChart';
import { trackPointer } from './track-offset';

export interface PanelCardProps {
  readonly id: string;
  readonly title: string;
  readonly caption: string;
  readonly dragging: boolean;
  /** Set while another panel hovers over this one, to show where the drop would land. */
  readonly dropPlace: 'left' | 'right' | 'above' | 'below' | undefined;
  readonly menu: ReactNode;
  /** The header is the move handle. Called with the pointer position on every move and at the end. */
  readonly onMove: (x: number, y: number, final: boolean) => void;
  readonly children: ReactNode;
}

/**
 * The frame every panel shares: title, unit caption and a menu, with the body below. The header
 * moves the panel. The card fills its slot in a row.
 */
export function PanelCard({
  id,
  title,
  caption,
  dragging,
  dropPlace,
  menu,
  onMove,
  children,
}: PanelCardProps) {
  return (
    <Paper
      withBorder
      p="sm"
      radius="md"
      bg="var(--mg-surface-1)"
      data-testid="chart-card"
      data-panel-id={id}
      data-dragging={dragging ? 'true' : undefined}
      data-drop={dropPlace}
      className="mg-panel"
    >
      <Stack gap={6} h="100%" style={{ minHeight: 0 }}>
        <Group
          justify="space-between"
          wrap="nowrap"
          gap="xs"
          className="mg-panel-header"
          data-testid="panel-header"
          title="Drag to move this panel"
          onPointerDown={(event) =>
            trackPointer(
              event,
              (next) => onMove(next.clientX, next.clientY, false),
              (next) => onMove(next.clientX, next.clientY, true),
            )
          }
        >
          <Text size="sm" fw={600} truncate="end">
            {title}
          </Text>
          <Group gap={4} wrap="nowrap">
            <Text size="xs" c="dimmed" ta="right" style={{ whiteSpace: 'nowrap' }}>
              {caption}
            </Text>
            {menu}
          </Group>
        </Group>
        {children}
      </Stack>
    </Paper>
  );
}

/** The menu on each panel header: close and the description. */
export interface PanelMenuProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly onAbout: () => void;
}

export function PanelMenu({ title, onClose, onAbout }: PanelMenuProps) {
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" size="sm" aria-label={`Options for ${title}`}>
          <IconDotsVertical size={14} aria-hidden="true" />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={onAbout}>About this panel</Menu.Item>
        <Menu.Divider />
        <Menu.Item color="red" onClick={onClose}>
          Close panel
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/** A stat panel's body: one large value with its unit. */
export function StatBody({
  value,
  unit,
}: {
  readonly value: number | undefined;
  readonly unit: SeriesUnit;
}) {
  return (
    <Text fz={26} fw={600} lh={1.3} data-testid="stat-value">
      {value === undefined ? 'No sample' : formatValue(value, unit)}
    </Text>
  );
}

function latestValue(values: readonly (number | null)[]): number | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

function Chip({ item, keyed }: { readonly item: ChartSeries; readonly keyed: boolean }) {
  const value = latestValue(item.values);
  return (
    <span className="mg-chip">
      {keyed ? (
        <span
          className="mg-chip-key"
          aria-hidden="true"
          style={{ background: item.color, borderColor: item.color }}
        />
      ) : null}
      <span>{item.label}</span>
      <span className="mg-chip-value">
        {value === undefined ? 'No sample' : formatValue(value, item.unit)}
      </span>
    </span>
  );
}

export interface ChartBodyProps {
  readonly label: string;
  readonly times: readonly number[];
  readonly series: readonly ChartSeries[];
  readonly yUnit: SeriesUnit;
  readonly mode: ChartMode;
  readonly syncKey: string;
  readonly window: ChartWindow | undefined;
  readonly emptyText: string;
}

/**
 * The legend chips and the plot. Chips show each line's latest value, so the colour is never the
 * only identity cue. The chip row keeps its height when a panel has no data.
 */
export function ChartBody({
  label,
  times,
  series,
  yUnit,
  mode,
  syncKey,
  window,
  emptyText,
}: ChartBodyProps) {
  const hasData = times.length > 1 && series.length > 0;
  return (
    <>
      <Group className="mg-chip-row" gap="sm" wrap="wrap">
        {hasData
          ? series.map((item) => <Chip key={item.key} item={item} keyed={series.length > 1} />)
          : null}
      </Group>
      {hasData ? (
        <UPlotChart
          label={label}
          times={times}
          series={series}
          yUnit={yUnit}
          mode={mode}
          syncKey={syncKey}
          window={window}
        />
      ) : (
        <Text
          size="sm"
          c="dimmed"
          style={{ flex: 1, minHeight: CHART_HEIGHT_PX / 2, display: 'flex', alignItems: 'center' }}
        >
          {emptyText}
        </Text>
      )}
    </>
  );
}
