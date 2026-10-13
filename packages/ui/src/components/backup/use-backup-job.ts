import type {
  BackupJobKind,
  BackupProgress,
  BackupStartInput,
  RestoreStartInput,
} from '@mongo-gui/core';
import { useEffect, useRef, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { errorText } from '../../kit/notify-error';

/** Log lines kept for display. Older lines are dropped. */
export const MAX_LOG_LINES = 500;

/** The latest progress event plus the log and warnings gathered from every event so far. */
export interface BackupJobView {
  readonly progress: BackupProgress;
  readonly lines: readonly string[];
  readonly warnings: readonly string[];
}

/** Folds one event into the view. Each event carries only the lines that are new. */
export function accumulateProgress(
  previous: BackupJobView | undefined,
  progress: BackupProgress,
): BackupJobView {
  const lines = [...(previous?.lines ?? []), ...progress.lines].slice(-MAX_LOG_LINES);
  const warnings = [...(previous?.warnings ?? []), ...progress.warnings];
  return { progress, lines, warnings };
}

export interface BackupJob {
  readonly view: BackupJobView | undefined;
  readonly jobId: string | undefined;
  readonly starting: boolean;
  /** Set when the start or cancel call fails. A job that fails while running reports in the view. */
  readonly problem: string | undefined;
  /** True from the start call until the final event. */
  readonly running: boolean;
  start(kind: 'dump', input: BackupStartInput): Promise<void>;
  start(kind: 'restore', input: RestoreStartInput): Promise<void>;
  cancel(): void;
  /** Forgets a finished job so the form can be shown again. */
  reset(): void;
}

/** Starts a dump or restore job and follows its progress events. */
export function useBackupJob(): BackupJob {
  const { rpc, onEvent } = useUiApi();
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [view, setView] = useState<BackupJobView | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // The job id is known only when the start call returns, and an event can arrive before that.
  // Progress for an id not yet known waits here, so the final event is never lost.
  const jobIdRef = useRef<string | undefined>(undefined);
  const earlyProgress = useRef(new Map<string, BackupProgress[]>());

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type !== 'backup:progress') {
          return;
        }
        if (event.jobId === jobIdRef.current) {
          setView((current) => accumulateProgress(current, event.progress));
        } else {
          const waiting = earlyProgress.current.get(event.jobId) ?? [];
          earlyProgress.current.set(event.jobId, [...waiting, event.progress]);
        }
      }),
    [onEvent],
  );

  async function run(kind: BackupJobKind, input: BackupStartInput | RestoreStartInput) {
    setProblem(undefined);
    setStarting(true);
    try {
      const started =
        kind === 'dump'
          ? await rpc.backup.start(input as BackupStartInput)
          : await rpc.backup.startRestore(input as RestoreStartInput);
      jobIdRef.current = started.jobId;
      const known = earlyProgress.current.get(started.jobId);
      if (known !== undefined) {
        setView((current) => known.reduce(accumulateProgress, current));
        earlyProgress.current.delete(started.jobId);
      }
      setJobId(started.jobId);
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setStarting(false);
    }
  }

  function cancel() {
    if (jobId === undefined) {
      return;
    }
    rpc.backup.cancel({ jobId }).catch((error: unknown) => {
      setProblem(errorText(error));
    });
  }

  function reset() {
    jobIdRef.current = undefined;
    setJobId(undefined);
    setView(undefined);
    setProblem(undefined);
  }

  const running = starting || (jobId !== undefined && view?.progress.done !== true);
  return {
    view,
    jobId,
    starting,
    problem,
    running,
    start: run as BackupJob['start'],
    cancel,
    reset,
  };
}
