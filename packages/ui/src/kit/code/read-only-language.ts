import type { ReadOnlyCodeProps } from './ReadOnlyCode';

/**
 * Above this many characters the JSON language service is skipped. It parses the whole text in a
 * worker and keeps its own copy, which cost about 230 MB for a 50,000 document result. The text
 * is still shown with folding and find, only without JSON colours.
 */
export const LARGE_JSON_CHARS = 2_000_000;

/** The Monaco language for a text, which drops `json` when the text is too large for its worker. */
export function readOnlyLanguage(language: ReadOnlyCodeProps['language'], length: number): string {
  return language === 'json' && length > LARGE_JSON_CHARS ? 'plaintext' : language;
}
