// Optional driver and mongosh dependencies. Each one loads only when a feature needs it.
//
// The shell runtime keeps them external. The runtime loads them through guarded requires, so a
// missing one only fails the feature that needs it.
//
// The main build maps each of them to a stand-in in scripts/stubs. The driver reads some of them
// while it loads, so a missing module must not stop the app. The stand-in answers the driver's
// kModuleError check, and any use of it throws the driver's own "install X" message.
//
// The message text comes from the driver's source. A test checks that every module has a stub.

export interface OptionalModule {
  readonly name: string;
  // The message the driver throws when the feature is used without the module.
  readonly message: string;
}

export const OPTIONAL_MODULES: readonly OptionalModule[] = [
  {
    name: 'kerberos',
    message:
      'Optional module `kerberos` not found. Please install it to enable kerberos authentication',
  },
  {
    name: 'snappy',
    message: 'Optional module `snappy` not found. Please install it to enable snappy compression',
  },
  {
    name: '@mongodb-js/zstd',
    message:
      'Optional module `@mongodb-js/zstd` not found. Please install it to enable zstd compression',
  },
  {
    name: 'mongodb-client-encryption',
    message:
      'Optional module `mongodb-client-encryption` not found. Please install it to use auto encryption or ClientEncryption.',
  },
  {
    name: '@aws-sdk/credential-providers',
    message:
      'Optional module `@aws-sdk/credential-providers` not found. Please install it to enable getting aws credentials via the official sdk.',
  },
  {
    name: 'gcp-metadata',
    message:
      'Optional module `gcp-metadata` not found. Please install it to enable getting gcp credentials via the official sdk.',
  },
  {
    name: 'socks',
    message:
      'Optional module `socks` not found. Please install it to connections over a SOCKS5 proxy',
  },
  {
    name: 'os-dns-native',
    message: 'Optional module `os-dns-native` not found. Please install it to use OS DNS lookups.',
  },
  {
    name: 'system-ca',
    message: 'Optional module `system-ca` not found. Please install it to use the system CA store.',
  },
  {
    name: 'cpu-features',
    message: 'Optional module `cpu-features` not found. Please install it to check CPU features.',
  },
];

/** Names of the optional modules, for the shell runtime's externals. */
export function optionalModuleNames(): string[] {
  return OPTIONAL_MODULES.map((module) => module.name);
}

/** True for an optional module name or one of its subpaths, such as kerberos/package.json. */
export function isOptionalModule(id: string): boolean {
  return OPTIONAL_MODULES.some((module) => id === module.name || id.startsWith(`${module.name}/`));
}

/** The stand-in file for a module, relative to the app package. */
export function stubFileFor(name: string): string {
  const slug = name.replace(/^@/, '').replace(/[/]/g, '-');
  return `scripts/stubs/${slug}.js`;
}
