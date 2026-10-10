// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test-support/render';
import type { MockToolsMode } from '../../api/mock-tools';
import { useMongoTools } from './use-mongo-tools';
import { ToolsVersionSelect } from './ToolsVersionSelect';

function Harness() {
  const { list } = useMongoTools();
  const [value, setValue] = useState<string | null>('100.19.1');
  if (list === undefined) {
    return null;
  }
  return <ToolsVersionSelect installs={list.installs} value={value} onChange={setValue} />;
}

function renderSelect(tools: MockToolsMode = 'ok') {
  return renderWithApp(<Harness />, { mock: { preset: 'unlocked', tools } });
}

describe('ToolsVersionSelect', () => {
  it('labels healthy versions with their source', async () => {
    renderSelect();
    fireEvent.click(await screen.findByRole('textbox', { name: 'Tools version' }));
    expect(await screen.findByRole('option', { name: '100.19.1 (Bundled)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '100.12.1 (Downloaded)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Download another version…' })).toBeInTheDocument();
  });

  it('leaves out a broken install', async () => {
    renderSelect('broken');
    fireEvent.click(await screen.findByRole('textbox', { name: 'Tools version' }));
    await screen.findByRole('option', { name: '100.12.1 (Downloaded)' });
    expect(screen.queryByRole('option', { name: '100.19.1 (Bundled)' })).toBeNull();
  });

  it('selects the version that finishes downloading', async () => {
    renderSelect();
    fireEvent.click(await screen.findByRole('textbox', { name: 'Tools version' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Download another version…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await screen.findByRole('textbox', { name: 'Version' }));
    fireEvent.click(await screen.findByRole('option', { name: '100.15.0' }));
    fireEvent.click(dialog.querySelector('button:not([data-variant])') ?? dialog);
    await waitFor(
      () =>
        expect(screen.getByRole('textbox', { name: 'Tools version' })).toHaveValue(
          '100.15.0 (Downloaded)',
        ),
      { timeout: 4000 },
    );
  });
});
