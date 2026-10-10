import {
  appError,
  AppErrorException,
  MONGO_SCHEME,
  ReadPreferenceModeSchema,
  toolsUri,
  userInfoEnd,
  type ConnectionProfile,
  type ConnectionStatus,
  type ReadPreferenceMode,
  type ToolsUriOverrides,
} from '@mongo-gui/core';

// What the sidecar records about a connection that comes from a Docker container.
export interface ToolsEndpointDocker {
  containerName?: string;
  image?: string;
}

export interface ToolsEndpointDeps {
  status: (connectionId: string) => ConnectionStatus;
  // Throws VAULT_LOCKED or NOT_FOUND like the store does.
  getProfile: (connectionId: string) => ConnectionProfile;
  // The container behind a docker profile, when Docker can tell.
  dockerSummary?: (profile: ConnectionProfile) => Promise<ToolsEndpointDocker | undefined>;
}

export interface ToolsEndpoint {
  // The URI for the tools config file. It holds credentials and goes nowhere else.
  uri: string;
  profileName: string;
  // The read preference the tools connect with.
  readPreference: ReadPreferenceMode;
  // Strings to mask in every line, error and file: the raw profile URI, the tools URI and the
  // password, encoded and decoded.
  secrets: string[];
  // Facts from the live connection, for the sidecar and the default read preference.
  status: Extract<ConnectionStatus, { state: 'connected' }>;
  docker?: ToolsEndpointDocker;
}

/**
 * The one place a backup or restore learns where to connect. The connection must be live, so a
 * Docker profile's URI already points at its forwarder port on 127.0.0.1. A future SSH tunnel
 * would return its local forwarded URI here.
 */
export async function resolveToolsEndpoint(
  deps: ToolsEndpointDeps,
  connectionId: string,
  overrides: ToolsUriOverrides = {},
): Promise<ToolsEndpoint> {
  const status = deps.status(connectionId);
  if (status.state !== 'connected') {
    throw new AppErrorException(appError('NOT_CONNECTED', 'Connect to the server first.'));
  }
  const profile = deps.getProfile(connectionId);
  const uri = toolsUri(profile, overrides);
  const secrets = [profile.uri, uri, ...uriPasswords(profile.uri)];
  let docker: ToolsEndpointDocker | undefined;
  if (profile.source === 'docker' && deps.dockerSummary !== undefined) {
    try {
      docker = await deps.dockerSummary(profile);
    } catch {
      // The sidecar simply has no container details.
    }
  }
  return {
    uri,
    profileName: profile.name,
    readPreference: readPreferenceOf(uri),
    secrets: [...new Set(secrets.filter((secret) => secret !== ''))],
    status,
    ...(docker === undefined ? {} : { docker }),
  };
}

/** The password in a URI as written and percent-decoded. Empty when there is none. */
export function uriPasswords(uri: string): string[] {
  const scheme = MONGO_SCHEME.exec(uri)?.[0];
  if (scheme === undefined) return [];
  const rest = uri.slice(scheme.length);
  const at = userInfoEnd(rest);
  if (at === -1) return [];
  const userInfo = rest.slice(0, at);
  const colon = userInfo.indexOf(':');
  if (colon === -1) return [];
  const encoded = userInfo.slice(colon + 1);
  let decoded = encoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    // A malformed escape: only the written form can appear anywhere.
  }
  return [...new Set([encoded, decoded])].filter((password) => password !== '');
}

// The tools use the URI's readPreference, else the driver default.
function readPreferenceOf(uri: string): ReadPreferenceMode {
  const match = /[?&]readPreference=([^&]*)/i.exec(uri);
  const parsed = ReadPreferenceModeSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : 'primary';
}
