import { ActionIcon, Button, Group, Select, Stack, Text, TextInput } from '@mantine/core';
import { ACCUMULATORS, type AccumulatorRow, type FieldInfo, type StageBody } from '@mongo-gui/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { mongoshText } from '../condition-model';
import { RawText } from '../RawText';
import { isAccumulator, useStageKey } from './stage-form';

export type GroupBody = Extract<StageBody, { stage: '$group' }>;

export interface GroupStageFormProps {
  readonly body: GroupBody;
  /** Not used. The `$group` expressions are typed as mongosh text, not picked from fields. */
  readonly fields: readonly FieldInfo[];
  readonly onChange: (body: GroupBody) => void;
}

/**
 * The reason the output name of row `index` cannot be used, or undefined. The write is not blocked:
 * the box shows the reason, and the emitter skips a row with an empty name.
 */
function outputProblem(rows: readonly AccumulatorRow[], index: number): string | undefined {
  const name = rows[index]?.output ?? '';
  if (name.trim() === '') return 'Name the output field.';
  if (name === '_id') return '_id is the group key.';
  if (rows.some((row, other) => other !== index && row.output === name)) {
    return 'Another row uses this name.';
  }
  return undefined;
}

/** The `$group` stage: the `_id` expression and one row per output field. */
export function GroupStageForm({ body, onChange }: GroupStageFormProps) {
  const { key, emit } = useStageKey(body, onChange);

  const setAccumulators = (accumulators: readonly AccumulatorRow[]): void =>
    emit({ ...body, accumulators });
  const replace = (index: number, next: AccumulatorRow): void =>
    setAccumulators(body.accumulators.map((row, i) => (i === index ? next : row)));
  const remove = (index: number): void =>
    setAccumulators(body.accumulators.filter((_, i) => i !== index));

  return (
    <Stack gap="xs" key={key}>
      <Group gap="xs" wrap="nowrap" align="center">
        <Text size="xs" w="calc(60px * var(--mg-font-scale, 1))">
          _id
        </Text>
        <RawText
          key={mongoshText(body.id)}
          value={body.id}
          ariaLabel="Group by expression"
          width="calc(240px * var(--mg-font-scale, 1))"
          onCommit={(id) => {
            emit({ ...body, id });
            return undefined;
          }}
        />
      </Group>
      {body.accumulators.map((row, index) => (
        <Group key={index} gap="xs" wrap="nowrap" align="flex-start">
          <TextInput
            size="xs"
            aria-label="Output field"
            placeholder="Output field"
            value={row.output}
            error={outputProblem(body.accumulators, index)}
            onChange={(event) => replace(index, { ...row, output: event.currentTarget.value })}
            w="calc(160px * var(--mg-font-scale, 1))"
          />
          <Select
            size="xs"
            aria-label="Accumulator"
            allowDeselect={false}
            data={[...ACCUMULATORS]}
            value={row.accumulator}
            onChange={(value) => {
              if (isAccumulator(value)) replace(index, { ...row, accumulator: value });
            }}
            w="calc(120px * var(--mg-font-scale, 1))"
          />
          <RawText
            key={mongoshText(row.expression)}
            value={row.expression}
            ariaLabel="Accumulator expression"
            width="calc(240px * var(--mg-font-scale, 1))"
            onCommit={(expression) => {
              replace(index, { ...row, expression });
              return undefined;
            }}
          />
          <ActionIcon
            size="input-xs"
            variant="default"
            aria-label="Remove accumulator"
            onClick={() => remove(index)}
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      ))}
      <Group>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconPlus size={14} />}
          onClick={() =>
            setAccumulators([
              ...body.accumulators,
              { output: '', accumulator: '$sum', expression: null },
            ])
          }
        >
          Add accumulator
        </Button>
      </Group>
    </Stack>
  );
}
