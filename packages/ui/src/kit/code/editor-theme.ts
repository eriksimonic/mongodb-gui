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

/** The dark colours come from docs/color-palette.md. */
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

/** Editor surfaces of the dark theme, from docs/color-palette.md. */
const DARK_EDITOR_COLORS: Monaco.editor.IColors = {
  'editor.background': '#100d0a',
  'editor.foreground': '#f4f2ee',
  'editor.lineHighlightBackground': '#201f1c',
  'editor.lineHighlightBorder': '#00000000',
  'editor.selectionBackground': '#3a2f14',
  'editor.inactiveSelectionBackground': '#2a2927',
  'editorCursor.foreground': '#f4b223',
  'editorLineNumber.foreground': '#75716a',
  'editorLineNumber.activeForeground': '#d3d0cb',
  'editorIndentGuide.background1': '#2a2927',
  'editorWidget.background': '#2a2927',
  'editorWidget.border': '#2e2c29',
  'editorSuggestWidget.background': '#2a2927',
  'editorSuggestWidget.border': '#2e2c29',
  'editorSuggestWidget.selectedBackground': '#3a2f14',
  'editorHoverWidget.background': '#2a2927',
  'editorHoverWidget.border': '#2e2c29',
  'scrollbarSlider.background': '#2e2c2999',
  'scrollbarSlider.hoverBackground': '#33312e',
};

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
    colors: {},
  });
}
