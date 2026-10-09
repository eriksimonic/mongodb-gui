// @vitest-environment jsdom
// The shims come first. uPlot reads matchMedia when its module loads, and App imports uPlot.
import './test-support/browser-shims';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { createMockUiApi } from './api/mock-rpc-client';
import { renderApp } from './test-support/render';

describe('App', () => {
  it('opens on the first-run screen when the store is fresh', async () => {
    renderApp({ mock: { preset: 'fresh' } });
    expect(
      await screen.findByRole('heading', { name: 'Create master password' }),
    ).toBeInTheDocument();
  });

  it('shows the shell when the vault is unlocked', async () => {
    renderApp({ mock: { preset: 'unlocked' } });
    expect(await screen.findByRole('button', { name: 'Lock' })).toBeInTheDocument();
    expect(await screen.findByText('Local dev')).toBeInTheDocument();
  });

  it('returns to the unlock screen when the vault locks', async () => {
    renderApp({ mock: { preset: 'unlocked' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Lock' }));
    expect(await screen.findByRole('heading', { name: 'Unlock Mongo GUI' })).toBeInTheDocument();
  });

  it('shows the unlock screen when the app starts locked', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.vault.lock();
    renderApp({ api });
    expect(await screen.findByRole('heading', { name: 'Unlock Mongo GUI' })).toBeInTheDocument();
  });

  it('is exported as a component taking an api prop', () => {
    expect(typeof App).toBe('function');
  });
});
