import type { FilterEditorProps } from '../editor/FilterEditor';

/**
 * Stands in for the Monaco filter editor in component tests, because Monaco needs a real layout
 * engine. Tests import it through vi.mock, so the text area is the one control they drive.
 */
export function FilterEditor({
  value,
  onChange,
  ariaLabel,
  error,
  readOnly = false,
}: FilterEditorProps) {
  return (
    <>
      <textarea
        aria-label={ariaLabel}
        aria-invalid={error === undefined ? undefined : true}
        value={value}
        readOnly={readOnly}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
      {error === undefined ? null : <p>{error}</p>}
    </>
  );
}
