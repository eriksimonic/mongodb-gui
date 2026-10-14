import '@fontsource-variable/inter';
import '@fontsource-variable/manrope';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/400-italic.css';
import '@fontsource/jetbrains-mono/600.css';
import { createTheme, type MantineColorsTuple } from '@mantine/core';

/** Code, editors and code-like values. The font files ship with the app. */
export const CODE_FONT = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
/** Labels, buttons, menus and other UI text. */
export const UI_FONT = '"Manrope Variable", system-ui, "Segoe UI", sans-serif';
/** Data tables, where Inter keeps digits and narrow columns readable. */
export const TABLE_FONT = '"Inter Variable", system-ui, "Segoe UI", sans-serif';

/*
 * Colour ladders from docs/color-palette.md. Shade 6 is the solid colour, which filled controls
 * use, and shade 4 is the light shade, which Mantine uses for coloured text in the dark scheme.
 */
const brand: MantineColorsTuple = [
  '#f6ecca',
  '#f8e5a7',
  '#fadd83',
  '#fad96b',
  '#fcd453',
  '#feca24',
  '#ffc300',
  '#ffd60a',
  '#e0ad02',
  '#a68207',
];
const yellow: MantineColorsTuple = [
  '#f6ebcc',
  '#f8e3aa',
  '#fadb88',
  '#fad671',
  '#fcd15a',
  '#fec62d',
  '#ffbe0b',
  '#fdc938',
  '#cc9a0d',
  '#a67e0e',
];
const orange: MantineColorsTuple = [
  '#f6dbcb',
  '#f7c4a9',
  '#f8ac86',
  '#f89d6f',
  '#f98d58',
  '#fa6e2a',
  '#fb5607',
  '#fa7535',
  '#c9460a',
  '#a33b0c',
];
const red: MantineColorsTuple = [
  '#f6cfdb',
  '#f8aac8',
  '#fa86b4',
  '#fa6da8',
  '#fc559b',
  '#fe2481',
  '#ff006e',
  '#fd3188',
  '#cc025c',
  '#a6034e',
];
const violet: MantineColorsTuple = [
  '#e4d7ee',
  '#d3bbed',
  '#c29fed',
  '#b68ced',
  '#ab79ed',
  '#9454ec',
  '#8338ec',
  '#9a5dec',
  '#692ec1',
  '#5527a0',
];
const blue: MantineColorsTuple = [
  '#d9e3f1',
  '#bdd2f3',
  '#a1c2f6',
  '#8eb7f7',
  '#7bacf9',
  '#5696fc',
  '#3a86ff',
  '#5f9cfc',
  '#2e6dd0',
  '#265aad',
];
/**
 * The dark scheme reads these by index: 0 text, 2 dimmed, 3 placeholder and disabled text,
 * 4 borders, 5 default hover, 6 inputs and default buttons, 7 the page, 8 the segmented control
 * track.
 */
const dark: MantineColorsTuple = [
  '#f5f3ee',
  '#d0d0cd',
  '#9fa1a2',
  '#6e7276',
  '#34343a',
  '#3a3a40',
  '#2a2a2f',
  '#0f0f11',
  '#18181b',
  '#0a0a0c',
];

/** Popups sit one surface step above the page. */
const popup = { dropdown: { background: 'var(--mg-surface-2)' } };

/** Shared by both colour schemes. Compact controls and spacing so the tree and dialogs fit a small window. */
export const appTheme = createTheme({
  colors: { brand, yellow, orange, red, violet, blue, dark },
  primaryColor: 'brand',
  primaryShade: 6,
  autoContrast: true,
  // Mantine's default of 0.3 puts white text on the pink, orange and blue solids, where dark text
  // reads better. At 0.2 only violet keeps white text.
  luminanceThreshold: 0.2,
  black: '#0f0f11',
  defaultRadius: 'sm',
  radius: { sm: '4px', md: '6px' },
  fontFamily: UI_FONT,
  fontFamilyMonospace: CODE_FONT,
  headings: { fontFamily: UI_FONT, fontWeight: '600' },
  spacing: { xs: '4px', sm: '6px', md: '10px', lg: '14px', xl: '20px' },
  components: {
    ActionIcon: { defaultProps: { size: 'sm', variant: 'subtle' } },
    Button: { defaultProps: { size: 'xs' } },
    Checkbox: { defaultProps: { size: 'xs' } },
    ColorInput: { defaultProps: { size: 'xs' } },
    NumberInput: { defaultProps: { size: 'xs' } },
    PasswordInput: { defaultProps: { size: 'xs' } },
    Select: { defaultProps: { size: 'xs' } },
    SegmentedControl: { defaultProps: { size: 'xs' } },
    Switch: { defaultProps: { size: 'xs' } },
    TextInput: { defaultProps: { size: 'xs' } },
    Textarea: { defaultProps: { size: 'xs' } },
    Fieldset: { defaultProps: { radius: 'sm' } },
    Menu: { styles: popup },
    Popover: { styles: popup },
    Combobox: { styles: popup },
    // A sticky header paints the page colour by default, which is near black inside a dialog.
    Table: {
      styles: { table: { fontFamily: TABLE_FONT }, th: { background: 'var(--mg-surface-3)' } },
    },
    Modal: {
      defaultProps: { radius: 'md', overlayProps: { backgroundOpacity: 0.7, color: '#0f0f11' } },
      styles: {
        content: { background: 'var(--mg-surface-2)' },
        header: { background: 'var(--mg-surface-2)' },
      },
    },
  },
});
