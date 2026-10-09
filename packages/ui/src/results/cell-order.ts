import { cellView, numberOf } from './result-model';

/** Orders numbers by value and everything else by its text, so mixed columns still sort. */
export function compareCells(left: unknown, right: unknown): number {
  const a = numberOf(left);
  const b = numberOf(right);
  if (a !== undefined && b !== undefined) {
    return a - b;
  }
  return cellView(left ?? null).text.localeCompare(cellView(right ?? null).text, undefined, {
    numeric: true,
  });
}
