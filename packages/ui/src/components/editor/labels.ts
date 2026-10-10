const TIME_LENGTH = 8;

/** The first line of a statement, for a one-line row. */
export function firstLine(code: string): string {
  return code.trim().split('\n')[0] ?? '';
}

/** Local date and time of a run, without seconds, for the row. */
export function formatRunTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Local time of day, as HH:MM:SS. */
export function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('en-GB').slice(0, TIME_LENGTH);
}

/** A count with its noun, singular for one: "1 document", "2 documents". */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
