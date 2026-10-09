const MASK = '***';
// Matches a `pwd` field in an echoed command, quoted or bare, in JSON or shell-like notation.
const PWD_FIELD = /(["']?\bpwd["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,}\]]+)/gi;

// Removes a password from text that may come back from the server or the driver. The known
// password is masked wherever it appears, and any `pwd` field is masked whatever its value.
export function redactPassword(text: string, password?: string): string {
  const withoutField = text.replace(PWD_FIELD, `$1"${MASK}"`);
  if (password === undefined || password === '') {
    return withoutField;
  }
  return withoutField.split(password).join(MASK);
}
