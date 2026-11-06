import { create } from 'zustand';

/** What the copy dialog was opened for. A database request lists its collections on open. */
export type CopyDialogRequest =
  | {
      readonly variant: 'one';
      readonly connectionId: string;
      readonly database: string;
      readonly collection: string;
    }
  | { readonly variant: 'database'; readonly connectionId: string; readonly database: string };

interface CopyDialogsState {
  readonly request: CopyDialogRequest | undefined;
  /** The job whose progress view is open. A new start replaces it. */
  readonly jobId: string | undefined;
  open(request: CopyDialogRequest): void;
  close(): void;
  showJob(jobId: string): void;
  closeJob(): void;
}

/** Which copy dialog and which progress view are open. Menus open the dialog, and the shell shows it. */
export const useCopyDialogs = create<CopyDialogsState>()((set) => ({
  request: undefined,
  jobId: undefined,
  open: (request) => {
    set({ request });
  },
  // Clears the request only. The dialog calls this right after `showJob`, and the job view stays.
  close: () => {
    set({ request: undefined });
  },
  showJob: (jobId) => {
    set({ jobId });
  },
  closeJob: () => {
    set({ jobId: undefined });
  },
}));
