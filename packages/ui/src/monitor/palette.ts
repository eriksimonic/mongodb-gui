// Categorical colours by scheme, from the dataviz reference palette. Each scheme's slots pass the
// validator on that scheme's chart surface. The light slots sit below 3:1 on the light surface, so
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
  colors: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  // Mantine dark-7. Cards and the dockview group share this surface.
  surface: '#242424',
  ink: {
    primary: '#ffffff',
    secondary: '#c3c2b7',
    muted: '#898781',
    gridline: '#2c2c2a',
    baseline: '#383835',
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
