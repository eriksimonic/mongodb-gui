// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockMasterPassword } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import { renderApp } from '../test-support/render';

async function lockedApi() {
  const api = createMockUiApi({ preset: 'unlocked' });
  await api.rpc.vault.lock();
  return api;
}

describe('UnlockScreen', () => {
  it('shows an error for a wrong password and stays on the unlock screen', async () => {
    renderApp({ api: await lockedApi() });
    fireEvent.change(await screen.findByLabelText('Master password'), {
      target: { value: 'not the password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByText('Wrong master password. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Unlock Mongo GUI' })).toBeInTheDocument();
  });

  it('reaches the shell with the right password', async () => {
    renderApp({ api: await lockedApi() });
    fireEvent.change(await screen.findByLabelText('Master password'), {
      target: { value: mockMasterPassword },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByRole('button', { name: 'Lock' })).toBeInTheDocument();
  });

  it('keeps the delete button disabled until DELETE is typed', async () => {
    renderApp({ api: await lockedApi() });
    fireEvent.click(await screen.findByRole('button', { name: 'Reset store' }));
    const confirm = await screen.findByRole('button', { name: 'Delete store' });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Confirmation'), { target: { value: 'DELETE' } });
    expect(screen.getByRole('button', { name: 'Delete store' })).toBeEnabled();
  });
});
