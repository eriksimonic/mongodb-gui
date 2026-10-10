import type * as Monaco from 'monaco-editor/editor/editor.api';
import { describe, expect, it, vi } from 'vitest';
import {
  defineEditorThemes,
  EDITOR_THEME_DARK,
  EDITOR_THEME_LIGHT,
  themeFor,
  themeRules,
} from './editor-theme';

type ThemeData = Monaco.editor.IStandaloneThemeData;

/** A Monaco stand-in that records the themes it was given. */
function fakeMonaco() {
  const defineTheme = vi.fn<(name: string, data: ThemeData) => void>();
  const monaco = { editor: { defineTheme } } as unknown as typeof Monaco;
  return { monaco, defineTheme };
}

function foreground(data: ThemeData, token: string): string | undefined {
  return data.rules.find((rule) => rule.token === token)?.foreground;
}

describe('themeFor', () => {
  it('maps the color scheme to a theme name', () => {
    expect(themeFor('dark')).toBe('mongo-gui-dark');
    expect(themeFor('light')).toBe('mongo-gui-light');
  });

  it('names the two themes', () => {
    expect(EDITOR_THEME_DARK).toBe('mongo-gui-dark');
    expect(EDITOR_THEME_LIGHT).toBe('mongo-gui-light');
  });
});

describe('defineEditorThemes', () => {
  it('registers both themes', () => {
    const { monaco, defineTheme } = fakeMonaco();
    defineEditorThemes(monaco);
    expect(defineTheme.mock.calls.map(([name]) => name)).toEqual([
      'mongo-gui-dark',
      'mongo-gui-light',
    ]);
  });

  it('extends the stock themes and inherits their rules', () => {
    const { monaco, defineTheme } = fakeMonaco();
    defineEditorThemes(monaco);
    const dark = defineTheme.mock.calls[0]?.[1];
    const light = defineTheme.mock.calls[1]?.[1];
    expect(dark).toMatchObject({ base: 'vs-dark', inherit: true });
    expect(light).toMatchObject({ base: 'vs', inherit: true });
  });

  it('colors properties, tables, functions and operators in the dark theme', () => {
    const { monaco, defineTheme } = fakeMonaco();
    defineEditorThemes(monaco);
    const dark = defineTheme.mock.calls[0]?.[1] as ThemeData;
    expect(foreground(dark, 'property')).toBe('9CDCFE');
    expect(foreground(dark, 'type')).toBe('4EC9B0');
    expect(foreground(dark, 'function')).toBe('DCDCAA');
    expect(foreground(dark, 'predefined')).toBeDefined();
  });

  it('colors properties, tables, functions and operators in the light theme', () => {
    const { monaco, defineTheme } = fakeMonaco();
    defineEditorThemes(monaco);
    const light = defineTheme.mock.calls[1]?.[1] as ThemeData;
    expect(foreground(light, 'property')).toBe('001080');
    expect(foreground(light, 'type')).toBe('267F99');
    expect(foreground(light, 'function')).toBe('795E26');
    expect(foreground(light, 'predefined')).toBeDefined();
  });

  it('leaves plain identifiers without a rule, so they keep the default foreground', () => {
    const { monaco, defineTheme } = fakeMonaco();
    defineEditorThemes(monaco);
    for (const [, data] of defineTheme.mock.calls) {
      expect(data.rules.map((rule) => rule.token)).not.toContain('identifier');
      expect(data.rules.map((rule) => rule.token)).not.toContain('');
    }
  });

  it('gives the table token and the data type token different rules', () => {
    // Data types are `keyword.type`, which Monaco matches by its first part, `keyword`.
    for (const name of [EDITOR_THEME_DARK, EDITOR_THEME_LIGHT] as const) {
      expect(themeRules(name).map((rule) => rule.token)).not.toContain('keyword.type');
      expect(themeRules(name).map((rule) => rule.token)).toContain('type');
    }
  });

  it('defines the themes once per Monaco instance', () => {
    const { monaco, defineTheme } = fakeMonaco();
    defineEditorThemes(monaco);
    defineEditorThemes(monaco);
    defineEditorThemes(monaco);
    expect(defineTheme).toHaveBeenCalledTimes(2);
  });

  it('defines them again on another Monaco instance', () => {
    const first = fakeMonaco();
    const second = fakeMonaco();
    defineEditorThemes(first.monaco);
    defineEditorThemes(second.monaco);
    expect(first.defineTheme).toHaveBeenCalledTimes(2);
    expect(second.defineTheme).toHaveBeenCalledTimes(2);
  });
});

describe('themeRules', () => {
  it('has a dark and a light color for each token, and they differ', () => {
    const dark = themeRules(EDITOR_THEME_DARK);
    const light = themeRules(EDITOR_THEME_LIGHT);
    expect(dark.map((rule) => rule.token)).toEqual(light.map((rule) => rule.token));
    for (const [index, rule] of dark.entries()) {
      expect(rule.foreground).toMatch(/^[0-9A-F]{6}$/);
      expect(light[index]?.foreground).toMatch(/^[0-9A-F]{6}$/);
      expect(light[index]?.foreground).not.toBe(rule.foreground);
    }
  });
});
