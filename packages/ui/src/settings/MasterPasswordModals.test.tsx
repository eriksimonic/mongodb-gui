// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-support/render';
import { RemovePasswordModal } from './RemovePasswordModal';
import { SetPasswordModal } from './SetPasswordModal';

const CURRENT = 'correct horse battery';
const NEXT = 'staple battery horse';

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function renderSet(onDone = vi.fn(), onClose = vi.fn()) {
  const result = renderWithApp(<SetPasswordModal opened onClose={onClose} onDone={onDone} />, {
    mock: { preset: 'device' },
  });
  return { ...result, onDone, onClose };
}

function renderRemove(
  mock: { preset: 'unlocked' | 'device'; deviceKey?: 'basic-text' } = { preset: 'unlocked' },
  onDone = vi.fn(),
  onClose = vi.fn(),
) {
  const result = renderWithApp(<RemovePasswordModal opened onClose={onClose} onDone={onDone} />, {
    mock,
  });
  return { ...result, onDone, onClose };
}

describe('SetPasswordModal', () => {
  it('shows the errors for a short password and a mismatched confirmation', async () => {
    const { api, onDone } = renderSet();
    const set = vi.spyOn(api.rpc.vault, 'setPassword');
    fill('New master password', 'abc');
    fill('Confirm new password', 'abd');

    fireEvent.click(await screen.findByRole('button', { name: 'Set password' }));
    expect(await screen.findByText('Use at least 4 characters.')).toBeInTheDocument();
    expect(screen.getByText('The passwords do not match.')).toBeInTheDocument();
    expect(set).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('sets the password, reports it and switches the vault to password mode', async () => {
    const { api, onDone, onClose } = renderSet();
    fill('New master password', NEXT);
    fill('Confirm new password', NEXT);

    fireEvent.click(await screen.findByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalled();
    expect(await api.rpc.vault.status()).toMatchObject({ mode: 'password' });
  });
});

describe('RemovePasswordModal', () => {
  it('keeps the remove button disabled until the checkbox is ticked', async () => {
    renderRemove();
    fill('Current master password', CURRENT);

    const button = await screen.findByRole('button', { name: 'Remove password' });
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(
      screen.getByLabelText('I understand that this data cannot be moved or recovered.'),
    );
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('shows the server reason for a wrong master password', async () => {
    const { onDone } = renderRemove();
    fill('Current master password', 'not the password');
    fireEvent.click(
      screen.getByLabelText('I understand that this data cannot be moved or recovered.'),
    );
    const button = await screen.findByRole('button', { name: 'Remove password' });
    await waitFor(() => expect(button).toBeEnabled());

    fireEvent.click(button);
    expect(await screen.findByText('Wrong master password')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('removes the password, reports it and switches the vault to device mode', async () => {
    const { api, onDone, onClose } = renderRemove();
    fill('Current master password', CURRENT);
    fireEvent.click(
      screen.getByLabelText('I understand that this data cannot be moved or recovered.'),
    );
    const button = await screen.findByRole('button', { name: 'Remove password' });
    await waitFor(() => expect(button).toBeEnabled());

    fireEvent.click(button);
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalled();
    expect(await api.rpc.vault.status()).toMatchObject({ mode: 'device' });
  });

  it('shows the keyring notice and disables the remove button without a device key', async () => {
    renderRemove({ preset: 'unlocked', deviceKey: 'basic-text' });
    expect(await screen.findByText(/No keyring is running/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How to set up a keyring' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();

    fill('Current master password', CURRENT);
    fireEvent.click(
      screen.getByLabelText('I understand that this data cannot be moved or recovered.'),
    );
    expect(screen.getByRole('button', { name: 'Remove password' })).toBeDisabled();
  });
});
