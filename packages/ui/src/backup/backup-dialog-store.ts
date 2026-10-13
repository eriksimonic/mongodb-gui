import { create } from 'zustand';

/** What the backup or restore dialog was opened for. */
export type BackupDialogRequest =
  | {
      readonly kind: 'backup';
      readonly connectionId: string;
      readonly database?: string;
      readonly collection?: string;
    }
  | { readonly kind: 'restore'; readonly connectionId: string; readonly database?: string };

interface BackupDialogsState {
  readonly request: BackupDialogRequest | undefined;
  open(request: BackupDialogRequest): void;
  close(): void;
}

/** Which backup or restore dialog is open. Menus open it, and the dialog closes it. */
export const useBackupDialogs = create<BackupDialogsState>()((set) => ({
  request: undefined,
  open: (request) => {
    set({ request });
  },
  close: () => {
    set({ request: undefined });
  },
}));
