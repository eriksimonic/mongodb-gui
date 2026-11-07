import { ActionIcon, Button, Menu } from '@mantine/core';
import { type FieldInfo, isLiveStage, type PipelineStage, type StageBody } from '@mongo-gui/core';
import { IconArrowDown, IconArrowUp, IconCopy, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { BuilderCard } from './BuilderCard';
import { countText, STAGE_ICONS, STAGE_TONES } from './card-kinds';
import { GroupStageForm } from './stages/GroupStage';
import { MatchStageForm, ProjectStageForm, SortStageForm } from './stages/RowStages';
import {
  CountStage,
  LookupStage,
  RawStage,
  SkipLimitStage,
  UnwindStage,
} from './stages/SimpleStages';

/** The label of each stage kind. The raw stage card shows its own name instead. */
const STAGE_LABELS: Record<StageBody['stage'], string> = {
  $match: '$match',
  $project: '$project',
  $sort: '$sort',
  $limit: '$limit',
  $skip: '$skip',
  $count: '$count',
  $unwind: '$unwind',
  $group: '$group',
  $lookup: '$lookup',
  raw: 'Raw stage',
};

/** The body each stage kind starts with when the user adds it. */
const NEW_STAGE: Record<StageBody['stage'], () => StageBody> = {
  $match: () => ({ stage: '$match', filter: { kind: 'group', operator: 'and', items: [] } }),
  $project: () => ({ stage: '$project', rows: [] }),
  $sort: () => ({ stage: '$sort', rows: [] }),
  $limit: () => ({ stage: '$limit', count: 10 }),
  $skip: () => ({ stage: '$skip', count: 0 }),
  $count: () => ({ stage: '$count', output: 'count' }),
  $unwind: () => ({ stage: '$unwind', path: '', preserveEmpty: false }),
  $group: () => ({ stage: '$group', id: null, accumulators: [] }),
  $lookup: () => ({ stage: '$lookup', from: '', localField: '', foreignField: '', as: '' }),
  raw: () => ({ stage: 'raw', name: '$addFields', value: {} }),
};

/** The stage kinds in the order of the "Add stage" menu. */
const STAGE_KINDS = Object.keys(STAGE_LABELS) as StageBody['stage'][];

let lastKey = 0;

function nextKey(): number {
  lastKey += 1;
  return lastKey;
}

/** A copy of `items` with the item at `from` moved to `to`. */
function movedItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) {
    next.splice(to, 0, item);
  }
  return next;
}

/** One dimmed line for the card header: what the stage does, in a few words. */
function summaryOf(body: StageBody): string | undefined {
  switch (body.stage) {
    case '$match':
      return body.filter.items.length === 0
        ? 'Matches every document'
        : countText(body.filter.items.length, 'condition');
    case '$project':
      return body.rows.length === 0 ? 'All fields' : countText(body.rows.length, 'field');
    case '$sort':
      return body.rows.length === 0 ? 'No sort fields' : countText(body.rows.length, 'field');
    case '$limit':
      return `First ${body.count}`;
    case '$skip':
      return `Skips ${body.count}`;
    case '$count':
      return body.output === '' ? undefined : `Into ${body.output}`;
    case '$unwind':
      return body.path === '' ? 'No array path' : `Splits ${body.path}`;
    case '$group':
      return countText(body.accumulators.length, 'accumulator');
    case '$lookup':
      return body.from === '' ? 'No collection' : `Joins ${body.from}`;
    case 'raw':
      return undefined;
  }
}

interface StageFormSwitchProps {
  readonly body: StageBody;
  readonly fields: readonly FieldInfo[];
  readonly onChange: (body: StageBody) => void;
}

/** The stage body without its enabled flag. The stage card keeps the flag, not the form. */
function bodyOf(stage: PipelineStage): StageBody {
  const entries = Object.entries(stage).filter(([key]) => key !== 'enabled');
  return Object.fromEntries(entries) as StageBody;
}

/**
 * The form of a stage body. This is the one place that maps a stage kind to its form. The forms
 * of `$match`, `$project`, `$sort` and `$group` come from `stages/RowStages.tsx` and
 * `stages/GroupStage.tsx`.
 */
function StageForm({ body, fields, onChange }: StageFormSwitchProps) {
  switch (body.stage) {
    case '$match':
      return <MatchStageForm body={body} fields={fields} onChange={onChange} />;
    case '$project':
      return <ProjectStageForm body={body} fields={fields} onChange={onChange} />;
    case '$sort':
      return <SortStageForm body={body} fields={fields} onChange={onChange} />;
    case '$group':
      return <GroupStageForm body={body} fields={fields} onChange={onChange} />;
    case '$limit':
    case '$skip':
      return <SkipLimitStage body={body} fields={fields} onChange={onChange} />;
    case '$count':
      return <CountStage body={body} fields={fields} onChange={onChange} />;
    case '$unwind':
      return <UnwindStage body={body} fields={fields} onChange={onChange} />;
    case '$lookup':
      return <LookupStage body={body} fields={fields} onChange={onChange} />;
    case 'raw':
      return (
        <RawStage body={body} fields={fields} onChange={onChange} reservedNames={STAGE_KINDS} />
      );
  }
}

