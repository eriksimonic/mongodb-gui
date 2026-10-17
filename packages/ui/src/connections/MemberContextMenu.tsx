import { copyText } from '../kit/copy';
import { useAppStore } from '../state/app-store-context';
import { usePanelOpener } from '../state/panel-opener';
import { runReported } from '../kit/notify-error';
import { TreeMenu, type TreeMenuEntry } from '../kit/TreeMenu';

export interface MemberContextMenuProps {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly host: string;
  /** True when the parent connection already talks to this member only. */
  readonly isSelfDirect: boolean;
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

/**
 * Menu of a replica set member row. "Connect directly" saves a profile that connects to this
 * member only, with the credentials of the parent connection, and opens it.
 */
export function MemberContextMenu({
  connectionId,
  connectionName,
  host,
  isSelfDirect,
  position,
  onClose,
}: MemberContextMenuProps) {
  const connectDirectly = useAppStore((state) => state.connectDirectly);
  const openPanel = usePanelOpener();
  const entries: TreeMenuEntry[] = [
    {
      kind: 'item',
      label: 'Connect directly',
      disabled: isSelfDirect,
      reason: isSelfDirect ? 'already direct' : undefined,
      onSelect: () => void runReported(() => connectDirectly(connectionId, host)),
    },
    {
      kind: 'item',
      label: 'Copy host',
      onSelect: () => void copyText(host, 'Host copied'),
    },
    { kind: 'divider' },
    {
      kind: 'item',
      label: 'Replica set panel',
      onSelect: () => openPanel({ kind: 'replication', connectionId, connectionName }),
    },
  ];
  return <TreeMenu entries={entries} position={position} onClose={onClose} />;
}

export interface ReplicaSetContextMenuProps {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

/** Menu of the replica set node. It opens the panel, like a click on the node. */
export function ReplicaSetContextMenu({
  connectionId,
  connectionName,
  position,
  onClose,
}: ReplicaSetContextMenuProps) {
  const openPanel = usePanelOpener();
  const entries: TreeMenuEntry[] = [
    {
      kind: 'item',
      label: 'Open replica set panel',
      onSelect: () => openPanel({ kind: 'replication', connectionId, connectionName }),
    },
  ];
  return <TreeMenu entries={entries} position={position} onClose={onClose} />;
}
