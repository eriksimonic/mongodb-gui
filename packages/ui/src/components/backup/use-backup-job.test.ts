// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { BackupProgress, BackupStartInput, RpcEvent } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { createMockUiApi } from '../../api/mock-rpc-client';
import { UiApiProvider, type UiApi } from '../../api/ui-api';
import { accumulateProgress, MAX_LOG_LINES, useBackupJob } from './use-backup-job';

const jobId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';

function progress(patch: Partial<BackupProgress>): BackupProgress {
  return {
    phase: 'running',
    documents: 0,
    bytes: 0,
    active: [],
    finishedNamespaces: 0,
    failedDocuments: 0,
    lines: [],
    warnings: [],
    elapsedMs: 0,
    done: false,
    cancelled: false,
    ...patch,
  };
}

function event(patch: Partial<BackupProgress>): RpcEvent {
  return { type: 'backup:progress', connectionId, jobId, kind: 'dump', progress: progress(patch) };
}

/** A mock api whose start call returns a fixed job id after the test has pushed events. */
function fakeApi(listeners: Set<(event: RpcEvent) => void>, beforeReturn: () => void): UiApi {
  const mock = createMockUiApi({ preset: 'unlocked' });
  return {
    rpc: {
      ...mock.rpc,
      backup: {
        ...mock.rpc.backup,
        start: () => {
          beforeReturn();
          return Promise.resolve({ jobId });
        },
      },
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const input = {} as BackupStartInput;

describe('accumulateProgress', () => {
  it('keeps only the last lines', () => {
    const lines = Array.from({ length: MAX_LOG_LINES }, (_, index) => `old ${String(index)}`);
    const first = accumulateProgress(undefined, progress({ lines }));
    const next = accumulateProgress(first, progress({ lines: ['new'], warnings: ['careful'] }));

    expect(next.lines).toHaveLength(MAX_LOG_LINES);
    expect(next.lines.at(-1)).toBe('new');
    expect(next.lines[0]).toBe('old 1');
    expect(next.warnings).toEqual(['careful']);
  });
});

describe('useBackupJob', () => {
  it('keeps events that arrive before the start call returns', async () => {
    const listeners = new Set<(event: RpcEvent) => void>();
    const api = fakeApi(listeners, () => {
      for (const listener of listeners) {
        listener(event({ lines: ['first'] }));
        listener(event({ lines: ['last'], done: true, phase: 'finished' }));
      }
    });
    const { result } = renderHook(() => useBackupJob(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(UiApiProvider, { api, children }),
    });

    await act(async () => {
      await result.current.start('dump', input);
    });

    await waitFor(() => {
      expect(result.current.view?.progress.done).toBe(true);
    });
    expect(result.current.view?.lines).toEqual(['first', 'last']);
    expect(result.current.running).toBe(false);
  });

  it('follows events that arrive after the start call returns', async () => {
    const listeners = new Set<(event: RpcEvent) => void>();
    const api = fakeApi(listeners, () => undefined);
    const { result } = renderHook(() => useBackupJob(), {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(UiApiProvider, { api, children }),
    });
    await act(async () => {
      await result.current.start('dump', input);
    });
    expect(result.current.running).toBe(true);

    act(() => {
      for (const listener of listeners) {
        listener(event({ documents: 5, lines: ['a'] }));
      }
    });

    expect(result.current.view?.progress.documents).toBe(5);
    expect(result.current.view?.lines).toEqual(['a']);
  });
});
