const MONGO_SCHEME = /^\s*mongodb(\+srv)?:\/\//i;
const PASSWORD_OPTION = /((?:tlsCertificateKeyFilePassword|sslPEMKeyPassword)=)[^&]*/gi;
const QUERY_PARAMETER = /[?&][A-Za-z0-9_]+=/;
const MASK = '***';

export function redactUri(uri: string): string {
  const scheme = MONGO_SCHEME.exec(uri)?.[0];
  if (scheme === undefined) {
    return uri;
  }
  return maskPasswordOptions(maskUserInfo(uri, scheme));
}

/**
 * The index of the '@' that ends the userinfo, in the text after the scheme, or -1 when there is no
 * userinfo. A password may hold an unencoded '/' or '?', so the '@' is searched in the authority
 * first and then before the first query parameter. A later '@' inside an option value is ignored.
 */
export function userInfoEnd(rest: string): number {
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  let at = authority.lastIndexOf('@');
  if (at === -1) {
    const parameter = rest.search(QUERY_PARAMETER);
    at = (parameter === -1 ? rest : rest.slice(0, parameter)).lastIndexOf('@');
  }
  return at;
}

function maskUserInfo(uri: string, scheme: string): string {
  const rest = uri.slice(scheme.length);
  const at = userInfoEnd(rest);
  if (at === -1) {
    return uri;
  }
  const userInfo = rest.slice(0, at);
  const colon = userInfo.indexOf(':');
  if (colon === -1) {
    return uri;
  }
  const user = userInfo.slice(0, colon);
  return `${scheme}${user}:${MASK}${rest.slice(at)}`;
}

function maskPasswordOptions(uri: string): string {
  return uri.replace(PASSWORD_OPTION, `$1${MASK}`);
}
