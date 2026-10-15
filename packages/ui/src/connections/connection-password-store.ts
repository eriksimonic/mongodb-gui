import { create } from 'zustand';

/** The saved connection whose server rejected its credentials. */
export interface ConnectionPasswordRequest {
  readonly connectionId: string;
  readonly connectionName: string;
  /** The user name in the saved URI. Empty when the URI has none. */
  readonly username: string;
}

export interface ConnectionPasswordState {
  /** Undefined when no dialog is open. */
  readonly request: ConnectionPasswordRequest | undefined;
  open(request: ConnectionPasswordRequest): void;
  close(): void;
}

/** Holds the request that opens the connection password dialog. The dialog reads it from here. */
export const useConnectionPasswordStore = create<ConnectionPasswordState>()((set) => ({
  request: undefined,
  open(request) {
    set({ request });
  },
  close() {
    set({ request: undefined });
  },
}));
