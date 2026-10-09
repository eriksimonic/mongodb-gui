// Optional driver and mongosh dependencies. Each one loads only when a feature needs it. The
// shell runtime keeps them external, and the main build replaces any that are not installed with
// an empty stand-in, so the app starts without them.
export const OPTIONAL_MODULES: readonly string[] = [
  'kerberos',
  'snappy',
  '@mongodb-js/zstd',
  'mongodb-client-encryption',
  '@aws-sdk/credential-providers',
  'gcp-metadata',
  'socks',
  'os-dns-native',
  'system-ca',
  // ssh2 loads this native addon inside a try block for its CPU feature check. Bundling it fails.
  'cpu-features',
];

export function isOptionalModule(id: string): boolean {
  return OPTIONAL_MODULES.some((name) => id === name || id.startsWith(`${name}/`));
}
