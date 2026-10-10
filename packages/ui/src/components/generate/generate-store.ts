import { create } from 'zustand';

/** The collection the generate-data dialog writes into. */
export interface GenerateTarget {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
}

interface GenerateDialogState {
  readonly target: GenerateTarget | undefined;
  open(target: GenerateTarget): void;
  close(): void;
}

/** Which collection the generate-data dialog is open for. Menus open it, and the dialog closes it. */
export const useGenerateDialog = create<GenerateDialogState>()((set) => ({
  target: undefined,
  open: (target) => {
    set({ target });
  },
  close: () => {
    set({ target: undefined });
  },
}));
