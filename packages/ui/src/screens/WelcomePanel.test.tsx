// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { describe, expect, it } from 'vitest';
import { createMockUiApi } from '../api/mock-rpc-client';
import { renderWithApp } from '../test-support/render';
import { WelcomePanel } from './ShellPanels';
import { recentConnections } from './welcome-model';

/** The dock props the panel reads. Only containerApi is used, for the Docker action. */
const DOCK_PROPS = {
  containerApi: { getPanel: () => undefined },
} as unknown as IDockviewPanelProps;

describe('WelcomePanel', () => {
  it('offers the four quick actions', async () => {
    renderWithApp(<WelcomePanel {...DOCK_PROPS} />, { mock: { preset: 'unlocked' } });
    for (const name of [
      /New connection/,
      /Docker instances/,
      /Open settings/,
      /Shortcut reference/,
    ]) {
      expect(await screen.findByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('lists recent connections, newest first, at most five', async () => {
    const { api } = renderWithApp(<WelcomePanel {...DOCK_PROPS} />, {
      mock: { preset: 'unlocked' },
    });
    const heading = await screen.findByRole('heading', { name: 'Recent connections' });
    const section = heading.parentElement as HTMLElement;
    const rows = await within(section).findAllByRole('button');

    const expected = recentConnections(await api.rpc.connections.list());
    expect(rows.length).toBe(Math.min(expected.length, 5));
    expect(rows[0]).toHaveTextContent(expected[0]?.name ?? '');
  });

  it('says so when there are no connections', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    for (const connection of await api.rpc.connections.list()) {
      await api.rpc.connections.remove({ id: connection.id });
    }
    renderWithApp(<WelcomePanel {...DOCK_PROPS} />, { api });
    expect(await screen.findByText(/No connections yet/)).toBeInTheDocument();
  });

  it('states the idle lock in the hint line', async () => {
    renderWithApp(<WelcomePanel {...DOCK_PROPS} />, {
      mock: { preset: 'unlocked' },
      initialState: { idleLockMinutes: 45 },
    });
    expect(await screen.findByText(/locks after 45 minutes without activity/)).toBeInTheDocument();
  });
});
