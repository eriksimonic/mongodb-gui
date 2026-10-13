import { ActionIcon, CloseButton, Group, Select, Text, Tooltip } from '@mantine/core';
import { IconMinus, IconPlus, IconZoomReset } from '@tabler/icons-react';
import { describeStage, type PlanStage } from '@mongo-gui/core';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ancestorIds,
  GRAPH_GAP_Y,
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  isMeasured,
  UNMEASURED_TIP,
  planLayout,
  revealKeys,
  ROOT_STAGE_ID,
  selfTimeMs,
  stageDetail,
  stageEntries,
  stageTags,
  type GraphNode,
  type StageTag,
} from './explain-model';
import { StageIcon, type StageSelection } from './PlanTreeView';
import {
  examinedRatio,
  formatCount,
  formatDuration,
  shardErrorMessage,
  stageMetricItems,
} from './stage-view';

export interface PlanGraphViewProps {
  readonly root: PlanStage;
  readonly rejected: readonly PlanStage[];
  readonly selection: StageSelection | undefined;
  /** Called with the picked stage, or undefined when the details pane is closed. */
  readonly onSelect: (selection: StageSelection | undefined) => void;
}

const WINNING = 'winning';
const SHARD_ERROR = 'SHARD_ERROR';
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.5;
const CANVAS_PAD = 16;
const EDGE_MIN_PX = 1;
const EDGE_EXTRA_PX = 3;

function rejectedPrefix(index: number): string {
  return `rejected-${index}`;
}

function depthOf(id: string): number {
  return id.split('.').length - 1;
}

function parentOf(id: string): string | undefined {
  return ancestorIds(id).at(-1);
}

/** The sibling card next to a stage, one step left or right, when it is on screen. */
function siblingOf(id: string, step: number, onScreen: ReadonlySet<string>): string | undefined {
  const parent = parentOf(id);
  const index = Number(id.slice(id.lastIndexOf('.') + 1));
  if (parent === undefined || Number.isNaN(index)) {
    return undefined;
  }
  const sibling = `${parent}.${index + step}`;
  return onScreen.has(sibling) ? sibling : undefined;
}

/**
 * The plan as a tree of cards, root at the top and its inputs below. Each card shows its own time
 * and its share of the plan time, and marks the slowest and largest stage. A line
 * gets thicker with the documents its input returns. Clicking a card opens its details beside the
 * graph. Arrow keys move along the lines, Enter selects and Space opens or closes a card.
 */
