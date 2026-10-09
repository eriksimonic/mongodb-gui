import { Badge, Group, SegmentedControl, Text } from '@mantine/core';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import type { PlanStage } from '@mongo-gui/core';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ancestorIds,
  barMetricFor,
  barPercent,
  hotStageId,
  maxMetric,
  metricOf,
  planRows,
  type BarMetric,
  type PlanRow,
} from './explain-model';

type StageRow = Extract<PlanRow, { readonly kind: 'stage' }>;

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
      const ancestors = ancestorIds(selection.id);
      if (ancestors.some((id) => collapsed.has(id))) {
        setCollapsed(new Set([...collapsed].filter((id) => !ancestors.includes(id))));
      }
    }
  }

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
            row.kind === 'shard' ? (
              <li
                key={row.id}
                role="presentation"
                className="mg-explain-shard"
                style={{ paddingLeft: indent(row.depth) }}
              >
                Shard {row.shard}
              </li>
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
            {rejected.map((plan, index) => (
              <ul
                key={`rejected-${index}`}
                aria-label={`Rejected plan ${index + 1}`}
                className="mg-explain-tree mg-explain-tree-static"
              >
                {planRows(plan, new Set(), `rejected-${index}`).map((row) =>
                  row.kind === 'shard' ? (
                    <li
                      key={row.id}
                      className="mg-explain-shard"
                      style={{ paddingLeft: indent(row.depth) }}
                    >
                      Shard {row.shard}
                    </li>
                  ) : (
                    <li
                      key={row.id}
                      className="mg-explain-row"
                      style={{ paddingLeft: indent(row.depth) }}
                    >
                      <StageRowBody row={row} metric={metric} max={max} hot={false} />
                    </li>
                  ),
                )}
              </ul>
            ))}
          </details>
        )}
      </div>
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

/** What one stage shows: its name, index, bounds, counters and bar. */
function StageRowBody({ row, metric, max, hot, onToggle }: StageRowBodyProps) {
  const { stage } = row;
  const bounds = stage.indexBounds === undefined ? [] : Object.entries(stage.indexBounds);
  const percent = barPercent(metricOf(stage, metric), max);

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
        <span className="mg-explain-stage-name">{stage.name}</span>
        {stage.index === undefined ? null : (
          <Badge variant="outline" color="gray" size="sm">
            {stage.index}
          </Badge>
        )}
        {stage.shard === undefined ? null : (
          <Badge variant="light" color="violet" size="sm">
            {stage.shard}
          </Badge>
        )}
        {hot ? (
          <Badge variant="light" color="red" size="sm">
            Hot
          </Badge>
        ) : null}
      </div>
      <div className="mg-explain-metrics">
        {stage.keysExamined === undefined ? null : (
          <span>
            Keys <strong>{stage.keysExamined.toLocaleString('en-US')}</strong>
          </span>
        )}
        {stage.docsExamined === undefined ? null : (
          <span>
            Docs <strong>{stage.docsExamined.toLocaleString('en-US')}</strong>
          </span>
        )}
        {stage.nReturned === undefined ? null : (
          <span>
            Returned <strong>{stage.nReturned.toLocaleString('en-US')}</strong>
          </span>
        )}
        {stage.executionTimeMs === undefined ? null : (
          <span>
            Time <strong>{stage.executionTimeMs} ms</strong>
          </span>
        )}
      </div>
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
