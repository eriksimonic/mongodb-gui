import type { ConnectionProfileInput } from '@mongo-gui/core';
import type { MongoClient, MongoClientOptions } from 'mongodb';

const DEFAULT_TIMEOUT_MS = 10_000;
const APP_NAME = 'mongo-gui';

type TlsProfile = NonNullable<ConnectionProfileInput['tls']>;

export interface ClientConfig {
  uri: string;
  options: MongoClientOptions;
}

export function buildClientOptions(profile: ConnectionProfileInput): ClientConfig {
  const options: Partial<MongoClientOptions> = {
    appName: APP_NAME,
  };
  // A driver option overrides the same setting in the URI, so the default applies only when the URI has none.
  const timeoutMs =
    profile.connectTimeoutMs ??
    (/[?&]serverSelectionTimeoutMS=/i.test(profile.uri) ? undefined : DEFAULT_TIMEOUT_MS);
  if (timeoutMs !== undefined) {
    options.serverSelectionTimeoutMS = timeoutMs;
  }
  if (profile.connectTimeoutMs !== undefined) {
    options.connectTimeoutMS = profile.connectTimeoutMs;
  }
  if (profile.readPreference !== undefined) {
    options.readPreference = profile.readPreference;
  }
  if (profile.tls !== undefined) {
    applyTls(options, profile.tls);
  }
  // The declaration build rejects a partially filled MongoClientOptions because the driver
  // types TLS socket fields as required. Every key set above is optional in the driver API.
  return { uri: profile.uri, options: options as MongoClientOptions };
}

// The timeoutMS for a command that must not wait forever on a server that accepts the socket and
// never answers. It is the server selection timeout the profile sets. A URI can set that to 0, which
// the driver reads as no limit, so the default applies then. Pass it per command. Do not set it on
// the client: a client-wide socket timeout would also cut off long queries, shell sessions and change
// streams.
export function commandTimeoutMs(client: Pick<MongoClient, 'options'>): number {
  const selection = client.options.serverSelectionTimeoutMS;
  return selection > 0 ? Math.max(selection, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function applyTls(options: Partial<MongoClientOptions>, tls: TlsProfile): void {
  options.tls = tls.enabled;
  if (!tls.enabled) {
    return;
  }
  if (tls.caFile !== undefined) {
    options.tlsCAFile = tls.caFile;
  }
  if (tls.certFile !== undefined) {
    options.tlsCertificateKeyFile = tls.certFile;
  }
  if (tls.allowInvalidCertificates !== undefined) {
    options.tlsAllowInvalidCertificates = tls.allowInvalidCertificates;
  }
}
