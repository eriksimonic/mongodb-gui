// Categorical colours by scheme. The dark slots come from docs/color-palette.md, the light slots
// from the dataviz reference palette. The light slots sit below 3:1 on the light surface, so
// charts ship their readouts and table view, which carry the identity too.
// Series take slots in order and never cycle past the eighth.
export type ChartScheme = 'light' | 'dark';

export interface ChartPalette {
  readonly colors: readonly string[];
  /** The card surface the series sit on. Cards and the dockview group share it. */
  readonly surface: string;
  readonly ink: {
    readonly primary: string;
    readonly secondary: string;
    readonly muted: string;
    readonly gridline: string;
    readonly baseline: string;
  };
}

const DARK: ChartPalette = {
  // The status colours of docs/color-palette.md, then three light shades. Violet uses its light
  // shade, because the grid prints type colours as text and solid violet is too dark for that.
  colors: ['#3a86ff', '#ffbe0b', '#ff006e', '#ab79ed', '#fb5607', '#7bacf9', '#fcd15a', '#fc559b'],
  // The page colour. Cards and the dockview group share this surface.
  surface: '#0f0f11',
  ink: {
    primary: '#f5f3ee',
    secondary: '#d0d0cd',
    muted: '#9fa1a2',
    gridline: '#222226',
    baseline: '#34343a',
  },
};

const LIGHT: ChartPalette = {
  colors: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  // The validated light chart surface from the reference palette.
  surface: '#fcfcfb',
  ink: {
    primary: '#0b0b0b',
    secondary: '#52514e',
    muted: '#898781',
    gridline: '#e1e0d9',
    baseline: '#c3c2b7',
  },
};

export function chartPalette(scheme: ChartScheme): ChartPalette {
  return scheme === 'light' ? LIGHT : DARK;
}

export function seriesColor(index: number, scheme: ChartScheme): string {
  const colors = chartPalette(scheme).colors;
  return colors[index % colors.length] ?? colors[0] ?? '#000000';
}
