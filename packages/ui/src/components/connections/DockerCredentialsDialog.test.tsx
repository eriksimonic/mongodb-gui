// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithApp } from '../../test-support/render';
import { ConnectionTree } from './ConnectionTree';
import { DockerCredentialsDialog } from './DockerCredentialsDialog';
import { useDockerCredentialsStore } from './docker-credentials-store';

function renderTreeWithDialog() {
  return renderWithApp(
    <>
      <ConnectionTree />
      <DockerCredentialsDialog />
    </>,
    { mock: { preset: 'unlocked' } },
  );
}

afterEach(() => {
  useDockerCredentialsStore.setState({ request: undefined });
});

describe('DockerCredentialsDialog', () => {
  it('opens when the secure container asks for credentials', async () => {
    renderTreeWithDialog();
    fireEvent.click(await screen.findByRole('treeitem', { name: 'secure-mongo' }));

    const dialog = await screen.findByRole('dialog', { name: 'Connect to secure-mongo' });
    expect(within(dialog).getByLabelText('Username')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Password')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Authentication database')).toHaveValue('admin');
    expect(
      within(dialog).getByText('The database that holds the user, usually admin'),
    ).toBeInTheDocument();
  });

  it('shows the error for a wrong password and keeps the dialog open', async () => {
    renderTreeWithDialog();
    fireEvent.click(await screen.findByRole('treeitem', { name: 'secure-mongo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect to secure-mongo' });

    fireEvent.change(within(dialog).getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));

    expect(await within(dialog).findByText(/Authentication failed/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Connect to secure-mongo' })).toBeInTheDocument();
  });

  it('connects with admin and admin, closes, and shows the container as connected', async () => {
    renderTreeWithDialog();
    fireEvent.click(await screen.findByRole('treeitem', { name: 'secure-mongo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect to secure-mongo' });

    fireEvent.change(within(dialog).getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'admin' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Connect to secure-mongo' })).toBeNull(),
    );
    await waitFor(() => expect(screen.getAllByLabelText('Connected')).toHaveLength(2));
    expect(screen.getByRole('treeitem', { name: 'secure-mongo' })).toHaveAttribute(
      'aria-level',
      '2',
    );
  });
});
