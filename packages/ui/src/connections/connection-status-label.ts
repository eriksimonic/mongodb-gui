import type { ConnectionStatus } from '@mongo-gui/core';

type Connected = Extract<ConnectionStatus, { state: 'connected' }>;

const TOPOLOGY_LABELS: Readonly<Record<Connected['topology'], string>> = {
  standalone: 'standalone server',
  replicaSet: 'replica set',
  sharded: 'sharded cluster',
  loadBalanced: 'load balanced',
  unknown: 'unknown topology',
};

/**
 * What a connected status says about the server: the topology, the set name when there is one,
 * and whether the client is pinned to one member. A direct connection to a replica set member
 * reads and writes that member only, so it is worth a word in the UI.
 */
export function connectionTopologyLabel(status: Connected): string {
  const parts = [TOPOLOGY_LABELS[status.topology]];
  if (status.setName !== undefined) {
    parts.push(status.setName);
  }
  if (status.directConnection === true) {
    parts.push(
      status.topology === 'replicaSet' ? 'direct connection to one member' : 'direct connection',
    );
  }
  return parts.join(' · ');
}

/**
 * The short text shown next to a connected connection in the tree. Empty for a plain standalone
 * server, because the status icon says enough there.
 */
export function connectionTreeMeta(status: ConnectionStatus): string | undefined {
  if (status.state !== 'connected') {
    return undefined;
  }
  const parts: string[] = [];
  if (status.setName !== undefined) {
    parts.push(status.setName);
  } else if (status.topology === 'sharded') {
    parts.push('sharded');
  }
  if (status.directConnection === true) {
    parts.push('direct');
  }
  return parts.length === 0 ? undefined : parts.join(' · ');
}
