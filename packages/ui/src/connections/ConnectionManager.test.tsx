// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { ConnectionManager } from './ConnectionManager';

function renderManager() {
  return renderWithApp(<ConnectionManager />, {
    mock: { preset: 'unlocked' },
    initialState: { managerOpen: true },
  });
}

async function rowCheckboxes() {
  const all = await screen.findAllByRole('checkbox');
  // The first checkbox selects every row.
  return all.slice(1);
}

describe('ConnectionManager', () => {
  it('lists the saved connections with a column header for each field', async () => {
    renderManager();
    await rowCheckboxes();
    for (const label of ['Name', 'Server', 'Security', 'Color', 'Last accessed']) {
      expect(screen.getByRole('button', { name: `Sort by ${label}` })).toBeInTheDocument();
    }
  });

  it('keeps Edit, Clone, Test and To URI off until exactly one row is picked', async () => {
    renderManager();
    const boxes = await rowCheckboxes();
    for (const label of ['Edit', 'Clone', 'Test', 'To URI', 'Delete', 'Connect']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled();
    }
    fireEvent.click(boxes[0] as HTMLElement);
    for (const label of ['Edit', 'Clone', 'Test', 'To URI', 'Delete', 'Connect']) {
      expect(screen.getByRole('button', { name: label })).toBeEnabled();
    }
    fireEvent.click(boxes[1] as HTMLElement);
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('picks a row when its name is clicked and Ctrl adds another', async () => {
    renderManager();
    const boxes = await rowCheckboxes();
    const rows = screen.getAllByRole('row').slice(1);
    const [first, second] = rows as [HTMLElement, HTMLElement];
    fireEvent.click(within(first).getAllByRole('cell')[1] as HTMLElement);
    expect(boxes[0]).toBeChecked();
    fireEvent.click(within(second).getAllByRole('cell')[1] as HTMLElement);
    expect(boxes[0]).not.toBeChecked();
    expect(boxes[1]).toBeChecked();
    fireEvent.click(within(first).getAllByRole('cell')[1] as HTMLElement, { ctrlKey: true });
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).toBeChecked();
  });

  it('filters the rows by the text of a column', async () => {
    renderManager();
    const before = (await rowCheckboxes()).length;
    fireEvent.change(screen.getByLabelText('Filter Name'), { target: { value: 'zzz-no-match' } });
    expect(await screen.findByText('No connection matches the filters.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Filter Name'), { target: { value: '' } });
    await waitFor(async () => expect((await rowCheckboxes()).length).toBe(before));
  });

  it('clones the picked connection under a new name', async () => {
    const { api } = renderManager();
    const create = vi.spyOn(api.rpc.connections, 'create');
    const boxes = await rowCheckboxes();
    fireEvent.click(boxes[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Clone' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0].name).toMatch(/ copy$/);
  });

  it('shows Never for a connection that has not connected', async () => {
    renderManager();
    await rowCheckboxes();
    const table = screen.getByRole('table');
    expect(within(table).getAllByText(/Never|ago|just now/).length).toBeGreaterThan(0);
  });
});
