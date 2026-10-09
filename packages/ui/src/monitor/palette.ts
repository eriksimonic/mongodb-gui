// Dark-mode values from the dataviz reference palette. The categorical slots pass the validator
// on the card surface below. Series take slots in order and never cycle past the eighth.
export const CHART_COLORS = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const;

// Mantine dark-7. Cards and the dockview group share this surface.
export const CHART_SURFACE = '#242424';

export const CHART_INK = {
  primary: '#ffffff',
  secondary: '#c3c2b7',
  muted: '#898781',
  gridline: '#2c2c2a',
  baseline: '#383835',
} as const;

export function seriesColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length] ?? CHART_COLORS[0];
}
