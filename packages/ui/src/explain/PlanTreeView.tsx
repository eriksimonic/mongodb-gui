import {
  Badge,
  Button,
  Group,
  SegmentedControl,
  Text,
  Tooltip,
  useComputedColorScheme,
} from '@mantine/core';
import {
  IconArrowsSort,
  IconBolt,
  IconChevronDown,
  IconChevronRight,
  IconCircleDashed,
  IconDatabaseSearch,
  IconEye,
  IconFileDownload,
  IconFilter,
  IconGitMerge,
  IconLetterCase,
  IconLink,
  IconMapPin,
  IconPencil,
  IconScan,
  IconScissors,
  IconServer,
  IconStack2,
  type Icon,
} from '@tabler/icons-react';
import { describeStage, type PlanStage, type StageCategory, type StageInfo } from '@mongo-gui/core';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { seriesColor } from '../monitor/palette';
import {
  ancestorIds,
  barMetricFor,
  barPercent,
  hotStageId,
  maxMetric,
  metricOf,
  planRows,
  revealKeys,
  type BarMetric,
  type PlanRow,
} from './explain-model';
import { examinedRatio, shardErrorMessage, stageMetricItems } from './stage-view';

type StageRow = Extract<PlanRow, { readonly kind: 'stage' }>;
type GroupRow = Extract<PlanRow, { readonly kind: 'group' }>;

/** A stage the user picked. A new object each time, so picking the same stage again reveals it. */
export interface StageSelection {
  readonly id: string;
}

export interface PlanTreeViewProps {
  readonly root: PlanStage;
  readonly rejected: readonly PlanStage[];
  readonly selection: StageSelection | undefined;
  readonly onSelect: (selection: StageSelection) => void;
}

const METRIC_DATA = [
  { value: 'docs', label: 'Documents' },
  { value: 'time', label: 'Time' },
];

const INDENT_BASE_PX = 8;
const INDENT_STEP_PX = 16;

const CATEGORY_ICON: Readonly<Record<StageCategory, Icon>> = {
  scan: IconScan,
  fetch: IconFileDownload,
  filter: IconFilter,
  sort: IconArrowsSort,
  projection: IconEye,
  limit: IconScissors,
  lookup: IconLink,
  group: IconStack2,
  merge: IconGitMerge,
  sharding: IconServer,
  text: IconLetterCase,
  geo: IconMapPin,
  write: IconPencil,
  cache: IconDatabaseSearch,
  express: IconBolt,
  unknown: IconCircleDashed,
};

// Each category takes one of the eight chart series slots, so the colours match the charts. Some
// categories share a slot. The icon and the tooltip tell them apart. Unknown stages take no slot
// and use the neutral text colour.
const CATEGORY_SLOT: Readonly<Partial<Record<StageCategory, number>>> = {
  scan: 0,
  fetch: 0,
  cache: 0,
  filter: 1,
  projection: 1,
  limit: 1,
  sort: 2,
  group: 2,
  express: 3,
  lookup: 6,
  merge: 6,
  sharding: 5,
  text: 4,
  geo: 4,
  write: 7,
};

const SHARD_ERROR = 'SHARD_ERROR';

function indent(depth: number): number {
  return INDENT_BASE_PX + depth * INDENT_STEP_PX;
}

/**
 * The plan as a vertical tree, root at the top. Arrow keys move between stages, Right and Left
 * expand and collapse, and Enter selects. Only one stage is in the tab order at a time.
 */
