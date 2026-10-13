import { create } from 'zustand';

/** The container whose connect call said the server needs a user name and password. */
export interface DockerCredentialsRequest {
  readonly containerId: string;
  readonly containerName: string;
  readonly hint: 'envFound' | 'noEnv';
}

export interface DockerCredentialsState {
  /** Undefined when no dialog is open. */
  readonly request: DockerCredentialsRequest | undefined;
  open(request: DockerCredentialsRequest): void;
  close(): void;
}

/** Holds the request that opens the Docker credentials dialog. The dialog reads it from here. */
export const useDockerCredentialsStore = create<DockerCredentialsState>()((set) => ({
  request: undefined,
  open(request) {
    set({ request });
  },
  close() {
    set({ request: undefined });
  },
}));
