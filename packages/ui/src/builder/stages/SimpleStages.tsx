import { Checkbox, Group, NumberInput, Stack, TextInput } from '@mantine/core';
import { type EjsonValue, type FieldInfo, type StageBody } from '@mongo-gui/core';
import { isRecord, mongoshText } from '../condition-model';
import { FieldPicker } from '../FieldPicker';
import { RawText } from '../RawText';

export interface RawStageProps extends StageFormProps<StageOf<'raw'>> {
  /** Stage names that have their own form. The raw stage refuses them. */
  readonly reservedNames: readonly string[];
}

/** The stage body of one kind. `$limit` and `$skip` share one body type. */
export type StageOf<K extends StageBody['stage']> = Extract<StageBody, { readonly stage: K }>;

/**
 * The props every stage form takes. A form edits its stage body and reports the whole new body on
 * each change. The stage card keeps the enabled flag, so a form never sets it.
 */
export interface StageFormProps<B extends StageBody> {
  readonly body: B;
  /** The fields of the collection. They are suggestions only. */
  readonly fields: readonly FieldInfo[];
  readonly onChange: (body: B) => void;
}

/** One number, for `$limit` and `$skip`. An empty box keeps the last number. */
export function SkipLimitStage({ body, onChange }: StageFormProps<StageOf<'$limit' | '$skip'>>) {
  return (
    <NumberInput
      size="xs"
      label="Count"
      min={0}
      allowDecimal={false}
      value={body.count}
      onChange={(value) => {
        if (typeof value === 'number') {
          onChange({ ...body, count: value });
        }
      }}
      w="calc(120px * var(--mg-font-scale, 1))"
    />
  );
}

/** The output field name of `$count`. */
export function CountStage({ body, onChange }: StageFormProps<StageOf<'$count'>>) {
  return (
    <TextInput
      size="xs"
      label="Output field"
      ff="monospace"
      value={body.output}
      onChange={(event) => onChange({ ...body, output: event.currentTarget.value })}
      w="calc(200px * var(--mg-font-scale, 1))"
    />
  );
}

/**
 * The array path of `$unwind` and the keep-empty switch. The model keeps the path without its `$`,
 * so a leading `$` that the user types is removed.
 */
export function UnwindStage({ body, fields, onChange }: StageFormProps<StageOf<'$unwind'>>) {
  return (
    <Stack gap="xs" align="flex-start">
      <FieldPicker
        label="Array path"
        fields={fields}
        value={body.path}
        onChange={(path) => onChange({ ...body, path: path.replace(/^\$/, '') })}
      />
      <Checkbox
        size="xs"
        label="Keep documents with an empty or missing array"
        checked={body.preserveEmpty}
        onChange={(event) => onChange({ ...body, preserveEmpty: event.currentTarget.checked })}
      />
    </Stack>
  );
}

/** The four fields of `$lookup`. The model keeps them without a `$`, so they are plain text. */
export function LookupStage({ body, onChange }: StageFormProps<StageOf<'$lookup'>>) {
  return (
    <Group gap="xs" align="flex-end">
      <TextInput
        size="xs"
        label="From collection"
        ff="monospace"
        value={body.from}
        onChange={(event) => onChange({ ...body, from: event.currentTarget.value })}
        w="calc(200px * var(--mg-font-scale, 1))"
      />
      <TextInput
        size="xs"
        label="Local field"
        ff="monospace"
        value={body.localField}
        onChange={(event) => onChange({ ...body, localField: event.currentTarget.value })}
        w="calc(200px * var(--mg-font-scale, 1))"
      />
      <TextInput
        size="xs"
        label="Foreign field"
        ff="monospace"
        value={body.foreignField}
        onChange={(event) => onChange({ ...body, foreignField: event.currentTarget.value })}
        w="calc(200px * var(--mg-font-scale, 1))"
      />
      <TextInput
        size="xs"
        label="Output array field"
        ff="monospace"
        value={body.as}
        onChange={(event) => onChange({ ...body, as: event.currentTarget.value })}
        w="calc(200px * var(--mg-font-scale, 1))"
      />
    </Group>
  );
}

/**
 * A stage the model has no form for, as its whole object such as `{ $addFields: { ... } }`. The
 * text must hold one key whose name starts with `$`. A name with its own form is refused, because
 * the parser reads that name as the form again. `reservedNames` lists those names.
 */
export function RawStage({ body, onChange, reservedNames }: RawStageProps) {
  const shown = { [body.name]: body.value };

  const commit = (value: EjsonValue): string | undefined => {
    const entries = isRecord(value) ? Object.entries(value) : [];
    const [entry] = entries;
    if (entries.length !== 1 || entry === undefined) {
      return 'Write one key, such as { $addFields: { ... } }';
    }
    const [name, stored] = entry;
    if (!name.startsWith('$')) {
      return 'A stage name starts with $';
    }
    if (reservedNames.includes(name)) {
      return `${name} has its own form. Use the ${name} stage instead of a raw stage.`;
    }
    onChange({ ...body, name, value: stored });
    return undefined;
  };

  return (
    <RawText
      key={mongoshText(shown)}
      value={shown}
      ariaLabel="Raw stage text"
      width="calc(480px * var(--mg-font-scale, 1))"
      onCommit={commit}
    />
  );
}