export function PlanTreeView({ root, rejected, selection, onSelect }: PlanTreeViewProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [metric, setMetric] = useState<BarMetric>(() => barMetricFor(root));
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const [compared, setCompared] = useState<number | undefined>(undefined);
  const nodes = useRef(new Map<string, HTMLLIElement>());
  const rows = useMemo(() => planRows(root, collapsed), [root, collapsed]);
  const stageRows = useMemo(
    () => rows.filter((row): row is StageRow => row.kind === 'stage'),
    [rows],
  );
  const hot = useMemo(() => hotStageId(root), [root]);
  const max = useMemo(
    () => Math.max(maxMetric(root, metric), ...rejected.map((plan) => maxMetric(plan, metric))),
    [root, rejected, metric],
  );
  const selectedId = selection?.id;

  // A new selection inside a collapsed branch opens the branch, so the selected row is on screen.
  // The state is adjusted during render, which React runs again before it paints.
  const [seenSelection, setSeenSelection] = useState(selection);
  if (seenSelection !== selection) {
    setSeenSelection(selection);
    if (selection !== undefined) {
      const revealed = revealKeys(collapsed, selection.id);
      if (revealed.size !== collapsed.size) {
        setCollapsed(revealed);
      }
    }
  }

  // Scrolls the selected row into view. A warning that selects a stage brings the stage on screen.
  useEffect(() => {
    if (selectedId !== undefined) {
      nodes.current.get(selectedId)?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [selection, selectedId]);

  const tabStop = stageRows.find((row) => row.id === focusId)?.id ?? stageRows[0]?.id;

  function moveTo(id: string): void {
    setFocusId(id);
    nodes.current.get(id)?.focus();
  }

  function toggle(id: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleKey(event: KeyboardEvent<HTMLLIElement>, row: StageRow): void {
    const index = stageRows.findIndex((candidate) => candidate.id === row.id);
    switch (event.key) {
      case 'ArrowDown': {
        const next = stageRows[index + 1];
        if (next !== undefined) {
          moveTo(next.id);
        }
        break;
      }
      case 'ArrowUp': {
        const previous = stageRows[index - 1];
        if (previous !== undefined) {
          moveTo(previous.id);
        }
        break;
      }
      case 'ArrowRight': {
        if (row.hasChildren && !row.expanded) {
          toggle(row.id);
        } else if (row.expanded) {
          const child = stageRows[index + 1];
          if (child !== undefined && child.id.startsWith(`${row.id}.`)) {
            moveTo(child.id);
          }
        }
        break;
      }
      case 'ArrowLeft': {
        if (row.expanded) {
          toggle(row.id);
        } else {
          const parent = ancestorIds(row.id).at(-1);
          if (parent !== undefined) {
            moveTo(parent);
          }
        }
        break;
      }
      case 'Enter':
      case ' ':
        onSelect({ id: row.id });
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div className="mg-explain-tree-block">
      <div className="mg-explain-tree-main">
        <Group justify="space-between" mb={4}>
          <Text fw={600} size="sm">
            Plan stages
          </Text>
          <SegmentedControl
            size="xs"
            aria-label="Bar shows"
            data={METRIC_DATA}
            value={metric}
            onChange={(value) => setMetric(value === 'time' ? 'time' : 'docs')}
          />
        </Group>
        <ul role="tree" aria-label="Plan stages" className="mg-explain-tree">
          {rows.map((row) =>
            row.kind === 'group' ? (
              <GroupHeading key={row.id} row={row} onToggle={() => toggle(row.id)} />
            ) : (
              <li
                key={row.id}
                ref={(element) => {
                  if (element === null) {
                    nodes.current.delete(row.id);
                  } else {
                    nodes.current.set(row.id, element);
                  }
                }}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.hasChildren ? row.expanded : undefined}
                aria-selected={row.id === selectedId}
                tabIndex={row.id === tabStop ? 0 : -1}
                className={[
                  'mg-explain-row',
                  row.id === hot ? 'mg-explain-hot' : '',
                  row.id === selectedId ? 'mg-explain-selected' : '',
                ]
                  .filter((name) => name !== '')
                  .join(' ')}
                style={{ paddingLeft: indent(row.depth) }}
                onKeyDown={(event) => handleKey(event, row)}
                onClick={() => {
                  setFocusId(row.id);
                  onSelect({ id: row.id });
                }}
              >
                <StageRowBody
                  row={row}
                  metric={metric}
                  max={max}
                  hot={row.id === hot}
                  onToggle={row.hasChildren ? () => toggle(row.id) : undefined}
                />
              </li>
            ),
          )}
        </ul>
        {rejected.length === 0 ? null : (
          <details className="mg-explain-rejected">
            <summary>Rejected plans ({rejected.length})</summary>
            <ul className="mg-explain-rejected-list">
              {rejected.map((plan, index) => {
                const open = compared === index;
                return (
                  <li key={`rejected-${index}`} className="mg-explain-rejected-item">
                    <Group justify="space-between" wrap="nowrap" gap="xs">
                      <Group gap={6} wrap="nowrap">
                        <span className="mg-explain-stage-name">{plan.name}</span>
                        {plan.index === undefined ? null : (
                          <Badge tt="none" variant="outline" color="gray" size="sm">
                            {plan.index}
                          </Badge>
                        )}
                      </Group>
                      <Button
                        size="xs"
                        variant={open ? 'light' : 'default'}
                        aria-pressed={open}
                        onClick={() => setCompared(open ? undefined : index)}
                      >
                        Compare
                      </Button>
                    </Group>
                    {open ? (
                      <div className="mg-explain-compare">
                        <CompareColumn
                          title="Winning plan"
                          plan={root}
                          prefix="winning"
                          metric={metric}
                          max={max}
                        />
                        <CompareColumn
                          title={`Rejected plan ${index + 1}`}
                          plan={plan}
                          prefix={`rejected-${index}`}
                          metric={metric}
                          max={max}
                        />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

interface GroupHeadingProps {
  readonly row: GroupRow;
  readonly onToggle: () => void;
}

/** The heading of a labelled sub-tree. It opens and closes the sub-tree under it. */
function GroupHeading({ row, onToggle }: GroupHeadingProps) {
  return (
    <li role="presentation" className="mg-explain-group" style={{ paddingLeft: indent(row.depth) }}>
      <button
        type="button"
        className="mg-explain-group-toggle"
        aria-expanded={row.expanded}
        onClick={onToggle}
      >
        {row.expanded ? (
          <IconChevronDown size={14} aria-hidden="true" />
        ) : (
          <IconChevronRight size={14} aria-hidden="true" />
        )}
        <span>{row.label}</span>
      </button>
    </li>
  );
}

interface CompareColumnProps {
  readonly title: string;
  readonly plan: PlanStage;
  readonly prefix: string;
  readonly metric: BarMetric;
  readonly max: number;
}

/** One plan of a comparison, read only. Its stages show the same metrics as the main tree. */
function CompareColumn({ title, plan, prefix, metric, max }: CompareColumnProps) {
  return (
    <section className="mg-explain-compare-column" aria-label={title}>
      <Text fw={600} size="sm" mb={4}>
        {title}
      </Text>
      <ul className="mg-explain-tree mg-explain-tree-static">
        {planRows(plan, new Set(), prefix).map((row) =>
          row.kind === 'group' ? (
            <li
              key={row.id}
              role="presentation"
              className="mg-explain-group"
              style={{ paddingLeft: indent(row.depth) }}
            >
              <span className="mg-explain-group-label">{row.label}</span>
            </li>
          ) : (
            <li key={row.id} className="mg-explain-row" style={{ paddingLeft: indent(row.depth) }}>
              <StageRowBody row={row} metric={metric} max={max} hot={false} />
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

interface StageIconProps {
  readonly info: StageInfo;
}

/** The category icon, in the category colour. Unknown stages get the neutral icon. */
function StageIcon({ info }: StageIconProps) {
  const scheme = useComputedColorScheme('dark');
  const Glyph = CATEGORY_ICON[info.category];
  const slot = CATEGORY_SLOT[info.category];
  const colour = slot === undefined ? 'var(--mg-text-muted)' : seriesColor(slot, scheme);
  return (
    <span
      className="mg-explain-stage-icon"
      role="img"
      aria-label={`${info.category} stage`}
      data-category={info.category}
      style={{ color: colour }}
    >
      <Glyph size={16} aria-hidden="true" />
    </span>
  );
}

function StageTooltip({ info }: { readonly info: StageInfo }) {
  return (
    <div className="mg-explain-tip">
      <div>{info.description}</div>
      {info.advice === undefined ? null : (
        <div className="mg-explain-tip-advice">{info.advice}</div>
      )}
    </div>
  );
}

interface StageRowBodyProps {
  readonly row: StageRow;
  readonly metric: BarMetric;
  readonly max: number;
  /** True for the hot stage, which the bar and the badge mark. */
  readonly hot: boolean;
  /** Expands or collapses the stage. Undefined for a stage without inputs. */
  readonly onToggle?: (() => void) | undefined;
}

/** What one stage shows: its icon and name, index, the metrics it has, its bar and bounds. */
function StageRowBody({ row, metric, max, hot, onToggle }: StageRowBodyProps) {
  const { stage } = row;
  const info = describeStage(stage.name);
  const bounds = stage.indexBounds === undefined ? [] : Object.entries(stage.indexBounds);
  const percent = barPercent(metricOf(stage, metric), max);
  const items = stageMetricItems(stage, info);
  const ratio = examinedRatio(stage, info);
  const failed = stage.name === SHARD_ERROR;

  return (
    <div className="mg-explain-row-body">
      <div className="mg-explain-row-head">
        {onToggle === undefined ? (
          <span className="mg-explain-chevron-spacer" aria-hidden="true" />
        ) : (
          <button
            type="button"
            className="mg-explain-chevron"
            tabIndex={-1}
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
          >
            {row.expanded ? (
              <IconChevronDown size={14} aria-hidden="true" />
            ) : (
              <IconChevronRight size={14} aria-hidden="true" />
            )}
          </button>
        )}
        <Tooltip
          label={<StageTooltip info={info} />}
          multiline
          w={300}
          withArrow
          openDelay={200}
          position="top-start"
        >
          <span className="mg-explain-stage-head">
            <StageIcon info={info} />
            {info.category === 'unknown' ? (
              <>
                <span className="mg-explain-unknown">Unknown stage</span>
                <code className="mg-explain-stage-name">{stage.name}</code>
              </>
            ) : (
              <span className="mg-explain-stage-name">{stage.name}</span>
            )}
          </span>
        </Tooltip>
        {stage.index === undefined ? null : (
          <Badge tt="none" variant="outline" color="gray" size="sm">
            {stage.index}
          </Badge>
        )}
        {stage.shard === undefined ? null : (
          <Badge tt="none" variant="light" color="violet" size="sm">
            {stage.shard}
          </Badge>
        )}
        {ratio === undefined ? null : (
          <Badge tt="none" variant="light" color={ratio.high ? 'red' : 'gray'} size="sm">
            {ratio.text}
          </Badge>
        )}
        {hot ? (
          <Badge tt="none" variant="light" color="red" size="sm">
            Hot
          </Badge>
        ) : null}
      </div>
      {failed ? (
        <Text size="sm" c="red" className="mg-explain-shard-error">
          {shardErrorMessage(stage.raw)}
        </Text>
      ) : null}
      {items.length === 0 ? null : (
        <div className="mg-explain-metrics">
          {items.map((item) => (
            <span key={item.key} className={item.highlight ? 'mg-explain-metric-spill' : undefined}>
              {item.label} <strong>{item.text}</strong>
            </span>
          ))}
        </div>
      )}
      <span className="mg-explain-bar" aria-hidden="true">
        <span
          className={hot ? 'mg-explain-bar-fill mg-explain-bar-hot' : 'mg-explain-bar-fill'}
          style={{ width: `${percent}%` }}
        />
      </span>
      {bounds.length === 0 ? null : (
        <details className="mg-explain-bounds" onClick={(event) => event.stopPropagation()}>
          <summary>Index bounds</summary>
          <pre>{bounds.map(([field, ranges]) => `${field}: ${ranges.join(' ')}`).join('\n')}</pre>
        </details>
      )}
    </div>
  );
}
