import type { ReadOnlyCodeProps } from '../editor/ReadOnlyCode';

/** Stands in for the read-only Monaco view in component tests. The text is the only thing it shows. */
export function ReadOnlyCode({ label, value }: ReadOnlyCodeProps) {
  return <textarea aria-label={label} readOnly value={value} />;
}
