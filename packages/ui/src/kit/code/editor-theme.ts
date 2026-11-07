import type * as Monaco from 'monaco-editor/editor/editor.api';

/** The name of the dark theme of the query editors. */
export const EDITOR_THEME_DARK = 'mongo-gui-dark';
/** The name of the light theme of the query editors. */
export const EDITOR_THEME_LIGHT = 'mongo-gui-light';

export type EditorThemeName = typeof EDITOR_THEME_DARK | typeof EDITOR_THEME_LIGHT;

/** The theme that matches the app's color scheme. */
export function themeFor(scheme: 'light' | 'dark'): EditorThemeName {
  return scheme === 'dark' ? EDITOR_THEME_DARK : EDITOR_THEME_LIGHT;
}

/**
 * The colors of the tokens that the mongosh and T-SQL tokenizers emit. A plain identifier has no
 * rule, so it keeps the default foreground and the colored names stand out from it.
 *
 * - `property`: a field name, a quoted key, or a column.
 * - `type`: a table or a collection, and a shell global such as ObjectId.
 * - `function`: a method or function name.
 * - `predefined`: an operator such as `$gt`, or a built-in SQL function.
 * - `keyword`: a keyword, `true`, `false` and `null`. A SQL data type is `keyword.type`.
 */
interface TokenColors {
  readonly property: string;
  readonly type: string;
  readonly function: string;
  readonly predefined: string;
  readonly keyword: string;
  readonly string: string;
  readonly number: string;
  readonly comment: string;
}

/** The dark token colours are listed in docs/design-language.md#editor-colours. */
const DARK_COLORS: TokenColors = {
  property: 'D0D0CD',
  type: 'AB79ED',
  function: 'A9C7FB',
  predefined: 'FC559B',
  keyword: '7BACF9',
  string: 'FCD15A',
  number: 'F98D58',
  comment: '9FA1A2',
};

const LIGHT_COLORS: TokenColors = {
  property: '001080',
  type: '267F99',
  function: '795E26',
  predefined: 'AF00DB',
  keyword: '0000FF',
  string: 'A31515',
  number: '098658',
  comment: '008000',
};

function rulesOf(colors: TokenColors): Monaco.editor.ITokenThemeRule[] {
  return [
    { token: 'property', foreground: colors.property },
    { token: 'type', foreground: colors.type },
    { token: 'function', foreground: colors.function },
    { token: 'predefined', foreground: colors.predefined },
    { token: 'keyword', foreground: colors.keyword },
    { token: 'string', foreground: colors.string },
    { token: 'number', foreground: colors.number },
    { token: 'comment', foreground: colors.comment, fontStyle: 'italic' },
  ];
}

/**
 * The look of a popup: the Mantine Menu dropdown, which Popover and Combobox share. The values copy
 * the tokens of `theme/tokens.css` and the Mantine item colors. Monaco colors take hex only, so a CSS
 * variable cannot go here, and a test cannot read the CSS file (vitest stubs `?raw` CSS imports).
 */
interface PopupColors {
  /** `--mg-surface-2`. */
  readonly surface: string;
  /** `--mg-border-strong`, the outline and the divider. */
  readonly border: string;
  /** The item text. `--mg-text-strong` in dark, and the theme's `black` in light. */
  readonly text: string;
  /** The hovered item. Dark is Mantine's `dark[4]`, which equals `--mg-border`. Light is Mantine's `gray[1]`. */
  readonly hover: string;
  /** The `--mg-shadow-popup` color at its alpha. */
  readonly shadow: string;
}

const DARK_POPUP: PopupColors = {
  surface: '#2b2d30',
  border: '#4e5157',
  text: '#f2f3f5',
  hover: '#393b40',
  shadow: '#00000099',
};

const LIGHT_POPUP: PopupColors = {
  surface: '#fffefc',
  border: '#d0ccc3',
  text: '#1e1f22',
  hover: '#f1f3f5',
  shadow: '#00000038',
};

