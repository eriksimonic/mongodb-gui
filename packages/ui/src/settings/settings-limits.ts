export interface NumericRange {
  readonly min: number;
  readonly max: number;
}

/** Idle lock minutes. The backend accepts up to one day. */
export const IDLE_LOCK_RANGE: NumericRange = { min: 1, max: 24 * 60 };
export const EDITOR_FONT_SIZE_RANGE: NumericRange = { min: 8, max: 32 };
export const HISTORY_LIMIT_RANGE: NumericRange = { min: 100, max: 100_000 };
export const SAMPLE_SIZE_RANGE: NumericRange = { min: 1, max: 10_000 };

/** Rounds a typed number and keeps it inside the range. The low bound wins over an inverted range. */
export function clampToRange(value: number, range: NumericRange): number {
  return Math.max(range.min, Math.min(range.max, Math.round(value)));
}
