import { ActionIcon, Checkbox, Group, Select, Text, TextInput } from '@mantine/core';
import {
  ARRAY_ELEMENT_FIELD,
  type ConditionOperator,
  type EjsonValue,
  type FieldInfo,
  parseValueText,
  type QueryCondition,
  type RawCondition,
  type RawFragment,
} from '@mongo-gui/core';
import { IconCopy, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import {
  conditionFor,
  isRecord,
  mongoshText,
  operatorsFor,
  regexValueOf,
  typesOf,
  valueTypeFor,
  valueTypeOfValue,
} from './condition-model';
import { FieldPicker } from './FieldPicker';
import { RawText } from './RawText';
import { ValueInput } from './ValueInput';
import type { ValueType } from './value-types';

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  eq: 'equals',
  ne: 'not equal to',
  gt: 'greater than',
  gte: 'greater than or equal to',
  lt: 'less than',
  lte: 'less than or equal to',
  in: 'is one of',
  nin: 'is not one of',
  exists: 'exists',
  type: 'has type',
  regex: 'matches regex',
  size: 'array size is',
  all: 'has all of',
  elemMatch: 'has array element matching',
};

/**
 * The type a row mounts with. A stored value shows in the type of its own shape. Only a new or
 * empty value takes the type that the operator and the field give.
 */
function startTypeOf(item: QueryCondition, types: readonly string[]): ValueType {
  if (item.operator === 'regex' || item.operator === 'elemMatch' || item.value === '') {
    return valueTypeFor(item.operator, types);
  }
  return valueTypeOfValue(item.value);
}

export interface ConditionRowProps {
  readonly item: QueryCondition;
  /** The fields the row can use, in the scope of its group. */
  readonly fields: readonly FieldInfo[];
  /** True in a scalar `$elemMatch` group: the field is fixed and the operators are limited. */
  readonly scalarElement?: boolean;
  /** The operators other conditions of a scalar group already use. */
  readonly takenOperators?: readonly ConditionOperator[] | undefined;
  readonly onChange: (item: QueryCondition) => void;
  readonly onCopy: () => void;
  readonly onDelete: () => void;
}

/**
 * One condition: enable checkbox, field, operator, value, copy and delete. An `$elemMatch` row
 * shows its operator only. Its group is drawn below it by the group editor. A regex row has a text
 * box for `/pattern/flags` and no type menu, because the model holds only the pattern and options.
 *
 * The value input reads its type and value on mount. It is remounted with a new key when the
 * field or the operator changes. An invalid value sends `undefined`, and the row keeps the model
 * value.
 */
export function ConditionRow({
  item,
  fields,
  scalarElement = false,
  takenOperators = [],
  onChange,
  onCopy,
  onDelete,
}: ConditionRowProps) {
  const [valueType, setValueType] = useState<ValueType>(() =>
    startTypeOf(item, typesOf(fields, item.field)),
  );

  const operators = operatorsFor(fields, item.field, scalarElement, takenOperators);
  const options = operators.includes(item.operator) ? operators : [item.operator, ...operators];

  const changeField = (field: string): void => {
    const types = typesOf(fields, field);
    const allowed = operatorsFor(fields, field, false, []);
    const operator = allowed.includes(item.operator) ? item.operator : 'eq';
    const next = valueTypeFor(operator, types);
    onChange(
      conditionFor(item, field, operator, fields, operator === item.operator && next === valueType),
    );
    setValueType(next);
  };

  const changeOperator = (operator: ConditionOperator): void => {
    const next = valueTypeFor(operator, typesOf(fields, item.field));
    onChange(conditionFor(item, item.field, operator, fields, next === valueType));
    setValueType(next);
  };

  const changeValue = (value: unknown): void => {
    // An invalid value arrives as undefined. The model keeps its value.
    if (value === undefined || item.operator === 'regex' || item.operator === 'elemMatch') {
      return;
    }
    onChange({ ...item, value });
  };

  const changeRegex = (regex: { readonly pattern: string; readonly options: string }): void => {
    onChange({
      kind: 'condition',
      enabled: item.enabled,
      field: item.field,
      operator: 'regex',
      ...regex,
    });
  };

  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Checkbox
        size="xs"
        aria-label="Enable condition"
        checked={item.enabled}
        onChange={(event) => onChange({ ...item, enabled: event.currentTarget.checked })}
      />
      {scalarElement ? (
        <Text size="xs" ff="monospace" w="calc(200px * var(--mg-font-scale, 1))">
          {ARRAY_ELEMENT_FIELD}
        </Text>
      ) : (
        <FieldPicker fields={fields} value={item.field} onChange={changeField} />
      )}
      <Select
        size="xs"
        aria-label="Operator"
        allowDeselect={false}
        data={options.map((operator) => ({ value: operator, label: OPERATOR_LABELS[operator] }))}
        value={item.operator}
        onChange={(value) => {
          if (value !== null) {
            changeOperator(value as ConditionOperator);
          }
        }}
        w="calc(200px * var(--mg-font-scale, 1))"
      />
      {item.operator === 'regex' && (
        <RegexValue
          key={`${item.field}:${item.operator}`}
          pattern={item.pattern}
          options={item.options}
          onChange={changeRegex}
        />
      )}
      {item.operator !== 'elemMatch' && item.operator !== 'regex' && (
        <ValueInput
          key={`${item.field}:${item.operator}`}
          type={valueType}
          value={item.value}
          onChange={changeValue}
          onTypeChange={setValueType}
        />
      )}
      <ActionIcon
        variant="subtle"
        size="input-xs"
        aria-label="Copy condition"
        disabled={scalarElement}
        onClick={onCopy}
      >
        <IconCopy size={14} />
      </ActionIcon>
      <ActionIcon
        variant="subtle"
        color="red"
        size="input-xs"
        aria-label="Delete condition"
        onClick={onDelete}
      >
        <IconTrash size={14} />
      </ActionIcon>
    </Group>
  );
}

