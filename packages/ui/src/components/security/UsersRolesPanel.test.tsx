// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { connectedMockApi } from '../../api/connected-mock';
import { localConnectionId } from '../../api/mock-fixtures';
import { renderWithApp } from '../../test-support/render';
import { UsersRolesPanel } from './UsersRolesPanel';

const panel = { connectionId: localConnectionId, database: 'shop' };

/** The row of a user or role, found by its first cell's text. */
async function rowOf(text: string): Promise<HTMLElement> {
  const row = (await screen.findByText(text)).closest('tr');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe('UsersRolesPanel', () => {
  it('lists the users with their roles, mechanisms and restrictions', async () => {
    const api = await connectedMockApi();
    renderWithApp(<UsersRolesPanel {...panel} />, { api });

    const row = await rowOf('reporter');
    expect(within(row).getByText('analyst@shop')).toBeInTheDocument();
    expect(within(row).getByText('SCRAM-SHA-1')).toBeInTheDocument();
    expect(within(row).getByText('1 restriction')).toBeInTheDocument();
  });

  it('creates a user with a password and shows it in the list', async () => {
    const api = await connectedMockApi();
    renderWithApp(<UsersRolesPanel {...panel} />, { api });
    await rowOf('reporter');

    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('User name'), { target: { value: 'etl' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create user' }));

    expect(await rowOf('etl')).toBeInTheDocument();
    expect(screen.queryByText('correct horse battery')).not.toBeInTheDocument();
  });

  it('does not create a user while the confirmation differs', async () => {
    const api = await connectedMockApi();
    renderWithApp(<UsersRolesPanel {...panel} />, { api });
    await rowOf('reporter');

    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('User name'), { target: { value: 'etl' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'one' } });
    fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
      target: { value: 'two' },
    });

    expect(within(dialog).getByRole('button', { name: 'Create user' })).toBeDisabled();
    expect(within(dialog).getByText('The passwords do not match')).toBeInTheDocument();
  });

  it('grants a role picked from the list and shows it on the user', async () => {
    const api = await connectedMockApi();
    renderWithApp(<UsersRolesPanel {...panel} />, { api });
    const row = await rowOf('reporter');

    fireEvent.click(within(row).getByRole('button', { name: 'Roles' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('textbox', { name: 'Grant roles' }));
    // The built-in role is listed under each database, so the option is picked from the shop group.
    const shopGroup = await screen.findByRole('group', { name: 'shop' });
    fireEvent.click(within(shopGroup).getByRole('option', { name: 'readWrite (built-in)' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(within(row).getByText('readWrite@shop')).toBeInTheDocument());
  });

  it('drops a user only after its name is typed', async () => {
    const api = await connectedMockApi();
    renderWithApp(<UsersRolesPanel {...panel} />, { api });
    const row = await rowOf('reporter');

    fireEvent.click(within(row).getByRole('button', { name: 'Drop' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Drop user' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Type reporter to confirm'), {
      target: { value: 'reporter' },
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByText('reporter')).not.toBeInTheDocument());
    expect(screen.getByText('No users in shop.')).toBeInTheDocument();
  });

  it('shows the built-in roles read only and offers no drop for them', async () => {
    const api = await connectedMockApi();
    renderWithApp(<UsersRolesPanel {...panel} />, { api });

    fireEvent.click(screen.getByRole('tab', { name: 'Roles' }));
    const custom = await rowOf('analyst');
    expect(within(custom).getByRole('button', { name: 'Drop' })).toBeEnabled();

    const builtin = await rowOf('readWrite');
    expect(within(builtin).getByText('Built-in')).toBeInTheDocument();
    expect(within(builtin).queryByRole('button', { name: 'Drop' })).not.toBeInTheDocument();
    expect(within(builtin).getByRole('button', { name: 'View' })).toBeInTheDocument();
  });

  it('drops a custom role after its name is typed', async () => {
    const api = await connectedMockApi();
    renderWithApp(<UsersRolesPanel {...panel} />, { api });

    fireEvent.click(screen.getByRole('tab', { name: 'Roles' }));
    const row = await rowOf('analyst');
    fireEvent.click(within(row).getByRole('button', { name: 'Drop' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Type analyst to confirm'), {
      target: { value: 'analyst' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Drop role' }));

    await waitFor(() => expect(screen.queryByText('analyst')).not.toBeInTheDocument());
  });
});
