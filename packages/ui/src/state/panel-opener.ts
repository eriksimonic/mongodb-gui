import { createContext, useContext } from 'react';

/** Panels a connection can open in the centre group. */
export type ConnectionPanelKind = 'monitor' | 'operations' | 'replication' | 'sharding';

export interface ConnectionPanelRequest {
  readonly kind: ConnectionPanelKind;
  readonly connectionId: string;
  readonly connectionName: string;
}

/** The users and roles panel of one database. The admin database is the one connection-level entry. */
export interface UsersPanelRequest {
  readonly kind: 'users';
  readonly connectionId: string;
  readonly database: string;
}

/** The server diagnostics panel of a connection. */
export interface DiagnosticsPanelRequest {
  readonly kind: 'diagnostics';
  readonly connectionId: string;
  readonly connectionName: string;
}

/** The storage statistics panel of one database. */
export interface DatabaseStatsRequest {
  readonly kind: 'databaseStats';
  readonly connectionId: string;
  readonly database: string;
}

/** The storage statistics panel of one collection. */
export interface CollectionStatsRequest {
  readonly kind: 'collectionStats';
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
}

export type PanelRequest =
  | ConnectionPanelRequest
  | UsersPanelRequest
  | DiagnosticsPanelRequest
  | DatabaseStatsRequest
  | CollectionStatsRequest;

export type OpenPanel = (request: PanelRequest) => void;

/** Set by the shell. Outside the shell, opening a panel does nothing. */
export const PanelOpenerContext = createContext<OpenPanel>(() => undefined);

export function usePanelOpener(): OpenPanel {
  return useContext(PanelOpenerContext);
}
