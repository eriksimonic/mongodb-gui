/** Styles for an input that failed validation. Only the border turns red, the label and text do not. */
export function invalidInputStyles(message: string | undefined): {
  input?: { borderColor: string };
} {
  return message === undefined ? {} : { input: { borderColor: 'var(--mantine-color-red-6)' } };
}
