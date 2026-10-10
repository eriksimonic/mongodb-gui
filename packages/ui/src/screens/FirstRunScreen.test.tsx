// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test-support/render';

async function fillPasswords(password: string, confirmation: string) {
  fireEvent.change(await screen.findByLabelText('Master password'), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText('Confirm master password'), {
    target: { value: confirmation },
  });
}

describe('FirstRunScreen', () => {
  it('rejects a password shorter than 4 characters', async () => {
    renderApp({ mock: { preset: 'fresh' } });
    await fillPasswords('abc', 'abc');
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }));

    expect(await screen.findByText('Use at least 4 characters.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create master password' })).toBeInTheDocument();
  });

  it('rejects a confirmation that does not match', async () => {
    renderApp({ mock: { preset: 'fresh' } });
    await fillPasswords('a long enough password', 'a long enough passwor');
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }));

    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();
  });

  it('creates the vault with a valid password and enters the shell', async () => {
    renderApp({ mock: { preset: 'fresh' } });
    await fillPasswords('a long enough password', 'a long enough password');
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }));

    expect(await screen.findByRole('button', { name: 'Lock' })).toBeInTheDocument();
  });

  it('explains that a lost password cannot be recovered', async () => {
    renderApp({ mock: { preset: 'fresh' } });
    expect(
      await screen.findByText(/nobody can recover it for you if you forget it/),
    ).toBeInTheDocument();
  });
});
