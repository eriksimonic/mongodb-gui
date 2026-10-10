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
 */
interface TokenColors {
  readonly property: string;
  readonly type: string;
  readonly function: string;
  readonly predefined: string;
}

const DARK_COLORS: TokenColors = {
  property: '9CDCFE',
  type: '4EC9B0',
  function: 'DCDCAA',
  predefined: 'C586C0',
};

const LIGHT_COLORS: TokenColors = {
  property: '001080',
  type: '267F99',
  function: '795E26',
  predefined: 'AF00DB',
};

function rulesOf(colors: TokenColors): Monaco.editor.ITokenThemeRule[] {
  return [
    { token: 'property', foreground: colors.property },
    { token: 'type', foreground: colors.type },
    { token: 'function', foreground: colors.function },
    { token: 'predefined', foreground: colors.predefined },
  ];
}

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
  monaco.editor.defineTheme(EDITOR_THEME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: rulesOf(DARK_COLORS),
    colors: {},
  });
  monaco.editor.defineTheme(EDITOR_THEME_LIGHT, {
    base: 'vs',
    inherit: true,
    rules: rulesOf(LIGHT_COLORS),
    colors: {},
  });
}
