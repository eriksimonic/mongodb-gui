// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function renderWith(api: UiApi) {
  const view = renderApp({ api });
  unmounts.push(view.unmount);
  return view;
}

describe('DeviceUnlockScreen', () => {
  it('opens a device-mode vault without asking for a password', async () => {
    const api = createMockUiApi({ preset: 'device-locked' });
    renderWith(api);

    await waitFor(async () => {
      expect((await api.rpc.vault.status()).state).toBe('unlocked');
    });
    expect(screen.queryByLabelText('Master password')).not.toBeInTheDocument();
  });

  it('shows the recovery screen when the key cannot be read', async () => {
    renderWith(createMockUiApi({ preset: 'device-locked', deviceUnlock: 'fail' }));

    expect(
      await screen.findByRole('heading', { name: 'The vault cannot be opened on this computer' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset store' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('shows the password unlock screen for a password-mode vault', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    await api.rpc.vault.lock();
    renderWith(api);

    expect(await screen.findByLabelText('Master password')).toBeInTheDocument();
  });
});