/** The Monaco colors of the popups: the context menu, the suggest list, hovers and parameter hints. */
function popupColors(popup: PopupColors): Monaco.editor.IColors {
  return {
    'menu.background': popup.surface,
    'menu.foreground': popup.text,
    'menu.border': popup.border,
    'menu.selectionBackground': popup.hover,
    'menu.selectionForeground': popup.text,
    'menu.separatorBackground': popup.border,
    'list.hoverBackground': popup.hover,
    'editorWidget.background': popup.surface,
    'editorWidget.border': popup.border,
    'editorSuggestWidget.background': popup.surface,
    'editorSuggestWidget.border': popup.border,
    'editorSuggestWidget.foreground': popup.text,
    'editorSuggestWidget.selectedBackground': popup.hover,
    'editorSuggestWidget.selectedForeground': popup.text,
    'editorHoverWidget.background': popup.surface,
    'editorHoverWidget.border': popup.border,
    'editorHoverWidget.foreground': popup.text,
    'widget.shadow': popup.shadow,
  };
}

/** Editor surfaces of the dark theme, listed in docs/design-language.md#editor-colours. */
const DARK_EDITOR_COLORS: Monaco.editor.IColors = {
  'editor.background': '#18191b',
  'editor.foreground': '#f2f3f5',
  'editor.lineHighlightBackground': '#25272a',
  'editor.lineHighlightBorder': '#00000000',
  'editor.selectionBackground': '#2e436e',
  'editor.inactiveSelectionBackground': '#2b2d30',
  'editorCursor.foreground': '#f4b223',
  'editorLineNumber.foreground': '#7a7e85',
  'editorLineNumber.activeForeground': '#dfe1e5',
  'editorIndentGuide.background1': '#2b2d30',
  'scrollbarSlider.background': '#393b4099',
  'scrollbarSlider.hoverBackground': '#34363b',
  ...popupColors(DARK_POPUP),
};

const LIGHT_EDITOR_COLORS: Monaco.editor.IColors = popupColors(LIGHT_POPUP);

/** The token rules of one theme. Exported so tests can read the colors without a Monaco. */
export function themeRules(name: EditorThemeName): readonly Monaco.editor.ITokenThemeRule[] {
  return rulesOf(name === EDITOR_THEME_DARK ? DARK_COLORS : LIGHT_COLORS);
}

const defined = new WeakSet<object>();

/**
 * Registers the two editor themes on a Monaco instance, once. Both extend a stock theme, so every
 * token without a rule here looks as it did before. Call it before the editor takes the theme,
 * which is in the `beforeMount` of the editor component.
 */
export function defineEditorThemes(monaco: typeof Monaco): void {
  if (defined.has(monaco)) {
    return;
  }
  defined.add(monaco);
  // Monaco measures the glyphs once. A measure taken before the bundled font loads puts the cursor
  // and the selection off the characters. The browser loads a font face only when text uses it,
  // so `fonts.ready` can resolve before JetBrains Mono starts loading. Load the faces the editors
  // use, then measure again.
  // Tests run without a document, and jsdom has no font loading.
  const fonts =
    typeof document === 'undefined' ? undefined : (document.fonts as FontFaceSet | undefined);
  if (fonts) {
    const faces = ['400', '600', 'italic 400'].map((face) => `${face} 13px "JetBrains Mono"`);
    void Promise.all(faces.map((face) => fonts.load(face)))
      .then(() => monaco.editor.remeasureFonts())
      .catch(() => undefined);
  }
  monaco.editor.defineTheme(EDITOR_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: rulesOf(DARK_COLORS),
    colors: DARK_EDITOR_COLORS,
  });
  monaco.editor.defineTheme(EDITOR_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: rulesOf(LIGHT_COLORS),
    colors: LIGHT_EDITOR_COLORS,
  });
}
