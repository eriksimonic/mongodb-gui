export interface ServerIdentity {
  readonly hosts: readonly string[];
  readonly setName?: string | undefined;
}

/**
 * True when both connections reach the same servers: the same hosts and replica set name. The
 * profile id is not used, because two profiles can point at one cluster.
 */
export function sameServer(a: ServerIdentity, b: ServerIdentity): boolean {
  return hostKey(a.hosts) === hostKey(b.hosts) && (a.setName ?? '') === (b.setName ?? '');
}

function hostKey(hosts: readonly string[]): string {
  return [...new Set(hosts.map((host) => host.toLowerCase()))].sort().join(',');
}
