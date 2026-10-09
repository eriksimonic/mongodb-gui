import type { JsonEditorProps } from '../editor/JsonEditor';

/**
 * Stands in for the Monaco JSON editor in component tests, because Monaco needs a real layout
 * engine. Tests import it through vi.mock, so the text area is the one control they drive.
 */
export function JsonEditor({ value, onChange, label, readOnly = false }: JsonEditorProps) {
  return (
    <textarea
      aria-label={label}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange?.(event.currentTarget.value)}
    />
  );
}
