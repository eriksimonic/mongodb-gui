import type { ConnectionProfileInput } from '@mongo-gui/core';

export const READ_PREFERENCES = [
  'primary',
  'primaryPreferred',
  'secondary',
  'secondaryPreferred',
  'nearest',
] as const;

export type ReadPreference = (typeof READ_PREFERENCES)[number];
export type UriScheme = 'mongodb' | 'mongodb+srv';
export type ExtraOption = readonly [key: string, value: string];
type ConnectionTls = NonNullable<ConnectionProfileInput['tls']>;

export interface TlsForm {
  readonly enabled: boolean;
  readonly caFile: string;
  readonly certFile: string;
  readonly allowInvalidCertificates: boolean;
}

/** The connection string as editable fields. Options the form does not know stay in extraOptions. */
export interface UriForm {
  readonly scheme: UriScheme;
  readonly hosts: readonly string[];
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly authSource: string;
  readonly replicaSet: string;
  readonly readPreference: ReadPreference | undefined;
  readonly connectTimeoutMs: number | undefined;
  readonly tls: TlsForm;
  readonly extraOptions: readonly ExtraOption[];
}

export type ParseResult =
  { readonly ok: true; readonly form: UriForm } | { readonly ok: false; readonly message: string };

export type ProfileOptions = Pick<
  ConnectionProfileInput,
  'tls' | 'readPreference' | 'connectTimeoutMs'
>;

export const DEFAULT_URI = 'mongodb://localhost:27017/';

const URI_PATTERN = /^(mongodb(?:\+srv)?):\/\/(.*)$/is;

export function emptyUriForm(): UriForm {
  return {
    scheme: 'mongodb',
    hosts: ['localhost:27017'],
    username: '',
    password: '',
    database: '',
    authSource: '',
    replicaSet: '',
    readPreference: undefined,
    connectTimeoutMs: undefined,
    tls: { enabled: false, caFile: '', certFile: '', allowInvalidCertificates: false },
    extraOptions: [],
  };
}

function isReadPreference(value: string): value is ReadPreference {
  return (READ_PREFERENCES as readonly string[]).includes(value);
}

function parseUserInfo(userInfo: string | undefined): { username: string; password: string } {
  if (userInfo === undefined) {
    return { username: '', password: '' };
  }
  const colon = userInfo.indexOf(':');
  if (colon === -1) {
    return { username: decodeURIComponent(userInfo), password: '' };
  }
  return {
    username: decodeURIComponent(userInfo.slice(0, colon)),
    password: decodeURIComponent(userInfo.slice(colon + 1)),
  };
}

interface QueryFields {
  authSource: string;
  replicaSet: string;
  readPreference: ReadPreference | undefined;
  connectTimeoutMs: number | undefined;
  tls: TlsForm;
  extraOptions: ExtraOption[];
}

/** Mutable accumulator used while reading the query string. */
interface QueryState {
  authSource: string;
  replicaSet: string;
  readPreference: ReadPreference | undefined;
  connectTimeoutMs: number | undefined;
  tlsEnabled: boolean | undefined;
  caFile: string;
  certFile: string;
  allowInvalidCertificates: boolean;
  extraOptions: ExtraOption[];
}

/** Applies one query option. Option names match case-insensitively, as the driver does. */
function applyQueryOption(state: QueryState, key: string, value: string): void {
  const name = key.toLowerCase();
  const flag = value.toLowerCase();
  switch (name) {
    case 'authsource':
      state.authSource = value;
      return;
    case 'replicaset':
      state.replicaSet = value;
      return;
    case 'readpreference':
      if (isReadPreference(value)) {
        state.readPreference = value;
        return;
      }
      break;
    case 'connecttimeoutms': {
      const milliseconds = Number(value);
      if (/^\d+$/.test(value) && Number.isSafeInteger(milliseconds) && milliseconds > 0) {
        state.connectTimeoutMs = milliseconds;
        return;
      }
      break;
    }
    case 'tls':
    case 'ssl':
      // `true` wins over `false` in either order, so tls and ssl never conflict.
      if (flag === 'true') {
        state.tlsEnabled = true;
        return;
      }
      if (flag === 'false') {
        state.tlsEnabled ??= false;
        return;
      }
      break;
    case 'tlscafile':
      state.caFile = value;
      return;
    case 'tlscertificatekeyfile':
      state.certFile = value;
      return;
    case 'tlsallowinvalidcertificates':
      if (flag === 'true') {
        state.allowInvalidCertificates = true;
        return;
      }
      break;
    default:
      break;
  }
  state.extraOptions.push([key, value]);
}

function parseQuery(query: string): QueryFields {
  const state: QueryState = {
    authSource: '',
    replicaSet: '',
    readPreference: undefined,
    connectTimeoutMs: undefined,
    tlsEnabled: undefined,
    caFile: '',
    certFile: '',
    allowInvalidCertificates: false,
    extraOptions: [],
  };
  for (const pair of query.split('&')) {
    if (pair === '') {
      continue;
    }
    const equals = pair.indexOf('=');
    const key = decodeURIComponent(equals === -1 ? pair : pair.slice(0, equals));
    const value = decodeURIComponent(equals === -1 ? '' : pair.slice(equals + 1));
    applyQueryOption(state, key, value);
  }
  return {
    authSource: state.authSource,
    replicaSet: state.replicaSet,
    readPreference: state.readPreference,
    connectTimeoutMs: state.connectTimeoutMs,
    tls: {
      enabled: state.tlsEnabled === true,
      caFile: state.caFile,
      certFile: state.certFile,
      allowInvalidCertificates: state.allowInvalidCertificates,
    },
    extraOptions: state.extraOptions,
  };
}

