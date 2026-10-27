// @vitest-environment jsdom
// The shims come first. uPlot reads matchMedia when its module loads, and the shell imports it.
import '../test-support/browser-shims';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test-support/render';

describe('ShellScreen lock button', () => {
  it('shows the Lock button in password mode', async () => {
    renderApp({ mock: { preset: 'unlocked' } });
    expect(await screen.findByRole('button', { name: 'Lock' })).toBeInTheDocument();
  });

  it('hides the Lock button in device mode', async () => {
    renderApp({ mock: { preset: 'device' } });
    // The connection name shows once the shell has loaded.
    expect((await screen.findAllByText('Local dev')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Lock' })).toBeNull();
  });
});
