// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { renderWithApp } from '../../test-support/render';
import { ConnectionTree } from './ConnectionTree';

describe('ConnectionTree', () => {
  it('loads databases when a connection is expanded', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Local dev' }));

    expect(await screen.findByText('shop')).toBeInTheDocument();
    expect(screen.getByText('analytics')).toBeInTheDocument();
    expect(screen.getByText('logs')).toBeInTheDocument();
  });

  it('shows collections when a database is expanded', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Local dev' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Expand shop' }));

    expect(await screen.findByText('orders')).toBeInTheDocument();
    expect(screen.getByText('paid_orders')).toBeInTheDocument();
    expect(screen.getByText('sensor_readings')).toBeInTheDocument();
  });

  it('shows the connection error when a connection fails to open', async () => {
    renderWithApp(<ConnectionTree />, { mock: { preset: 'unlocked' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Expand Staging' }));

    expect(await screen.findByText('Authentication failed')).toBeInTheDocument();
  });

  it('shows a hint when there are no connections', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    for (const connection of await api.rpc.connections.list()) {
      await api.rpc.connections.remove({ id: connection.id });
    }
    renderWithApp(<ConnectionTree />, { api });
    expect(await screen.findByText('No connections yet.')).toBeInTheDocument();
  });
});
