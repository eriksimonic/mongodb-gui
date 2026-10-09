const MONGO_SCHEME = /^\s*mongodb(\+srv)?:\/\//i;
const TLS_KEY_PASSWORD = /(tlsCertificateKeyFilePassword=)[^&]*/gi;
const MASK = '***';

export function redactUri(uri: string): string {
  const scheme = MONGO_SCHEME.exec(uri)?.[0];
  if (scheme === undefined) {
    return uri;
  }
  return maskTlsKeyPassword(maskUserInfo(uri, scheme));
}

function maskUserInfo(uri: string, scheme: string): string {
  const rest = uri.slice(scheme.length);
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  let at = authority.lastIndexOf('@');
  if (at === -1) {
    const eq = rest.indexOf('=');
    at = (eq === -1 ? rest : rest.slice(0, eq)).lastIndexOf('@');
  }
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

function maskTlsKeyPassword(uri: string): string {
  return uri.replace(TLS_KEY_PASSWORD, `$1${MASK}`);
}
