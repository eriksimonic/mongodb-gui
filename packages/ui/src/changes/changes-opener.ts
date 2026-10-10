import { createContext, useContext } from 'react';
import type { ChangeTarget } from '@mongo-gui/core';

/** Opens the change stream panel of a deployment, database or collection. The shell provides it. */
export interface ChangesOpener {
  open(connectionId: string, target: ChangeTarget): void;
}

export const ChangesOpenerContext = createContext<ChangesOpener | undefined>(undefined);

export function useChangesOpener(): ChangesOpener | undefined {
  return useContext(ChangesOpenerContext);
}
