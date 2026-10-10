// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { connectedMockApi } from '../api/connected-mock';
import { localConnectionId } from '../api/mock-fixtures';
import { renderWithApp } from '../test-support/render';
import { DiagnosticsPanel } from './DiagnosticsPanel';

const REPORTER_SESSION = '1f9c2a4e8b7d4c1a9e3f0a6b2d5c8e71';

function openTab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

describe('DiagnosticsPanel', () => {
  it('filters the log by text and reports the count of lines shown', async () => {
    const api = await connectedMockApi();
    renderWithApp(<DiagnosticsPanel connectionId={localConnectionId} />, { api });
    await screen.findByText(/Showing \d+ of \d+ lines/);

    fireEvent.change(screen.getByLabelText('Search log'), { target: { value: 'duplicate key' } });

    const summary = await screen.findByText(/Showing \d+ of 320 lines/);
    const shown = Number(/Showing (\d+)/.exec(summary.textContent ?? '')?.[1]);
    expect(shown).toBeGreaterThan(0);
    // One row per shown line, plus the header row.
    expect(screen.getAllByRole('row')).toHaveLength(shown + 1);
    expect(screen.getAllByText('Command failed')).toHaveLength(shown);
    expect(screen.queryByText('Connection accepted')).not.toBeInTheDocument();
  });

  it('shows the empty message when no line matches the filter', async () => {
    const api = await connectedMockApi();
    renderWithApp(<DiagnosticsPanel connectionId={localConnectionId} />, { api });
    await screen.findByText(/Showing \d+ of \d+ lines/);

    fireEvent.change(screen.getByLabelText('Search log'), {
      target: { value: 'no such text anywhere' },
    });

    expect(await screen.findByText('No log lines match the filter.')).toBeInTheDocument();
  });

  it('shows the startup warnings in their own tab', async () => {
    const api = await connectedMockApi();
    renderWithApp(<DiagnosticsPanel connectionId={localConnectionId} />, { api });
    openTab('Startup warnings');

    expect(await screen.findByText(/vm\.max_map_count is too low/)).toBeInTheDocument();
  });

  it('searches the parameters by name and by value', async () => {
    const api = await connectedMockApi();
    renderWithApp(<DiagnosticsPanel connectionId={localConnectionId} />, { api });
    openTab('Parameters');
    const search = await screen.findByLabelText('Search parameters');
    await screen.findByText('logLevel');

    fireEvent.change(search, { target: { value: 'logLevel' } });
    expect(await screen.findByText('Showing 1 of 20 parameters')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'SCRAM-SHA-256' } });
    expect(await screen.findByText('authenticationMechanisms')).toBeInTheDocument();
    expect(screen.queryByText('logLevel')).not.toBeInTheDocument();
  });

  it('keeps only the branches that match a server status path', async () => {
    const api = await connectedMockApi();
    renderWithApp(<DiagnosticsPanel connectionId={localConnectionId} />, { api });
    openTab('Server status');
    await screen.findByText('wiredTiger');

    fireEvent.change(screen.getByLabelText('Search paths'), { target: { value: 'maximum bytes' } });

    expect(await screen.findByText('maximum bytes configured')).toBeInTheDocument();
    expect(screen.getByText('cache')).toBeInTheDocument();
    expect(screen.queryByText('connections')).not.toBeInTheDocument();
  });

  it('kills the ticked sessions after a confirmation that lists the ids', async () => {
    const api = await connectedMockApi();
    renderWithApp(<DiagnosticsPanel connectionId={localConnectionId} />, { api });
    openTab('Sessions');
    const row = (await screen.findByText(REPORTER_SESSION)).closest('tr') as HTMLElement;

    fireEvent.click(within(row).getByLabelText(`Select session ${REPORTER_SESSION}`));
    fireEvent.click(screen.getByRole('button', { name: 'Kill selected (1)' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Kill 1 session')).toBeInTheDocument();
    expect(within(dialog).getByText(REPORTER_SESSION)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Kill sessions' }));

    await waitFor(() => expect(screen.queryByText(REPORTER_SESSION)).not.toBeInTheDocument());
  });

  it('kills every session of a user only after the user name is typed', async () => {
    const api = await connectedMockApi();
    renderWithApp(<DiagnosticsPanel connectionId={localConnectionId} />, { api });
    openTab('Sessions');
    const row = (await screen.findByText('8c3d1f6a0e9b4d2c8a7f5e1b3d6c0a92')).closest(
      'tr',
    ) as HTMLElement;

    fireEvent.click(within(row).getByRole('button', { name: 'Kill all of user' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Kill all sessions' });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Type siteAdmin to confirm'), {
      target: { value: 'siteAdmin' },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(screen.queryByText('8c3d1f6a0e9b4d2c8a7f5e1b3d6c0a92')).not.toBeInTheDocument(),
    );
    expect(screen.getByText(REPORTER_SESSION)).toBeInTheDocument();
  });
});
