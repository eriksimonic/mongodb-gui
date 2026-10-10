const MONGO_SCHEME = /^\s*(mongodb(?:\+srv)?:\/\/)/i;
const DIRECT_OPTIONS: ReadonlySet<string> = new Set(['directConnection', 'replicaSet']);

/**
 * The URI of a direct connection to one member of the deployment a URI names. The host list is
 * replaced by `host`, `directConnection=true` is set, and `replicaSet` is dropped because the
 * driver refuses both together. User info, the database and the other options are kept. An SRV
 * URI becomes a plain `mongodb://` URI, because SRV resolves to the whole set.
 */
export function directUriFor(uri: string, host: string): string {
  const scheme = MONGO_SCHEME.exec(uri);
  if (scheme === null) {
    throw new Error('Not a MongoDB URI');
  }
  const rest = uri.slice(scheme[0].length);
  const userInfoEnd = rest.lastIndexOf('@', hostListEnd(rest));
  const userInfo = userInfoEnd === -1 ? '' : rest.slice(0, userInfoEnd + 1);
  const afterHosts = rest.slice(hostListEnd(rest));
  const [pathPart = '', query = ''] = splitQuery(afterHosts);
  const options = query
    .split('&')
    .filter((option) => option !== '' && !DIRECT_OPTIONS.has(option.split('=')[0] ?? ''));
  options.push('directConnection=true');
  const path = pathPart === '' ? '/' : pathPart;
  return `mongodb://${userInfo}${host}${path}?${options.join('&')}`;
}

/** The name of the derived profile: the parent name and the member host. */
export function directConnectionName(parentName: string, host: string): string {
  return `${parentName} · ${host}`;
}

/** Index in `rest` of the first `/` or `?` after the host list, or its length. */
function hostListEnd(rest: string): number {
  const slash = rest.indexOf('/');
  const question = rest.indexOf('?');
  const ends = [slash, question].filter((index) => index !== -1);
  return ends.length === 0 ? rest.length : Math.min(...ends);
}

function splitQuery(text: string): [string, string] {
  const question = text.indexOf('?');
  return question === -1 ? [text, ''] : [text.slice(0, question), text.slice(question + 1)];
}
