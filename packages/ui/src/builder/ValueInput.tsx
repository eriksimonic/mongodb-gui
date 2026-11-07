import { Group, Menu, SegmentedControl, TextInput } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { type ReactNode, useState } from 'react';
import { isRecord } from './condition-model';
import { VALUE_TYPES, type ValueType } from './value-types';

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const OBJECT_ID_TEXT = /^[0-9a-f]{24}$/i;
const REGEX_TEXT = /^\/(.*)\/([imsu]*)$/s;

/** The text of the input and the type it is read as. */
interface Draft {
  readonly type: ValueType;
  readonly text: string;
}

type Parsed = { readonly value: unknown } | { readonly error: string };

function pad(part: number): string {
  return String(part).padStart(2, '0');
}

/**
 * Local date and time in the form a datetime-local input shows. Seconds are always shown. The
 * milliseconds are shown only when they are not zero.
 */
function localInputText(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const millis = date.getMilliseconds();
  const fraction = millis === 0 ? '' : `.${String(millis).padStart(3, '0')}`;
  return `${day}T${time}${fraction}`;
}

/** The text an input of a type shows for a value. A value of another shape shows as empty text. */
function textOf(type: ValueType, value: unknown): string {
  switch (type) {
    case 'String':
      return typeof value === 'string' ? value : '';
    case 'Number':
      return typeof value === 'number' ? String(value) : '';
    case 'Boolean':
      return value === false ? 'false' : 'true';
    case 'Null':
      return '';
    case 'Date': {
      if (!isRecord(value) || typeof value.$date !== 'string') {
        return '';
      }
      const date = new Date(value.$date);
      return Number.isNaN(date.getTime()) ? '' : localInputText(date);
    }
    case 'ObjectId':
      return isRecord(value) && typeof value.$oid === 'string' ? value.$oid : '';
    case 'Regex': {
      const regex = isRecord(value) ? value.$regularExpression : undefined;
      if (!isRecord(regex) || typeof regex.pattern !== 'string') {
        return '';
      }
      return `/${regex.pattern}/${typeof regex.options === 'string' ? regex.options : ''}`;
    }
    case 'List':
      return Array.isArray(value) ? JSON.stringify(value) : '[]';
  }
}

function jsonArrayOf(text: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the text of a type as canonical EJSON, or gives the reason the text is not valid. */
function parse(type: ValueType, text: string): Parsed {
  switch (type) {
    case 'String':
      return { value: text };
    case 'Number':
      return NUMBER_TEXT.test(text) ? { value: Number(text) } : { error: 'Enter a number' };
    case 'Boolean':
      return { value: text === 'true' };
    case 'Null':
      return { value: null };
    case 'Date': {
      const date = new Date(text);
      return Number.isNaN(date.getTime())
        ? { error: 'Enter a date and time' }
        : { value: { $date: date.toISOString() } };
    }
    case 'ObjectId':
      return OBJECT_ID_TEXT.test(text)
        ? { value: { $oid: text } }
        : { error: 'An ObjectId has 24 hex characters' };
    case 'Regex': {
      const match = REGEX_TEXT.exec(text);
      if (match === null) {
        return { error: 'Use /pattern/flags, with the flags i, m, s or u' };
      }
      return {
        value: { $regularExpression: { pattern: match[1] ?? '', options: match[2] ?? '' } },
      };
    }
    case 'List': {
      const list = jsonArrayOf(text);
      return list === undefined ? { error: 'Enter a JSON array' } : { value: list };
    }
  }
}

/** The text to keep when the type changes. Text with no meaning in the new type is cleared. */
function carryText(next: ValueType, text: string): string {
  if (next === 'Boolean') {
    return text === 'false' ? 'false' : 'true';
  }
  return next === 'Date' || next === 'Null' ? '' : text;
}

export interface ValueInputProps {
  /** The type to start with. */
  readonly type: ValueType;
  /** The value to start with, as canonical EJSON. */
  readonly value: unknown;
  /** Receives the EJSON value, or undefined while the text is not a valid value of its type. */
  readonly onChange: (value: unknown) => void;
  /** Receives the type the user picks in the type menu. */
  readonly onTypeChange?: ((type: ValueType) => void) | undefined;
}

/**
 * A value with a type menu. The input of each type reads its own text and marks invalid text red.
 *
 * `type` and `value` are read on mount only. After that the component keeps its own draft. The
 * parent remounts it with a `key` when the field or the operator changes, so the draft starts again
 * from the type and value of the new field or operator.
 */
export function ValueInput({
  type: startType,
  value: startValue,
  onChange,
  onTypeChange,
}: ValueInputProps) {
  const [draft, setDraft] = useState<Draft>(() => ({
    type: startType,
    text: textOf(startType, startValue),
  }));

  const update = (next: Draft): void => {
    setDraft(next);
    const result = parse(next.type, next.text);
    onChange('error' in result ? undefined : result.value);
  };

  const chooseType = (type: ValueType): void => {
    update({ type, text: carryText(type, draft.text) });
    onTypeChange?.(type);
  };

  const result = parse(draft.type, draft.text);
  const error = 'error' in result ? result.error : undefined;
  const setText = (text: string): void => update({ type: draft.type, text });

  const monospace = draft.type === 'ObjectId' || draft.type === 'Regex' || draft.type === 'List';
  const fontProps = monospace ? { ff: 'monospace' as const } : {};
  // A datetime-local input with milliseconds needs a step below one second.
  const dateProps = draft.type === 'Date' ? { step: draft.text.includes('.') ? 0.001 : 1 } : {};

  let input: ReactNode;
  if (draft.type === 'Null') {
    input = <span className="mg-qb-null">null</span>;
  } else if (draft.type === 'Boolean') {
    input = (
      <SegmentedControl
        size="xs"
        aria-label="Boolean value"
        data={['true', 'false']}
        value={draft.text}
        onChange={setText}
      />
    );
  } else {
    input = (
      <TextInput
        size="xs"
        aria-label="Value"
        type={draft.type === 'Date' ? 'datetime-local' : 'text'}
        {...fontProps}
        {...dateProps}
        value={draft.text}
        onChange={(event) => setText(event.currentTarget.value)}
        error={error}
        w="calc(220px * var(--mg-font-scale, 1))"
      />
    );
  }

  return (
    <Group gap={6} wrap="nowrap" align="flex-start">
      <Menu>
        <Menu.Target>
          <button
            type="button"
            className="mg-qb-type"
            data-type={draft.type}
            aria-label="Value type"
            title={`Value type: ${draft.type}`}
          >
            {draft.type}
            <IconChevronDown size={10} />
          </button>
        </Menu.Target>
        <Menu.Dropdown>
          {VALUE_TYPES.map((type) => (
            <Menu.Item
              key={type}
              onClick={() => chooseType(type)}
              leftSection={<span className="mg-qb-type-dot" data-type={type} />}
            >
              {type}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
      {input}
    </Group>
  );
}
