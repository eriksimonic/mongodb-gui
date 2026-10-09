// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMockUiApi } from '../api/mock-rpc-client';
import { renderWithApp } from '../test-support/render';
import { UnlockScreen } from './UnlockScreen';

function renderLocked(lockReason: 'idle' | 'manual') {
  return renderWithApp(<UnlockScreen />, {
    api: createMockUiApi({ preset: 'unlocked' }),
    initialState: { vault: 'locked', lockReason, idleLockMinutes: 5 },
  });
}

describe('UnlockScreen lock message', () => {
  it('says the vault locked after the idle timeout', async () => {
    renderLocked('idle');
    expect(await screen.findByText('Locked after 5 minutes without activity')).toBeInTheDocument();
  });

  it('shows no idle message after a manual lock', () => {
    renderLocked('manual');
    expect(screen.queryByText(/without activity/)).toBeNull();
  });
});
