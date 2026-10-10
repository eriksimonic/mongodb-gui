// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../../test-support/render';
import { ChangePasswordModal } from './ChangePasswordModal';

const CURRENT = 'correct horse battery';
const NEXT = 'staple battery horse';

function renderModal(onChanged = vi.fn(), onClose = vi.fn()) {
  const result = renderWithApp(
    <ChangePasswordModal opened onClose={onClose} onChanged={onChanged} />,
    { mock: { preset: 'unlocked' } },
  );
  return { ...result, onChanged, onClose };
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('ChangePasswordModal', () => {
  it('shows the validation errors after the first submit, not before', async () => {
    renderModal();
    expect(screen.queryByText('Enter the current master password.')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Enter the current master password.')).toBeInTheDocument();
    expect(screen.getByText('Use at least 10 characters.')).toBeInTheDocument();
  });

  it('reports a confirmation that does not match', async () => {
    const { api } = renderModal();
    const change = vi.spyOn(api.rpc.vault, 'changePassword');
    fill('Current master password', CURRENT);
    fill('New master password', NEXT);
    fill('Confirm new master password', 'staple battery horsx');

    fireEvent.click(await screen.findByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
  });

  it('shows the strength of the new password', async () => {
    renderModal();
    fill('New master password', 'Staple-battery-1');
    expect(await screen.findByText(/Strength: Strong/)).toBeInTheDocument();
  });

  it('changes the password, then reports it and closes', async () => {
    const { api, onChanged, onClose } = renderModal();
    const change = vi.spyOn(api.rpc.vault, 'changePassword');
    fill('Current master password', CURRENT);
    fill('New master password', NEXT);
    fill('Confirm new master password', NEXT);

    fireEvent.click(await screen.findByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(change).toHaveBeenCalledWith({ current: CURRENT, next: NEXT });
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the server reason when the current password is wrong', async () => {
    const { onChanged } = renderModal();
    fill('Current master password', 'not the password');
    fill('New master password', NEXT);
    fill('Confirm new master password', NEXT);

    fireEvent.click(await screen.findByRole('button', { name: 'Change password' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/.+/)).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
