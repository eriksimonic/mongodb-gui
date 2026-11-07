import { z } from 'zod';

/**
 * What a connection reaches: the server addresses and, for a replica set, its name. The main
 * process reads it with serverIdentity() and sends it to the UI in the backup server info.
 */
export const ServerIdentitySchema = z.object({
  hosts: z.array(z.string().max(300)).max(100),
  setName: z.string().max(255).optional(),
});

export type ServerIdentity = z.infer<typeof ServerIdentitySchema>;

/**
 * True when both connections reach the same servers: the same hosts and replica set name. The
 * profile id is not used, because two profiles can point at one cluster. An empty host list means
 * the server was not identified, so it never matches, not even another empty list.
 */
export function sameServer(a: ServerIdentity, b: ServerIdentity): boolean {
  if (a.hosts.length === 0 || b.hosts.length === 0) {
    return false;
  }
  return hostKey(a.hosts) === hostKey(b.hosts) && (a.setName ?? '') === (b.setName ?? '');
}

function hostKey(hosts: readonly string[]): string {
  return [...new Set(hosts.map((host) => host.toLowerCase()))].sort().join(',');
}
