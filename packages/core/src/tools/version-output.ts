export type ToolsVersionOutput = { version: string; gitVersion?: string; goVersion?: string };

const VERSION = /^mongo(?:dump|restore) version:\s*(\d{1,4}\.\d{1,4}\.\d{1,4})\s*$/m;
const GIT = /^git version:\s*(\S+)\s*$/m;
const GO = /^Go version:\s*(\S+)\s*$/m;

// Reads the output of `mongodump --version`. Undefined when it is not a tools banner.
export function parseToolsVersionOutput(stdout: string): ToolsVersionOutput | undefined {
  const version = VERSION.exec(stdout)?.[1];
  if (!version) return undefined;
  const gitVersion = GIT.exec(stdout)?.[1];
  const goVersion = GO.exec(stdout)?.[1];
  return {
    version,
    ...(gitVersion ? { gitVersion } : {}),
    ...(goVersion ? { goVersion } : {}),
  };
}
