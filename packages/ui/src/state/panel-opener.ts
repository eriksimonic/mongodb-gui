import { createContext, useContext } from 'react';

/** Panels a connection can open in the centre group. */
export type PanelKind = 'monitor' | 'operations';

export interface PanelRequest {
  readonly kind: PanelKind;
  readonly connectionId: string;
  readonly connectionName: string;
}

export type OpenPanel = (request: PanelRequest) => void;

/** Set by the shell. Outside the shell, opening a panel does nothing. */
export const PanelOpenerContext = createContext<OpenPanel>(() => undefined);

export function usePanelOpener(): OpenPanel {
  return useContext(PanelOpenerContext);
}