export function PlanGraphView({ root, rejected, selection, onSelect }: PlanGraphViewProps) {
  const [planKey, setPlanKey] = useState(WINNING);
  const rejectedIndex = planKey === WINNING ? undefined : Number(planKey);
  const plan = (rejectedIndex === undefined ? undefined : rejected[rejectedIndex]) ?? root;
  const prefix = rejectedIndex === undefined ? ROOT_STAGE_ID : rejectedPrefix(rejectedIndex);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [scale, setScale] = useState(1);
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const cards = useRef(new Map<string, HTMLDivElement>());
  const scroller = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => planLayout(plan, collapsed, prefix), [plan, collapsed, prefix]);
  const entries = useMemo(() => stageEntries(plan, prefix), [plan, prefix]);
  const tags = useMemo(() => stageTags(entries), [entries]);
  const maxReturned = useMemo(
    () => entries.reduce((largest, entry) => Math.max(largest, entry.stage.nReturned ?? 0), 0),
    [entries],
  );
  const byId = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout]);
  const selectedId = selection?.id;
  const selected = entries.find((entry) => entry.id === selectedId);

  // A selection from a warning points into the winning plan, and may sit in a collapsed branch.
  // The state is adjusted during render, which React runs again before it paints.
  const [seenSelection, setSeenSelection] = useState(selection);
  if (seenSelection !== selection) {
    setSeenSelection(selection);
    if (selection !== undefined) {
      if (selection.id.split('.')[0] === ROOT_STAGE_ID && planKey !== WINNING) {
        setPlanKey(WINNING);
      }
      const revealed = revealKeys(collapsed, selection.id);
      if (revealed.size !== collapsed.size) {
        setCollapsed(revealed);
      }
    }
  }

  useEffect(() => {
    if (selectedId !== undefined) {
      cards.current.get(selectedId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }, [selection, selectedId]);

  // A plan wider than the view opens with its root in the middle, not at the left edge.
  useEffect(() => {
    const view = scroller.current;
    const top = layout.nodes[0];
    if (view !== null && top !== undefined) {
      view.scrollLeft = (top.x + GRAPH_NODE_WIDTH / 2) * scale + CANVAS_PAD - view.clientWidth / 2;
    }
    // Only a new plan recentres. Zoom and collapse keep the scroll position the user chose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  const tabStop = byId.has(focusId ?? '') ? focusId : layout.nodes[0]?.id;

  function toggle(id: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }

  function moveTo(id: string | undefined): void {
    if (id !== undefined && byId.has(id)) {
      setFocusId(id);
      cards.current.get(id)?.focus();
    }
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>, node: GraphNode): void {
    const onScreen = new Set(byId.keys());
    switch (event.key) {
      case 'ArrowDown':
        moveTo(node.expanded ? `${node.id}.0` : undefined);
        break;
      case 'ArrowUp':
        moveTo(parentOf(node.id));
        break;
      case 'ArrowLeft':
        moveTo(siblingOf(node.id, -1, onScreen));
        break;
      case 'ArrowRight':
        moveTo(siblingOf(node.id, 1, onScreen));
        break;
      case 'Enter':
        onSelect({ id: node.id });
        break;
      case ' ':
        if (node.hasChildren) {
          toggle(node.id);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  function zoomBy(step: number): void {
    setScale((current) =>
      Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((current + step) * 10) / 10)),
    );
  }

  function fit(): void {
    const available = (scroller.current?.clientWidth ?? 0) - CANVAS_PAD * 2;
    if (available > 0) {
      setScale(Math.min(1, Math.max(ZOOM_MIN, available / layout.width)));
    }
  }

  const planOptions = [
    { value: WINNING, label: 'Winning plan' },
    ...rejected.map((_, index) => ({ value: String(index), label: `Rejected plan ${index + 1}` })),
  ];

  return (
    <div className="mg-explain-graph-block">
      <Group justify="space-between" gap="xs" mb={6}>
        {rejected.length === 0 ? (
          <Text fw={600} size="sm">
            Winning plan
          </Text>
        ) : (
          <Select
            size="xs"
            aria-label="Plan"
            data={planOptions}
            value={planKey}
            allowDeselect={false}
            onChange={(value) => {
              setPlanKey(value ?? WINNING);
              setCollapsed(new Set());
              onSelect(undefined);
            }}
            w={180}
          />
        )}
        <Group gap={4}>
          <ActionIcon
            size="sm"
            variant="default"
            aria-label="Zoom out"
            disabled={scale <= ZOOM_MIN}
            onClick={() => zoomBy(-ZOOM_STEP)}
          >
            <IconMinus size={14} aria-hidden="true" />
          </ActionIcon>
          <Text size="xs" c="dimmed" w={40} ta="center">
            {Math.round(scale * 100)}%
          </Text>
          <ActionIcon
            size="sm"
            variant="default"
            aria-label="Zoom in"
            disabled={scale >= ZOOM_MAX}
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <IconPlus size={14} aria-hidden="true" />
          </ActionIcon>
          <Tooltip label="Fit the width">
            <ActionIcon size="sm" variant="default" aria-label="Fit" onClick={fit}>
              <IconZoomReset size={14} aria-hidden="true" />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      <div className="mg-explain-graph-layout">
        <div className="mg-explain-graph-scroll" ref={scroller}>
          <div
            style={{
              width: layout.width * scale + CANVAS_PAD * 2,
              height: layout.height * scale + CANVAS_PAD * 2,
            }}
          >
            <div
              role="tree"
              aria-label="Plan stages"
              className="mg-explain-graph"
              style={{
                width: layout.width,
                height: layout.height,
                margin: CANVAS_PAD,
                transform: `scale(${scale})`,
              }}
            >
              <svg
                className="mg-explain-graph-edges"
                width={layout.width}
                height={layout.height}
                aria-hidden="true"
              >
                {layout.edges.map((edge) => {
                  const from = byId.get(edge.from);
                  const to = byId.get(edge.to);
                  if (from === undefined || to === undefined) {
                    return null;
                  }
                  return (
                    <path
                      key={edge.to}
                      d={edgePath(from, to)}
                      strokeWidth={edgeWidth(to.stage.nReturned, maxReturned)}
                    />
                  );
                })}
              </svg>
              {layout.nodes.map((node) => (
                <StageCard
                  key={node.id}
                  node={node}
                  tags={tags.get(node.id) ?? []}
                  totalMs={plan.executionTimeMs}
                  selected={node.id === selectedId}
                  tabStop={node.id === tabStop}
                  cardRef={(element) => {
                    if (element === null) {
                      cards.current.delete(node.id);
                    } else {
                      cards.current.set(node.id, element);
                    }
                  }}
                  onKeyDown={(event) => handleKey(event, node)}
                  onClick={() => {
                    setFocusId(node.id);
                    onSelect({ id: node.id });
                  }}
                  onToggle={() => toggle(node.id)}
                />
              ))}
            </div>
          </div>
        </div>
        {selected === undefined ? null : (
          <StageDetails stage={selected.stage} onClose={() => onSelect(undefined)} />
        )}
      </div>
    </div>
  );
}

/** A right-angled line from the bottom of a stage to the top of one of its inputs. */
function edgePath(from: GraphNode, to: GraphNode): string {
  const x1 = from.x + GRAPH_NODE_WIDTH / 2;
  const y1 = from.y + GRAPH_NODE_HEIGHT;
  const x2 = to.x + GRAPH_NODE_WIDTH / 2;
  const middle = to.y - GRAPH_GAP_Y / 2;
  return `M ${x1} ${y1} V ${middle} H ${x2} V ${to.y}`;
}

/** Line width on a log scale of the documents the input returns. Thin when unknown. */
function edgeWidth(returned: number | undefined, max: number): number {
  if (returned === undefined || max <= 0) {
    return EDGE_MIN_PX;
  }
  return EDGE_MIN_PX + (EDGE_EXTRA_PX * Math.log10(1 + returned)) / Math.log10(1 + max);
}

/** The counts a card shows: returned, keys and documents, when the stage has them. */
function cardCounts(stage: PlanStage): string[] {
  const parts: string[] = [];
  if (stage.nReturned !== undefined) {
    parts.push(`${formatCount(stage.nReturned)} out`);
  }
  if (stage.keysExamined !== undefined && stage.keysExamined > 0) {
    parts.push(`${formatCount(stage.keysExamined)} keys`);
  }
  if (stage.docsExamined !== undefined && stage.docsExamined > 0) {
    parts.push(`${formatCount(stage.docsExamined)} docs`);
  }
  return parts;
}

interface StageCardProps {
  readonly node: GraphNode;
  readonly tags: readonly StageTag[];
  /** The time of the whole plan, which the share of each stage is taken from. */
  readonly totalMs: number | undefined;
  readonly selected: boolean;
  readonly tabStop: boolean;
  readonly cardRef: (element: HTMLDivElement | null) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onClick: () => void;
  readonly onToggle: () => void;
}

function StageCard({
  node,
  tags,
  totalMs,
  selected,
  tabStop,
  cardRef,
  onKeyDown,
  onClick,
  onToggle,
}: StageCardProps) {
  const { stage } = node;
  const info = describeStage(stage.name);
  const failed = stage.name === SHARD_ERROR;
  const detail = failed ? shardErrorMessage(stage.raw) : stageDetail(stage);
  const own = selfTimeMs(stage);
  const share =
    own === undefined || totalMs === undefined || totalMs <= 0
      ? undefined
      : Math.round((own / totalMs) * 100);
  return (
    <div
      ref={cardRef}
      role="treeitem"
      aria-level={depthOf(node.id) + 1}
      aria-selected={selected}
      aria-expanded={node.hasChildren ? node.expanded : undefined}
      tabIndex={tabStop ? 0 : -1}
      className="mg-explain-node"
      style={{ left: node.x, top: node.y, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }}
      title={info.description}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      {stage.label === undefined ? null : (
        <span className="mg-explain-node-label" title={stage.label}>
          {stage.label}
        </span>
      )}
      <div className="mg-explain-node-head">
        <StageIcon info={info} />
        <span className="mg-explain-stage-name mg-explain-node-name">{stage.name}</span>
        {own === undefined ? null : (
          <span className="mg-explain-node-time" title="Time of this stage without its inputs">
            {formatDuration(own)}
            {share === undefined ? null : <strong> | {share}%</strong>}
          </span>
        )}
      </div>
      <div
        className={failed ? 'mg-explain-node-sub mg-explain-shard-error' : 'mg-explain-node-sub'}
        title={detail}
      >
        {detail}
      </div>
      {isMeasured(stage) ? (
        <div className="mg-explain-node-metrics">{cardCounts(stage).join(' · ')}</div>
      ) : (
        <div className="mg-explain-node-metrics mg-explain-unmeasured" title={UNMEASURED_TIP}>
          not measured
        </div>
      )}
      <div className="mg-explain-node-tags">
        {tags.map((tag) => (
          <span key={tag} className="mg-explain-node-tag">
            {tag}
          </span>
        ))}
      </div>
      {node.hasChildren ? (
        <button
          type="button"
          className="mg-explain-node-toggle"
          tabIndex={-1}
          aria-label={node.expanded ? 'Collapse inputs' : `Show ${node.hidden} hidden stages`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          {node.expanded ? '−' : `+${node.hidden}`}
        </button>
      ) : null}
    </div>
  );
}

/** The raw node with the nested stages replaced by their names, so it stays short. */
function rawWithoutInputs(raw: unknown): string {
  return JSON.stringify(
    raw,
    (_, value: unknown) => {
      if (value === raw || typeof value !== 'object' || value === null || Array.isArray(value)) {
        return value;
      }
      const nested = (value as Record<string, unknown>)['stage'];
      return typeof nested === 'string' ? `[stage ${nested}]` : value;
    },
    2,
  );
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

interface StageDetailsProps {
  readonly stage: PlanStage;
  readonly onClose: () => void;
}

/** Everything about one stage that the card leaves out. */
function StageDetails({ stage, onClose }: StageDetailsProps) {
  const info = describeStage(stage.name);
  const items = stageMetricItems(stage, info);
  const ratio = examinedRatio(stage, info);
  const bounds = stage.indexBounds === undefined ? [] : Object.entries(stage.indexBounds);
  return (
    <aside className="mg-explain-details" aria-label="Stage details">
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <StageIcon info={info} />
          <span className="mg-explain-stage-name mg-explain-node-name">{stage.name}</span>
        </Group>
        <CloseButton size="sm" aria-label="Close stage details" onClick={onClose} />
      </Group>
      {stage.label === undefined ? null : (
        <Text size="xs" c="dimmed">
          {stage.label}
        </Text>
      )}
      <Text size="xs">{info.description}</Text>
      {info.advice === undefined ? null : (
        <Text size="xs" c="dimmed">
          {info.advice}
        </Text>
      )}
      {items.length === 0 && ratio === undefined ? null : (
        <dl className="mg-explain-details-list">
          {items.map((item) => (
            <div key={item.key}>
              <dt>{item.label}</dt>
              <dd className={item.highlight ? 'mg-explain-metric-spill' : undefined}>
                {item.text}
              </dd>
            </div>
          ))}
          {ratio === undefined ? null : (
            <div>
              <dt>Examined per returned</dt>
              <dd className={ratio.high ? 'mg-explain-details-high' : undefined}>{ratio.text}</dd>
            </div>
          )}
        </dl>
      )}
      {stage.index === undefined ? null : <DetailCode title="Index" text={stage.index} />}
      {bounds.length === 0 ? null : (
        <DetailCode
          title="Index bounds"
          text={bounds.map(([field, ranges]) => `${field}: ${ranges.join(' ')}`).join('\n')}
        />
      )}
      {stage.sortPattern === undefined ? null : (
        <DetailCode title="Sort" text={jsonText(stage.sortPattern)} />
      )}
      {stage.filter === undefined ? null : (
        <DetailCode title="Filter" text={jsonText(stage.filter)} />
      )}
      {stage.projection === undefined ? null : (
        <DetailCode title="Projection" text={jsonText(stage.projection)} />
      )}
      <details className="mg-explain-details-raw">
        <summary>Raw stage</summary>
        <pre>{rawWithoutInputs(stage.raw)}</pre>
      </details>
    </aside>
  );
}

function DetailCode({ title, text }: { readonly title: string; readonly text: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {title}
      </Text>
      <pre className="mg-explain-details-code">{text}</pre>
    </div>
  );
}
