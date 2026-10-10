import { hostListEnd, MONGO_SCHEME, splitQuery } from '../connections/direct-uri';
import type { ConnectionProfile } from '../domain/connection';
import type { ReadPreferenceMode } from './options';

export type ToolsUriProfile = Pick<
  ConnectionProfile,
  'uri' | 'tls' | 'readPreference' | 'connectTimeoutMs'
>;

export interface ToolsUriOverrides {
  readonly readPreference?: ReadPreferenceMode | undefined;
}

// Query options a sidecar may record. Everything else can hold a secret or a local path.
const SAFE_OPTIONS: ReadonlySet<string> = new Set(
  [
    'replicaSet',
    'authSource',
    'authMechanism',
    'tls',
    'ssl',
    'directConnection',
    'readPreference',
    'loadBalanced',
    'retryWrites',
    'w',
    'appName',
    'compressors',
  ].map((key) => key.toLowerCase()),
);

// Each TLS setting with the older names the drivers accept for it.
const TLS_KEYS = {
  tls: ['tls', 'ssl'],
  tlsCAFile: ['tlsCAFile', 'sslCA'],
  tlsCertificateKeyFile: ['tlsCertificateKeyFile', 'sslPEMKeyFile'],
  // tlsInsecure may not be combined with the narrower switches it implies.
  tlsInsecure: [
    'tlsInsecure',
    'tlsAllowInvalidCertificates',
    'tlsAllowInvalidHostnames',
    'sslAllowInvalidCertificates',
    'sslAllowInvalidHostnames',
  ],
} as const;

const DEFAULT_PORT = 27017;

interface ParsedUri {
  readonly scheme: string;
  readonly srv: boolean;
  // Includes the trailing '@', or ''.
  readonly userInfo: string;
  readonly hosts: string;
  // Decoded, without the leading '/'. '' when the URI names no database.
  readonly database: string;
  readonly options: readonly string[];
}

/**
 * The URI the Database Tools connect with. The profile's TLS settings, read preference and
 * connect timeout are folded into the query, so the tools need no connection flags. A database
 * in the path becomes `authSource` and the path is removed, because mongodump refuses `--db`
 * together with a database in the URI. The result holds credentials and goes only into the
 * tools config file.
 */
export function toolsUri(profile: ToolsUriProfile, overrides: ToolsUriOverrides = {}): string {
  const parsed = parseUri(profile.uri);
  let options = [...parsed.options];
  if (parsed.database !== '' && !hasOption(options, 'authSource')) {
    options.push(`authSource=${encodeURIComponent(parsed.database)}`);
  }
  const readPreference = overrides.readPreference ?? profile.readPreference;
  if (readPreference !== undefined) {
    options = setOption(options, ['readPreference'], 'readPreference', readPreference);
  }
  const tls = profile.tls;
  if (tls !== undefined) {
    // Same as the driver connection: the profile's switch wins over the URI's.
    options = setOption(options, TLS_KEYS.tls, 'tls', String(tls.enabled));
    if (tls.enabled) {
      if (tls.caFile !== undefined && tls.caFile !== '') {
        options = setOption(options, TLS_KEYS.tlsCAFile, 'tlsCAFile', tls.caFile);
      }
      if (tls.certFile !== undefined && tls.certFile !== '') {
        options = setOption(
          options,
          TLS_KEYS.tlsCertificateKeyFile,
          'tlsCertificateKeyFile',
          tls.certFile,
        );
      }
      if (tls.allowInvalidCertificates === true) {
        options = setOption(options, TLS_KEYS.tlsInsecure, 'tlsInsecure', 'true');
      }
    }
  }
  if (profile.connectTimeoutMs !== undefined && !hasOption(options, 'connectTimeoutMS')) {
    options.push(`connectTimeoutMS=${profile.connectTimeoutMs}`);
  }
  return formatUri(parsed.scheme, parsed.userInfo, parsed.hosts, '', options);
}

/**
 * The URI for a backup description: no user info, and only the allow-listed query options.
 * `authMechanismProperties` (an AWS session token), key passwords and file paths are dropped.
 */
export function uriWithoutCredentials(uri: string): string {
  const parsed = parseUri(uri);
  const options = parsed.options.filter((option) => SAFE_OPTIONS.has(optionKey(option)));
  return formatUri(parsed.scheme, '', parsed.hosts, parsed.database, options);
}

/** The hosts a URI names as `host:port`, or the SRV name for a `mongodb+srv://` URI. */
export function uriHosts(uri: string): string[] {
  const parsed = parseUri(uri);
  if (parsed.srv) {
    return [parsed.hosts];
  }
  return parsed.hosts
    .split(',')
    .filter((host) => host !== '')
    .map(withPort);
}

function parseUri(uri: string): ParsedUri {
  const scheme = MONGO_SCHEME.exec(uri);
  if (scheme === null || scheme[1] === undefined) {
    throw new Error('Not a MongoDB URI');
  }
  const rest = uri.slice(scheme[0].length).trim();
  const end = hostListEnd(rest);
  const at = rest.lastIndexOf('@', end);
  const [pathPart, query] = splitQuery(rest.slice(end));
  return {
    scheme: scheme[1].toLowerCase(),
    srv: scheme[1].toLowerCase().startsWith('mongodb+srv'),
    userInfo: at === -1 ? '' : rest.slice(0, at + 1),
    hosts: rest.slice(at + 1, end),
    database: safeDecode(pathPart.replace(/^\//, '')),
    options: query.split('&').filter((option) => option !== ''),
  };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function formatUri(
  scheme: string,
  userInfo: string,
  hosts: string,
  database: string,
  options: readonly string[],
): string {
  const path = `/${database === '' ? '' : encodeURIComponent(database)}`;
  const query = options.length === 0 ? '' : `?${options.join('&')}`;
  return `${scheme}${userInfo}${hosts}${path}${query}`;
}

function optionKey(option: string): string {
  return (option.split('=')[0] ?? '').toLowerCase();
}

function hasOption(options: readonly string[], key: string): boolean {
  const wanted = key.toLowerCase();
  return options.some((option) => optionKey(option) === wanted);
}

/** Removes every option named in `replaces` (ignoring case) and appends `key=value`. */
function setOption(
  options: readonly string[],
  replaces: readonly string[],
  key: string,
  value: string,
): string[] {
  const names = new Set(replaces.map((name) => name.toLowerCase()));
  return [
    ...options.filter((option) => !names.has(optionKey(option))),
    `${key}=${encodeURIComponent(value)}`,
  ];
}

function withPort(host: string): string {
  // An IPv6 literal is bracketed, so its port follows the closing bracket.
  const portStart = host.startsWith('[') ? host.indexOf(']') + 1 : 0;
  return host.includes(':', portStart) ? host : `${host}:${DEFAULT_PORT}`;
}
