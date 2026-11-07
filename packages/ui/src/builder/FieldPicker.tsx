import { Autocomplete } from '@mantine/core';
import type { FieldInfo } from '@mongo-gui/core';

export interface FieldPickerProps {
  /** The fields of the collection. They are suggestions only. */
  readonly fields: readonly FieldInfo[];
  readonly value: string;
  /** Receives every change, including a name that is not in `fields`. */
  readonly onChange: (field: string) => void;
  readonly label?: string | undefined;
}

/** A field name with suggestions from the collection. The user can type any name. */
export function FieldPicker({ fields, value, onChange, label = 'Field' }: FieldPickerProps) {
  return (
    <Autocomplete
      size="xs"
      aria-label={label}
      placeholder="Field name"
      data={fields.map((field) => field.path)}
      limit={50}
      value={value}
      onChange={onChange}
      ff="monospace"
      autoComplete="off"
      w="calc(200px * var(--mg-font-scale, 1))"
    />
  );
}
