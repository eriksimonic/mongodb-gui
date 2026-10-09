const MONGO_SCHEME = /^mongodb(\+srv)?:\/\//i;
const MASK = '***';

export function redactUri(uri: string): string {
  const scheme = MONGO_SCHEME.exec(uri)?.[0];
  if (scheme === undefined) {
    return uri;
  }
  const rest = uri.slice(scheme.length);
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf('@');
  if (at === -1) {
    return uri;
  }
  const userInfo = authority.slice(0, at);
  const colon = userInfo.indexOf(':');
  if (colon === -1) {
    return uri;
  }
  const user = userInfo.slice(0, colon);
  return `${scheme}${user}:${MASK}${rest.slice(at)}`;
}
