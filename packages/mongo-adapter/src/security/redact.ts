const MASK = '***';
// A password shorter than this is not masked by value. Masking every occurrence of a short
// string would garble unrelated text. Its `pwd` and `password` fields are masked regardless.
export const MIN_SECRET_LENGTH_TO_MASK = 8;
// Matches a `pwd` or `password` field in an echoed command, quoted or bare, in JSON or
// shell-like notation.
const SECRET_FIELD =
  /(["']?\b(?:pwd|password)["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,}\]]+)/gi;

// Removes a password from text that may come back from the server or the driver.
export function redactPassword(text: string, password?: string): string {
  const withoutField = text.replace(SECRET_FIELD, `$1"${MASK}"`);
  if (password === undefined || password.length < MIN_SECRET_LENGTH_TO_MASK) {
    return withoutField;
  }
  return withoutField.split(password).join(MASK);
}
