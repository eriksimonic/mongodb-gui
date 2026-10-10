export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

// Reads "8.0.17", "9.0" or "8.0.0-rc1-ent". The patch defaults to 0 and suffixes are ignored.
export function parseVersion(version: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

// Negative, zero or positive like a sort comparator. A version that does not parse sorts first.
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return (left ? 1 : 0) - (right ? 1 : 0);
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

// "8.0.17" gives "8.0". Undefined when the version does not parse.
export function majorMinor(version: string): string | undefined {
  const parsed = parseVersion(version);
  return parsed ? `${parsed.major}.${parsed.minor}` : undefined;
}

// The first tools release that supports each server major.minor, oldest first.
export const TOOLS_SERVER_SUPPORT: readonly { server: string; tools: string }[] = [
  { server: '4.4', tools: '100.1.0' },
  { server: '5.0', tools: '100.4.0' },
  { server: '6.0', tools: '100.5.0' },
  { server: '7.0', tools: '100.8.0' },
  { server: '8.0', tools: '100.10.0' },
  { server: '8.1', tools: '100.12.0' },
  { server: '8.2', tools: '100.13.0' },
  { server: '8.3', tools: '100.16.0' },
  { server: '9.0', tools: '100.18.0' },
];

export interface ToolsSupport {
  tools: string;
  // The server is newer than the last row, so no release is known to support it yet.
  beyondTable: boolean;
}

// The first tools version for a server, from the newest row at or below its major.minor.
// Undefined for a server older than the first row or a version that does not parse.
export function firstToolsFor(serverVersion: string): ToolsSupport | undefined {
  const server = majorMinor(serverVersion);
  if (!server) return undefined;
  let found: { server: string; tools: string } | undefined;
  for (const row of TOOLS_SERVER_SUPPORT) {
    if (compareVersions(row.server, server) <= 0) found = row;
  }
  if (!found) return undefined;
  const beyondTable =
    found === TOOLS_SERVER_SUPPORT.at(-1) && compareVersions(server, found.server) > 0;
  return { tools: found.tools, beyondTable };
}
