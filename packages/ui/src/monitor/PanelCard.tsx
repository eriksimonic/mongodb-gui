import { ActionIcon, Group, Menu, Paper, Stack, Text } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import type { CSSProperties, ReactNode } from 'react';
import type { SeriesUnit } from '@mongo-gui/core';
import {
  CHART_HEIGHT_PX,
  TALL_CHART_HEIGHT_PX,
  type ChartMode,
  type ChartSeries,
  type ChartWindow,
} from './chart-types';
import { formatValue } from './format';
import { UPlotChart } from './UPlotChart';

export interface PanelCardProps {
  readonly id: string;
  readonly title: string;
  readonly caption: string;
  readonly width: 1 | 2 | 3;
  readonly tall: boolean;
  readonly dragging: boolean;
  readonly menu: ReactNode;
  readonly onDragStart: () => void;
  readonly onDragEnd: () => void;
  readonly onDropHere: () => void;
  readonly children: ReactNode;
}

/**
 * The frame every panel shares: title, unit caption and a menu, with the body below. The header is
 * the drag handle. Dropping a panel on another card moves it to that card's place.
 */
export function PanelCard({
  id,
  title,
  caption,
  width,
  tall,
  dragging,
  menu,
  onDragStart,
  onDragEnd,
  onDropHere,
  children,
}: PanelCardProps) {
  return (
    <Paper
      withBorder
      p="sm"
      radius="sm"
      data-testid="chart-card"
      data-panel-id={id}
      data-dragging={dragging ? 'true' : undefined}
      className="mg-panel"
      style={{ '--panel-w': width, '--panel-h': tall ? 2 : 1 } as CSSProperties}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDropHere();
      }}
    >
      <Stack gap={6} h="100%">
        <Group
          justify="space-between"
          wrap="nowrap"
          gap="xs"
          draggable
          onDragStart={(event) => {
            // Some hosts give no DataTransfer. The move still works from the component state.
            const transfer: DataTransfer | undefined = event.dataTransfer;
            if (transfer !== undefined) {
              transfer.effectAllowed = 'move';
              transfer.setData('text/plain', id);
            }
            onDragStart();
          }}
          onDragEnd={onDragEnd}
          className="mg-panel-header"
          data-testid="panel-header"
          title="Drag to move this panel"
        >
          <Text size="sm" fw={600} truncate="end">
            {title}
          </Text>
          <Group gap={4} wrap="nowrap">
            <Text size="xs" c="dimmed" ta="right">
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

/** The menu on each panel header: close, width, height and the description. */
export interface PanelMenuProps {
  readonly title: string;
  readonly width: 1 | 2 | 3;
  readonly tall: boolean;
  readonly onClose: () => void;
  readonly onWidth: (width: 1 | 2 | 3) => void;
  readonly onHeight: (tall: boolean) => void;
  readonly onAbout: () => void;
}

const WIDTH_OPTIONS = [
  { value: 1 as const, label: '1 column' },
  { value: 2 as const, label: '2 columns' },
  { value: 3 as const, label: '3 columns' },
];

export function PanelMenu({
  title,
  width,
  tall,
  onClose,
  onWidth,
  onHeight,
  onAbout,
}: PanelMenuProps) {
  return (
    <Menu position="bottom-end" withinPortal shadow="md" width={200}>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label={`Options for ${title}`}
          data-testid="panel-menu"
        >
          <IconDotsVertical size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item onClick={onAbout}>About this panel</Menu.Item>
        <Menu.Divider />
        <Menu.Label>Width</Menu.Label>
        {WIDTH_OPTIONS.map((option) => (
          <Menu.Item
            key={option.value}
            onClick={() => onWidth(option.value)}
            fw={option.value === width ? 600 : undefined}
            aria-current={option.value === width ? 'true' : undefined}
          >
            {option.label}
            {option.value === width ? ' (current)' : ''}
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Label>Height</Menu.Label>
        <Menu.Item onClick={() => onHeight(false)} aria-current={tall ? undefined : 'true'}>
          Standard{tall ? '' : ' (current)'}
        </Menu.Item>
        <Menu.Item onClick={() => onHeight(true)} aria-current={tall ? 'true' : undefined}>
          Tall{tall ? ' (current)' : ''}
        </Menu.Item>
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
  readonly tall: boolean;
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
  tall,
  emptyText,
}: ChartBodyProps) {
  const hasData = times.length > 1 && series.length > 0;
  const height = tall ? TALL_CHART_HEIGHT_PX : CHART_HEIGHT_PX;
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
          height={height}
        />
      ) : (
        <Text
          size="sm"
          c="dimmed"
          style={{ height: CHART_HEIGHT_PX, display: 'flex', alignItems: 'center' }}
        >
          {emptyText}
        </Text>
      )}
    </>
  );
}
