import { createContext, useContext } from 'react';

/** Opens the profiler panel of a database. The shell provides it, next to the dockview layout. */
export interface ProfilerOpener {
  open(connectionId: string, database: string): void;
}

export const ProfilerOpenerContext = createContext<ProfilerOpener | undefined>(undefined);

export function useProfilerOpener(): ProfilerOpener | undefined {
  return useContext(ProfilerOpenerContext);
}
