// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test-support/render';

async function choosePassword() {
  fireEvent.click(await screen.findByRole('radio', { name: /Password encryption/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

async function fillPasswords(password: string, confirmation: string) {
  fireEvent.change(await screen.findByLabelText('Master password'), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText('Confirm master password'), {
    target: { value: confirmation },
  });
}

describe('FirstRunScreen', () => {
  it('starts with nothing selected and Continue disabled', async () => {
    renderApp({ mock: { preset: 'fresh' } });
    expect(
      await screen.findByRole('heading', { name: 'Choose how to protect your data' }),
    ).toBeInTheDocument();
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).not.toBeChecked();
    }
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('keeps Continue disabled for machine encryption until the checkbox is ticked', async () => {
    renderApp({ mock: { preset: 'fresh' } });
    fireEvent.click(await screen.findByRole('radio', { name: /Machine encryption/ }));
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: /I understand/ }));
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);

    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Choose how to protect your data' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('shows the password form after choosing password encryption', async () => {
    renderApp({ mock: { preset: 'fresh' } });
    await choosePassword();
    expect(
      await screen.findByRole('heading', { name: 'Create master password' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Master password')).toBeInTheDocument();
  });

  it('rejects a password shorter than 4 characters', async () => {
    renderApp({ mock: { preset: 'fresh' } });
    await choosePassword();
    await fillPasswords('abc', 'abc');
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }));

    expect(await screen.findByText('Use at least 4 characters.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Create master password' })).toBeInTheDocument();
  });

  it('rejects a confirmation that does not match', async () => {
    renderApp({ mock: { preset: 'fresh' } });
    await choosePassword();
    await fillPasswords('a long enough password', 'a long enough passwor');
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }));

    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();
  });

  it('creates the vault with a valid password and enters the shell', async () => {
    renderApp({ mock: { preset: 'fresh' } });
    await choosePassword();
    await fillPasswords('a long enough password', 'a long enough password');
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }));

    expect(await screen.findByRole('button', { name: 'Lock' })).toBeInTheDocument();
  });

  it('explains that a lost password cannot be recovered', async () => {
    renderApp({ mock: { preset: 'fresh' } });
    await choosePassword();
    expect(
      await screen.findByText(/nobody can recover it for you if you forget it/),
    ).toBeInTheDocument();
  });

  it('disables machine encryption and shows the reason when the key is unavailable', async () => {
    renderApp({ mock: { preset: 'fresh', deviceKey: 'basic-text' } });
    expect(await screen.findByText(/No keyring is running/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Machine encryption/ })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'How to set up a keyring' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('shows the restart sentence after Check again still finds no key', async () => {
    renderApp({ mock: { preset: 'fresh', deviceKey: 'basic-text' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(/Still not available/)).toBeInTheDocument();
  });
});
