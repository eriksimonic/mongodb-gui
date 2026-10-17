// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { ConnectionManager } from './ConnectionManager';

function renderManager() {
  return renderWithApp(<ConnectionManager />, {
    mock: { preset: 'unlocked' },
    initialState: { managerOpen: true },
  });
}

async function connectionOptions() {
  return screen.findAllByRole('option');
}

describe('ConnectionManager', () => {
  it('lists the saved connections and shows the details of the first one', async () => {
    renderManager();
    const options = await connectionOptions();
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Connection string')).toBeInTheDocument();
    expect(screen.getByText(/saved, stored encrypted/)).toBeInTheDocument();
  });

  it('shows the details of the row that is clicked', async () => {
    renderManager();
    const options = await connectionOptions();
    fireEvent.click(options[1] as HTMLElement);
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('filters the list by the search text', async () => {
    renderManager();
    await connectionOptions();
    fireEvent.change(screen.getByLabelText('Search connections'), {
      target: { value: 'zzz-no-match' },
    });
    expect(await screen.findByText('No connection matches the search.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Search connections'), { target: { value: '' } });
    expect((await connectionOptions()).length).toBeGreaterThan(0);
  });

  it('duplicates the picked connection under a new name', async () => {
    const { api } = renderManager();
    const create = vi.spyOn(api.rpc.connections, 'create');
    await connectionOptions();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].name).toMatch(/ copy$/);
  });

  it('shows when the connection last connected', async () => {
    renderManager();
    await connectionOptions();
    expect(screen.getByText('Last connected')).toBeInTheDocument();
  });
});