/** Splits a mongodb or mongodb+srv URI into form fields. Returns a message when the URI is malformed. */
export function parseMongoUri(uri: string): ParseResult {
  const match = URI_PATTERN.exec(uri.trim());
  if (match === null) {
    return { ok: false, message: 'The URI must start with mongodb:// or mongodb+srv://.' };
  }
  const rest = match[2] ?? '';
  const queryStart = rest.indexOf('?');
  const beforeQuery = queryStart === -1 ? rest : rest.slice(0, queryStart);
  const query = queryStart === -1 ? '' : rest.slice(queryStart + 1);
  const slash = beforeQuery.indexOf('/');
  const authority = slash === -1 ? beforeQuery : beforeQuery.slice(0, slash);
  const path = slash === -1 ? '' : beforeQuery.slice(slash + 1);
  const at = authority.lastIndexOf('@');
  try {
    const { username, password } = parseUserInfo(at === -1 ? undefined : authority.slice(0, at));
    const hostPart = at === -1 ? authority : authority.slice(at + 1);
    const fields = parseQuery(query);
    return {
      ok: true,
      form: {
        scheme: (match[1] ?? '').toLowerCase() === 'mongodb+srv' ? 'mongodb+srv' : 'mongodb',
        hosts: hostPart
          .split(',')
          .map((host) => host.trim())
          .filter((host) => host !== ''),
        username,
        password,
        database: decodeURIComponent(path),
        authSource: fields.authSource,
        replicaSet: fields.replicaSet,
        readPreference: fields.readPreference,
        connectTimeoutMs: fields.connectTimeoutMs,
        tls: fields.tls,
        extraOptions: fields.extraOptions,
      },
    };
  } catch {
    return { ok: false, message: 'The URI contains an invalid percent-encoded character.' };
  }
}

/**
 * Builds a URI from form fields. Percent-encodes the user name, password and database.
 * Each known option is written once. TLS is written only when enabled, because it is off by default.
 */
export function buildMongoUri(form: UriForm): string {
  const userInfo =
    form.username === ''
      ? ''
      : `${encodeURIComponent(form.username)}${
          form.password === '' ? '' : `:${encodeURIComponent(form.password)}`
        }@`;
  const hosts = form.hosts
    .map((host) => host.trim())
    .filter((host) => host !== '')
    .join(',');
  const database = form.database.trim();
  const params: ExtraOption[] = [];
  if (form.authSource !== '') {
    params.push(['authSource', form.authSource]);
  }
  if (form.replicaSet !== '') {
    params.push(['replicaSet', form.replicaSet]);
  }
  if (form.readPreference !== undefined) {
    params.push(['readPreference', form.readPreference]);
  }
  if (form.connectTimeoutMs !== undefined) {
    params.push(['connectTimeoutMS', String(form.connectTimeoutMs)]);
  }
  if (form.tls.enabled) {
    params.push(['tls', 'true']);
  }
  if (form.tls.caFile !== '') {
    params.push(['tlsCAFile', form.tls.caFile]);
  }
  if (form.tls.certFile !== '') {
    params.push(['tlsCertificateKeyFile', form.tls.certFile]);
  }
  if (form.tls.allowInvalidCertificates) {
    params.push(['tlsAllowInvalidCertificates', 'true']);
  }
  params.push(...form.extraOptions);
  const query = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const path = database === '' ? '' : encodeURIComponent(database);
  return `${form.scheme}://${userInfo}${hosts}/${path}${query === '' ? '' : `?${query}`}`;
}

/** Returns the first problem that stops the form from producing a usable URI, or undefined. */
export function validateUriForm(form: UriForm): string | undefined {
  const hosts = form.hosts.map((host) => host.trim()).filter((host) => host !== '');
  if (hosts.length === 0) {
    return 'Add at least one host.';
  }
  if (form.scheme === 'mongodb+srv') {
    if (hosts.length !== 1) {
      return 'A mongodb+srv URI takes exactly one host name.';
    }
    if (hosts.some((host) => host.includes(':'))) {
      return 'A mongodb+srv host name cannot include a port.';
    }
  }
  if (form.password !== '' && form.username === '') {
    return 'A password needs a user name.';
  }
  return undefined;
}

function tlsOptions(tls: TlsForm): ConnectionTls | undefined {
  const hasPaths = tls.caFile !== '' || tls.certFile !== '';
  if (!tls.enabled && !hasPaths && !tls.allowInvalidCertificates) {
    return undefined;
  }
  return {
    enabled: tls.enabled,
    ...(tls.caFile === '' ? {} : { caFile: tls.caFile }),
    ...(tls.certFile === '' ? {} : { certFile: tls.certFile }),
    ...(tls.allowInvalidCertificates ? { allowInvalidCertificates: true } : {}),
  };
}

/** Profile fields that mirror URI options. The profile stores them for display and for the driver. */
export function profileOptions(form: UriForm): ProfileOptions {
  const tls = tlsOptions(form.tls);
  return {
    ...(tls === undefined ? {} : { tls }),
    ...(form.readPreference === undefined ? {} : { readPreference: form.readPreference }),
    ...(form.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: form.connectTimeoutMs }),
  };
}

export function profileOptionsFromUri(uri: string): ProfileOptions {
  const parsed = parseMongoUri(uri);
  return parsed.ok ? profileOptions(parsed.form) : {};
}
