import { ActionIcon, Button, Checkbox, Group, Menu, Paper, Stack, Text } from '@mantine/core';
import type { FieldInfo, PipelineStage, StageBody } from '@mongo-gui/core';
import { IconArrowDown, IconArrowUp, IconCopy, IconPlus, IconTrash } from '@tabler/icons-react';
import { Fragment, useState } from 'react';
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
 * The stages of an aggregation pipeline in order, one card each. It is controlled: the parent
 * holds the stages and receives every change as a new list. A disabled stage stays in the list
 * and is left out of the statement text. StageList creates its card keys once at mount. The parent
 * (BuilderPanel, task U7) must remount this component with a `key` when the stages change from
 * outside.
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
    <Stack gap="xs">
      {stages.length === 0 && (
        <Text size="sm" c="dimmed">
          The pipeline has no stages.
        </Text>
      )}
      {stages.map((stage, index) => (
        <Fragment key={keyAt(index)}>
          <Paper withBorder p="xs" opacity={stage.enabled ? 1 : 0.6}>
            <Stack gap="xs">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                  <Checkbox
                    size="xs"
                    aria-label="Enable stage"
                    checked={stage.enabled}
                    onChange={(event) => setEnabled(index, event.currentTarget.checked)}
                  />
                  <Text size="sm" fw={600} ff="monospace">
                    {stage.stage === 'raw' ? stage.name : STAGE_LABELS[stage.stage]}
                  </Text>
                </Group>
                <Group gap={4} wrap="nowrap">
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
                </Group>
              </Group>
              <StageForm
                body={bodyOf(stage)}
                fields={fields}
                onChange={(body) => setBody(index, body)}
              />
            </Stack>
          </Paper>
        </Fragment>
      ))}
      <Group>
        <Menu position="bottom-start" shadow="md">
          <Menu.Target>
            <Button size="xs" variant="default" leftSection={<IconPlus size={14} />}>
              Add stage
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {STAGE_KINDS.map((kind) => (
              <Menu.Item key={kind} onClick={() => add(kind)}>
                {STAGE_LABELS[kind]}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Group>
    </Stack>
  );
}
