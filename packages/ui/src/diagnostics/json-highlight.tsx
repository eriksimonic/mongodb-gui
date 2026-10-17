import type { ReactNode } from 'react';

const TOKEN_PATTERN =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)|(true|false|null)/g;

/** Colours the keys, strings, numbers and literals of formatted JSON. */
export function highlightJson(text: string) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const at = match.index;
    if (at > last) {
      parts.push(text.slice(last, at));
    }
    const [whole, string, colon, number] = match;
    const colour =
      string !== undefined
        ? colon === undefined
          ? 'var(--mg-code-string)'
          : 'var(--mg-code-key)'
        : number !== undefined
          ? 'var(--mg-code-number)'
          : 'var(--mg-code-keyword)';
    parts.push(
      <span key={at} style={{ color: colour }}>
        {colon === undefined ? whole : string}
      </span>,
    );
    if (colon !== undefined) {
      parts.push(colon);
    }
    last = at + whole.length;
  }
  parts.push(text.slice(last));
  return parts;
}
