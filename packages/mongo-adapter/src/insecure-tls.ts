import { AppErrorException, appError, type ConnectionProfile } from '@mongo-gui/core';
import { ConnectionString } from 'mongodb-connection-string-url';

// URI options that turn off certificate checks. Option names are case-insensitive.
const INSECURE_TLS_OPTIONS = new Set([
  'tlsallowinvalidcertificates',
  'tlsallowinvalidhostnames',
  'tlsinsecure',
]);

/**
 * An imported profile never turns off certificate checks. The flag and the URI options that set it
 * are dropped, so the imported copy connects with checks on. A profile the user edits keeps its flag.
 */
export function withoutInsecureTls(profile: ConnectionProfile): ConnectionProfile {
  const uri = withoutInsecureUriOptions(profile.uri, profile.name);
  const tls =
    profile.tls === undefined ? {} : { tls: { ...profile.tls, allowInvalidCertificates: false } };
  return { ...profile, uri, ...tls };
}

/**
 * Drops the insecure TLS options from a URI. The driver's parser reads the URI and decodes the option
 * names, so the names are checked as the driver sees them. A URI the driver cannot parse is refused.
 * The error names the connection only, because the parser's message can repeat the URI.
 */
function withoutInsecureUriOptions(uri: string, name: string): string {
  let parsed: ConnectionString;
  try {
    parsed = new ConnectionString(uri);
  } catch {
    throw new AppErrorException(
      appError('VALIDATION', `The connection "${name}" in the file has a URI MongoDB cannot read.`),
    );
  }
  const insecure = [...parsed.searchParams.keys()].filter((key) =>
    INSECURE_TLS_OPTIONS.has(key.toLowerCase()),
  );
  if (insecure.length === 0) return uri;
  for (const key of insecure) parsed.searchParams.delete(key);
  return parsed.toString();
}
