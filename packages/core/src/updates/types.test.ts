import { describe, expect, it } from 'vitest';
import { rpcContract } from '../rpc/contract';
import { UpdateStateSchema } from './types';

const idle = { phase: 'idle', current: '0.1.0', canInstall: true };

describe('UpdateStateSchema', () => {
  it('accepts an idle state with a check time', () => {
    expect(
      UpdateStateSchema.safeParse({ ...idle, lastCheckedAt: '2026-10-09T12:00:00.000Z' }).success,
    ).toBe(true);
  });

  it('accepts an available update with its release page', () => {
    const state = {
      ...idle,
      phase: 'available',
      available: {
        version: '0.2.0',
        downloadUrl: 'https://github.com/eriksimonic/mongodb-gui/releases/tag/v0.2.0',
      },
    };
    expect(UpdateStateSchema.safeParse(state).success).toBe(true);
  });

  it('rejects an unknown phase', () => {
    expect(UpdateStateSchema.safeParse({ ...idle, phase: 'installing' }).success).toBe(false);
  });

  it('rejects an available update without a download link', () => {
    const state = { ...idle, phase: 'available', available: { version: '0.2.0' } };
    expect(UpdateStateSchema.safeParse(state).success).toBe(false);
  });

  it('rejects progress above 100 percent', () => {
    const state = { ...idle, phase: 'downloading', progress: { percent: 101 } };
    expect(UpdateStateSchema.safeParse(state).success).toBe(false);
  });
});

describe('app.openExternal input', () => {
  const { input } = rpcContract.app.openExternal;

  it('accepts a link under the project release pages', () => {
    expect(
      input.safeParse({
        url: 'https://github.com/eriksimonic/mongodb-gui/releases/tag/v0.2.0',
      }).success,
    ).toBe(true);
  });

  it('rejects a link outside the project and a link with a parent segment', () => {
    expect(input.safeParse({ url: 'https://github.com/eriksimonic/other' }).success).toBe(false);
    expect(
      input.safeParse({ url: 'https://github.com/eriksimonic/mongodb-gui/../other' }).success,
    ).toBe(false);
  });
});
