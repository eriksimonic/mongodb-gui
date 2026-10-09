import type { TransferKind, TransferProgress, TransferSummary } from '@mongo-gui/core';

/** One import or export this session knows about. Progress arrives in events. */
export interface TransferView {
  readonly transferId: string;
  readonly kind: TransferKind;
  readonly database: string;
  readonly collection: string;
  readonly path: string;
  readonly progress: TransferProgress;
}

export type TransfersState = Readonly<Record<string, TransferView>>;

export type TransferTarget = Omit<TransferView, 'progress'>;

/** Events can arrive before the start call returns, so a progress for an unknown id is kept. */
const UNKNOWN_TARGET = { database: '', collection: '', path: '' } as const;

/** Adds a transfer the UI started. Progress that arrived first is kept. */
export function registerTransfer(
  transfers: TransfersState,
  target: TransferTarget,
): TransfersState {
  const known = transfers[target.transferId];
  const progress = known?.progress ?? emptyProgress();
  return { ...transfers, [target.transferId]: { ...target, progress } };
}

/** Applies a progress event. An event for an unknown transfer creates a view with no target yet. */
export function applyTransferProgress(
  transfers: TransfersState,
  event: {
    readonly transferId: string;
    readonly kind: TransferKind;
    readonly progress: TransferProgress;
  },
): TransfersState {
  const known = transfers[event.transferId];
  const view: TransferView = known ?? {
    transferId: event.transferId,
    kind: event.kind,
    ...UNKNOWN_TARGET,
    progress: event.progress,
  };
  return { ...transfers, [event.transferId]: { ...view, progress: event.progress } };
}

/** Replaces the view with the list the backend holds. Transfers the list omits are dropped. */
export function transfersFromList(list: readonly TransferSummary[]): TransfersState {
  return Object.fromEntries(
    list.map((summary) => [
      summary.transferId,
      {
        transferId: summary.transferId,
        kind: summary.kind,
        database: summary.database,
        collection: summary.collection,
        path: summary.path,
        progress: summary.progress,
      },
    ]),
  );
}

export function isRunning(view: TransferView): boolean {
  return !view.progress.done;
}

/** Running transfers first, then the finished ones, each in the order they started. */
export function listTransfers(transfers: TransfersState): TransferView[] {
  const all = Object.values(transfers);
  return [...all.filter(isRunning), ...all.filter((view) => !isRunning(view))];
}

/** Fraction of the file read, or undefined when the byte total is not known. */
export function transferFraction(progress: TransferProgress): number | undefined {
  const total = progress.bytesTotal;
  if (total === undefined || total === 0 || progress.bytesRead === undefined) {
    return undefined;
  }
  return Math.min(1, progress.bytesRead / total);
}

export function emptyProgress(): TransferProgress {
  return {
    processed: 0,
    inserted: 0,
    updated: 0,
    matched: 0,
    failed: 0,
    elapsedMs: 0,
    done: false,
    errors: [],
    warnings: [],
  };
}
