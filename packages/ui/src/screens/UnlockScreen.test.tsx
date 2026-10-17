// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockMasterPassword } from '../api/mock-fixtures';
import { createMockUiApi } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import { renderApp } from '../test-support/render';

// Mantine's modal transition sets timers that outlive the test. Fake timers let afterEach flush
// them while jsdom is still alive, instead of after teardown.
const unmounts: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

function renderUnlockScreen(api: UiApi) {
  const view = renderApp({ api });
  unmounts.push(view.unmount);
  return view;
}

async function lockedApi() {
  const api = createMockUiApi({ preset: 'unlocked' });
  await api.rpc.vault.lock();
  return api;
}

describe('UnlockScreen', () => {
  it('shows an error for a wrong password and stays on the unlock screen', async () => {
    renderUnlockScreen(await lockedApi());
    fireEvent.change(await screen.findByLabelText('Master password'), {
      target: { value: 'not the password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByText('Wrong master password. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Unlock' })).toBeInTheDocument();
  });

  it('reaches the shell with the right password', async () => {
    renderUnlockScreen(await lockedApi());
    fireEvent.change(await screen.findByLabelText('Master password'), {
      target: { value: mockMasterPassword },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(await screen.findByRole('button', { name: 'Lock' })).toBeInTheDocument();
  });

  it('keeps the delete button disabled until DELETE is typed', async () => {
    renderUnlockScreen(await lockedApi());
    fireEvent.click(await screen.findByRole('button', { name: 'Reset store' }));
    const confirm = await screen.findByRole('button', { name: 'Delete store' });
    expect(confirm).toBeDisabled();
    // Let the modal's open transition finish before the test ends.
    await vi.advanceTimersByTimeAsync(500);

    fireEvent.change(screen.getByLabelText('Confirmation'), { target: { value: 'DELETE' } });
    expect(screen.getByRole('button', { name: 'Delete store' })).toBeEnabled();
  });
});