export interface StageListProps {
  readonly stages: readonly PipelineStage[];
  /** The fields of the collection. They are suggestions only. */
  readonly fields: readonly FieldInfo[];
  readonly onChange: (stages: PipelineStage[]) => void;
}

/**
 * The stages of an aggregation pipeline in order, one card each on a numbered rail. It is
 * controlled: the parent holds the stages and receives every change as a new list. A disabled
 * stage stays in the list and is left out of the statement text. StageList creates its card keys
 * once at mount. The parent (BuilderPanel, task U7) must remount this component with a `key` when
 * the stages change from outside.
 */
export function StageList({ stages, fields, onChange }: StageListProps) {
  // Each card keeps a key, so a form keeps its own draft text when the cards before it move.
  const [keys, setKeys] = useState<number[]>(() => stages.map(() => nextKey()));
  const keyAt = (index: number): number | string => keys[index] ?? `new-${index}`;

  const commit = (next: PipelineStage[], nextKeys: number[]): void => {
    setKeys(nextKeys);
    onChange(next);
  };

  const setBody = (index: number, body: StageBody): void => {
    const current = stages[index];
    if (current === undefined) {
      return;
    }
    onChange(
      stages.map((stage, position) =>
        position === index ? { ...body, enabled: current.enabled } : stage,
      ),
    );
  };

  const setEnabled = (index: number, enabled: boolean): void => {
    onChange(stages.map((stage, position) => (position === index ? { ...stage, enabled } : stage)));
  };

  const remove = (index: number): void => {
    commit(
      stages.filter((_, position) => position !== index),
      keys.filter((_, position) => position !== index),
    );
  };

  const move = (index: number, to: number): void => {
    if (to < 0 || to >= stages.length) {
      return;
    }
    commit(movedItem(stages, index, to), movedItem(keys, index, to));
  };

  const copy = (index: number): void => {
    const stage = stages[index];
    if (stage === undefined) {
      return;
    }
    commit(
      [...stages.slice(0, index + 1), stage, ...stages.slice(index + 1)],
      [...keys.slice(0, index + 1), nextKey(), ...keys.slice(index + 1)],
    );
  };

  const add = (kind: StageBody['stage']): void => {
    commit([...stages, { ...NEW_STAGE[kind](), enabled: true }], [...keys, nextKey()]);
  };

  return (
    <ol className="mg-qb-pipeline">
      {stages.map((stage, index) => {
        const body = bodyOf(stage);
        const title = stage.stage === 'raw' ? stage.name : STAGE_LABELS[stage.stage];
        return (
          <li
            className="mg-qb-stage mg-qb-row"
            key={keyAt(index)}
            data-tone={STAGE_TONES[stage.stage]}
            data-enabled={stage.enabled}
          >
            <span className="mg-qb-stage-node" aria-hidden="true">
              {index + 1}
            </span>
            <BuilderCard
              title={title}
              code
              icon={STAGE_ICONS[stage.stage]}
              tone={STAGE_TONES[stage.stage]}
              summary={summaryOf(body)}
              note={
                stage.enabled && !isLiveStage(stage) ? (
                  <span className="mg-qb-stage-note">Not in the query yet</span>
                ) : undefined
              }
              actions={
                <>
                  <ActionIcon
                    variant="subtle"
                    size="input-xs"
                    aria-label="Move stage up"
                    disabled={index === 0}
                    onClick={() => move(index, index - 1)}
                  >
                    <IconArrowUp size={14} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    size="input-xs"
                    aria-label="Move stage down"
                    disabled={index === stages.length - 1}
                    onClick={() => move(index, index + 1)}
                  >
                    <IconArrowDown size={14} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    size="input-xs"
                    aria-label="Copy stage"
                    onClick={() => copy(index)}
                  >
                    <IconCopy size={14} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="input-xs"
                    aria-label="Delete stage"
                    onClick={() => remove(index)}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </>
              }
              enabled={stage.enabled}
              toggleLabel="Enable stage"
              onToggle={(enabled) => setEnabled(index, enabled)}
              ariaLabel={`Stage ${index + 1}, ${title}`}
            >
              <StageForm body={body} fields={fields} onChange={(next) => setBody(index, next)} />
            </BuilderCard>
          </li>
        );
      })}
      <li className="mg-qb-pipeline-foot">
        <span className="mg-qb-stage-node" aria-hidden="true">
          <IconPlus size={12} />
        </span>
        <Menu position="bottom-start" shadow="md">
          <Menu.Target>
            <Button size="xs" variant="default" leftSection={<IconPlus size={14} />}>
              Add stage
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {STAGE_KINDS.map((kind) => {
              const Icon = STAGE_ICONS[kind];
              return (
                <Menu.Item
                  key={kind}
                  onClick={() => add(kind)}
                  leftSection={
                    <span className="mg-qb-card-icon" data-tone={STAGE_TONES[kind]}>
                      <Icon size={14} stroke={1.75} />
                    </span>
                  }
                >
                  {STAGE_LABELS[kind]}
                </Menu.Item>
              );
            })}
          </Menu.Dropdown>
        </Menu>
        {stages.length === 0 && <span className="mg-qb-hint">The pipeline has no stages.</span>}
      </li>
    </ol>
  );
}
