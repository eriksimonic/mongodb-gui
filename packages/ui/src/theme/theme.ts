import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { createTheme, type MantineColorsTuple } from '@mantine/core';

/** Code, editors and code-like values. The font files ship with the app. */
export const CODE_FONT = '"Geist Mono Variable", ui-monospace, Menlo, Consolas, monospace';
/** Labels, buttons, menus and other UI text. */
export const UI_FONT = '"Geist Variable", system-ui, "Segoe UI", sans-serif';
/** Data tables use the UI font, with tabular figures so columns line up. */
export const TABLE_FONT = UI_FONT;

/*
 * Colour ladders from the Graphite design language. Shade 6 is the solid colour, which filled controls
 * use, and shade 4 is the light shade, which Mantine uses for coloured text in the dark scheme.
 */
const brand: MantineColorsTuple = [
  '#fdf3d9',
  '#fbe8b3',
  '#f9dc8c',
  '#f8d06b',
  '#f6be48',
  '#f5b92f',
  '#f4b223',
  '#ffc43d',
  '#c98d0d',
  '#8a5600',
];
const yellow: MantineColorsTuple = [
  '#fdf3d9',
  '#fbe8b3',
  '#f9dc8c',
  '#f8d06b',
  '#f6be48',
  '#f5b92f',
  '#f4b223',
  '#ffc43d',
  '#c98d0d',
  '#8a5600',
];
const orange: MantineColorsTuple = [
  '#fdeadb',
  '#fbd8bd',
  '#f9c49c',
  '#f6ad79',
  '#f49a5c',
  '#f28f48',
  '#f08a3c',
  '#f59a52',
  '#c2570c',
  '#8f3f08',
];
const red: MantineColorsTuple = [
  '#fde3ea',
  '#fbc7d4',
  '#f9a5b8',
  '#f7839e',
  '#f46d8d',
  '#f3628a',
  '#f2597f',
  '#f67092',
  '#d4244e',
  '#a01a3b',
];
const violet: MantineColorsTuple = [
  '#efe9fd',
  '#ded2fb',
  '#cdbcfa',
  '#bda4f9',
  '#b295f9',
  '#ab8cf9',
  '#a98bfa',
  '#b79cfa',
  '#7b54d9',
  '#5b3ba8',
];
const blue: MantineColorsTuple = [
  '#e3eeff',
  '#c8dcff',
  '#abc9ff',
  '#8fb7ff',
  '#7cacff',
  '#70a7ff',
  '#6aa5ff',
  '#80b2ff',
  '#2f6fdb',
  '#2455a8',
];
const green: MantineColorsTuple = [
  '#dff6ea',
  '#bfeed4',
  '#9fe5bd',
  '#7fdca7',
  '#63d199',
  '#55c892',
  '#4cc38a',
  '#62cd98',
  '#1e9e63',
  '#177a4c',
];
const teal: MantineColorsTuple = [
  '#dcf7f3',
  '#b9efe7',
  '#96e6db',
  '#74dccf',
  '#57d3c3',
  '#46cdbb',
  '#3cc9b5',
  '#55d2c1',
  '#12958a',
  '#0d7168',
];
/**
 * The dark scheme reads these by index: 0 text, 2 dimmed, 3 placeholder and disabled text,
 * 4 borders, 5 default hover, 6 inputs and default buttons, 7 the page, 8 the segmented control
 * track.
 */
const dark: MantineColorsTuple = [
  '#f4f2ee',
  '#d3d0cb',
  '#a19d96',
  '#75716a',
  '#2e2c29',
  '#33312e',
  '#2a2927',
  '#1a1917',
  '#201f1c',
  '#100d0a',
];

/** Popups sit one surface step above the page. */
const popup = { dropdown: { background: 'var(--mg-surface-2)' } };

/** Shared by both colour schemes. Compact controls and spacing so the tree and dialogs fit a small window. */
export const appTheme = createTheme({
  colors: { brand, yellow, orange, red, violet, blue, green, teal, dark },
  primaryColor: 'brand',
  primaryShade: 6,
  autoContrast: true,
  // Mantine's default of 0.3 puts white text on the pink, orange and blue solids, where dark text
  // reads better. At 0.2 only violet keeps white text.
  luminanceThreshold: 0.2,
  black: '#1a1917',
  defaultRadius: 'md',
  radius: { xs: '2px', sm: '4px', md: '6px', lg: '10px', xl: '999px' },
  fontFamily: UI_FONT,
  fontFamilyMonospace: CODE_FONT,
  headings: { fontFamily: UI_FONT, fontWeight: '600' },
  spacing: { xs: '4px', sm: '8px', md: '12px', lg: '16px', xl: '24px' },
  components: {
    ActionIcon: { defaultProps: { size: 'sm', variant: 'subtle' } },
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
    InputWrapper: {
      styles: {
        label: { marginBottom: 4, fontSize: 12, color: 'var(--mg-text-muted)', fontWeight: 400 },
        description: { marginBottom: 4 },
        error: { marginTop: 4 },
      },
    },
    Input: {
      styles: {
        input: {
          background: 'var(--mg-surface-2)',
          borderColor: 'var(--mg-border-strong)',
          color: 'var(--mg-text-strong)',
        },
      },
    },
    Button: {
      defaultProps: { size: 'xs' },
      styles: { root: { fontWeight: 500 } },
    },
    Badge: { styles: { root: { fontWeight: 600, letterSpacing: '0.02em' } } },
    Menu: { styles: popup },
    Popover: { styles: popup },
    Combobox: { styles: popup },
    // A sticky header paints the page colour by default, which is near black inside a dialog.
    Table: {
      styles: { table: { fontFamily: TABLE_FONT }, th: { background: 'var(--mg-surface-3)' } },
    },
    Modal: {
      defaultProps: {
        radius: 'lg',
        padding: 'xl',
        overlayProps: { backgroundOpacity: 0.7, color: '#100d0a' },
      },
      styles: {
        content: { background: 'var(--mg-surface-1)', border: '1px solid var(--mg-border-strong)' },
        header: { background: 'var(--mg-surface-1)', paddingBottom: 8 },
        title: { fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' },
      },
    },
  },
});
