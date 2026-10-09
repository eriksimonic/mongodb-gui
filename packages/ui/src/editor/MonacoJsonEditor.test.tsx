// @vitest-environment jsdom
import { defaultSettings } from '@mongo-gui/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { MonacoJsonEditor } from './MonacoJsonEditor';

// The options the editor received on its last render. Monaco itself needs a real layout engine.
const monaco = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined }));

vi.mock('@monaco-editor/react', () => ({
  default: (props: { readonly options: Record<string, unknown> }) => {
    monaco.options = props.options;
    return null;
  },
}));
vi.mock('./monaco-setup', () => ({}));

beforeEach(() => {
  monaco.options = undefined;
});

describe('MonacoJsonEditor', () => {
  it('passes the saved editor font size to Monaco', () => {
    renderWithApp(<MonacoJsonEditor value="{}" label="Document" />, {
      initialState: { settings: { ...defaultSettings, editorFontSize: 20 } },
    });

    expect(monaco.options?.['fontSize']).toBe(20);
  });

  it('falls back to the default font size before the settings load', () => {
    renderWithApp(<MonacoJsonEditor value="{}" label="Document" />, {
      initialState: { settings: undefined },
    });

    expect(monaco.options?.['fontSize']).toBe(13);
  });
});
