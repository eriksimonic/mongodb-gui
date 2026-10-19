/** Which palette colour a segment uses. */
export type SegmentTone = 'data' | 'index' | 'free';

export const TONE_COLOR: Record<SegmentTone, string> = {
  data: 'var(--mg-series-1)',
  index: 'var(--mg-series-5)',
  free: 'var(--mg-text-faint)',
};

/** Index shades differ a little so neighbours stay apart. */
export function fillFor(item: { tone: SegmentTone }, position: number, hover: boolean): string {
  const color = TONE_COLOR[item.tone];
  if (item.tone === 'free') {
    return `repeating-linear-gradient(135deg, color-mix(in srgb, ${color} ${hover ? 34 : 24}%, var(--mg-surface-1)) 0 6px, var(--mg-surface-1) 6px 12px)`;
  }
  const base = item.tone === 'data' ? 34 : 44 - (position % 4) * 7;
  return `color-mix(in srgb, ${color} ${base + (hover ? 12 : 0)}%, var(--mg-surface-1))`;
}

