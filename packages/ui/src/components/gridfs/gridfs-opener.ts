import { createContext, useContext } from 'react';

/** Opens or closes the file panel of a bucket. The shell provides it, next to the dockview layout. */
export interface GridFsOpener {
  open(connectionId: string, database: string, bucket: string): void;
  /** Closes the panel of a bucket that was dropped. */
  close(connectionId: string, database: string, bucket: string): void;
}

export const GridFsOpenerContext = createContext<GridFsOpener | undefined>(undefined);

export function useGridFsOpener(): GridFsOpener | undefined {
  return useContext(GridFsOpenerContext);
}