interface RegexValueProps {
  readonly pattern: string;
  readonly options: string;
  readonly onChange: (regex: { readonly pattern: string; readonly options: string }) => void;
}

/**
 * A regex as `/pattern/flags` text. Each change is read at once. Text that is not a regex keeps the
 * model value and shows red with the reason.
 */
function RegexValue({ pattern, options, onChange }: RegexValueProps) {
  const [draft, setDraft] = useState(() =>
    mongoshText({ $regularExpression: { pattern, options } }),
  );
  const [error, setError] = useState<string | null>(null);

  const edit = (text: string): void => {
    setDraft(text);
    const parsed = parseValueText(text);
    if ('unsupported' in parsed) {
      setError(parsed.unsupported);
      return;
    }
    const regex = regexValueOf(parsed.value);
    if (regex === undefined) {
      setError('Enter a regex, such as /abc/i');
      return;
    }
    setError(null);
    onChange(regex);
  };

  return (
    <TextInput
      size="xs"
      aria-label="Regex value"
      ff="monospace"
      value={draft}
      error={error}
      onChange={(event) => edit(event.currentTarget.value)}
      w="calc(220px * var(--mg-font-scale, 1))"
    />
  );
}

export interface RawItemRowProps {
  readonly item: RawCondition | RawFragment;
  readonly onChange: (item: RawCondition | RawFragment) => void;
  readonly onCopy: () => void;
  readonly onDelete: () => void;
  /** True in a scalar `$elemMatch` group, where a copy would repeat an operator. */
  readonly copyDisabled?: boolean | undefined;
}

/**
 * A condition or top-level key the model does not know. A raw condition shows its operator value
 * as mongosh text. A raw fragment shows its whole `{ key: value }` object and must keep one key.
 */
export function RawItemRow({
  item,
  onChange,
  onCopy,
  onDelete,
  copyDisabled = false,
}: RawItemRowProps) {
  const label = item.kind === 'rawCondition' ? `${item.field} ${item.operator}` : item.key;
  const shown = item.kind === 'rawCondition' ? item.value : { [item.key]: item.value };

  const commit = (value: EjsonValue): string | undefined => {
    if (item.kind === 'rawCondition') {
      onChange({ ...item, value });
      return undefined;
    }
    const entries = isRecord(value) ? Object.entries(value) : [];
    const [entry] = entries;
    if (entries.length !== 1 || entry === undefined) {
      return 'Write one key, such as { $expr: ... }';
    }
    onChange({ ...item, key: entry[0], value: entry[1] });
    return undefined;
  };

  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Checkbox
        size="xs"
        aria-label="Enable raw item"
        checked={item.enabled}
        onChange={(event) => onChange({ ...item, enabled: event.currentTarget.checked })}
      />
      <Text size="xs" ff="monospace" truncate="end" w="calc(180px * var(--mg-font-scale, 1))">
        {label}
      </Text>
      <RawText
        value={shown}
        ariaLabel={`${label} value`}
        width="calc(260px * var(--mg-font-scale, 1))"
        onCommit={commit}
      />
      <ActionIcon
        variant="subtle"
        size="input-xs"
        aria-label="Copy raw item"
        disabled={copyDisabled}
        onClick={onCopy}
      >
        <IconCopy size={14} />
      </ActionIcon>
      <ActionIcon
        variant="subtle"
        color="red"
        size="input-xs"
        aria-label="Delete raw item"
        onClick={onDelete}
      >
        <IconTrash size={14} />
      </ActionIcon>
    </Group>
  );
}
