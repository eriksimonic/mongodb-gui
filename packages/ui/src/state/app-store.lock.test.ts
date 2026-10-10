// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createMockUiApi } from '../api/mock-rpc-client';
import { createAppStore } from './app-store';

describe('app store lock reason', () => {
  it('marks a lock the user asked for as manual', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const store = createAppStore(api, { vault: 'unlocked' });

    await store.getState().lock();

    expect(store.getState().vault).toBe('locked');
    expect(store.getState().lockReason).toBe('manual');
  });

  it('marks a lock from the idle timer as idle', () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const store = createAppStore(api, { vault: 'unlocked' });

    store.getState().applyEvent({ type: 'vault:locked' });

    expect(store.getState().vault).toBe('locked');
    expect(store.getState().lockReason).toBe('idle');
  });

  it('clears the reason after unlock', async () => {
    const api = createMockUiApi({ preset: 'unlocked' });
    const store = createAppStore(api, { vault: 'unlocked' });
    store.getState().applyEvent({ type: 'vault:locked' });

    await store.getState().unlock('correct horse battery');

    expect(store.getState().vault).toBe('unlocked');
    expect(store.getState().lockReason).toBeUndefined();
  });
});
