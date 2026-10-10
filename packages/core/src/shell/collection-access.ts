/**
 * How a mongosh statement names a collection. `db.orders` works for most names, but mongosh returns
 * `undefined` for a property that starts with `_` or contains `$`, and a name that matches a member
 * of the `Database` object resolves to that member instead. Those names go through
 * `db.getCollection('name')`.
 */

/** A collection name that mongosh reads as a property of `db`, such as `orders`. */
const PROPERTY_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Members of the mongosh `Database` object, including those from `Object.prototype`. A collection
 * with one of these names is not reachable as `db.<name>`, because the member wins.
 */
const DATABASE_MEMBERS: ReadonlySet<string> = new Set([
  'adminCommand',
  'aggregate',
  'auth',
  'changeUserPassword',
  'checkMetadataConsistency',
  'cloneCollection',
  'cloneDatabase',
  'commandHelp',
  'constructor',
  'copyDatabase',
  'createCollection',
  'createEncryptedCollection',
  'createRole',
  'createUser',
  'createView',
  'currentOp',
  'dropAllRoles',
  'dropAllUsers',
  'dropDatabase',
  'dropRole',
  'dropUser',
  'fsyncLock',
  'fsyncUnlock',
  'getCollection',
  'getCollectionInfos',
  'getCollectionNames',
  'getLastError',
  'getLastErrorObj',
  'getLogComponents',
  'getMongo',
  'getName',
  'getProfilingStatus',
  'getReplicationInfo',
  'getRole',
  'getRoles',
  'getSiblingDB',
  'getUser',
  'getUsers',
  'grantPrivilegesToRole',
  'grantRolesToRole',
  'grantRolesToUser',
  'hasOwnProperty',
  'hello',
  'help',
  'hostInfo',
  'isMaster',
  'isPrototypeOf',
  'killOp',
  'listCommands',
  'logout',
  'printCollectionStats',
  'printReplicationInfo',
  'printSecondaryReplicationInfo',
  'printShardingStatus',
  'printSlaveReplicationInfo',
  'propertyIsEnumerable',
  'revokePrivilegesFromRole',
  'revokeRolesFromRole',
  'revokeRolesFromUser',
  'rotateCertificates',
  'runCommand',
  'serverBits',
  'serverBuildInfo',
  'serverCmdLineOpts',
  'serverStatus',
  'setLogLevel',
  'setProfilingLevel',
  'setSecondaryOk',
  'shutdownServer',
  'sql',
  'stats',
  'toLocaleString',
  'toString',
  'updateRole',
  'updateUser',
  'valueOf',
  'version',
  'watch',
]);

/**
 * A string as a single-quoted mongosh literal. Backslash, the quote, newline, carriage return and
 * tab get their short escapes; other control characters and the Unicode line separators become
 * `\uXXXX`, so the literal always stays on one line.
 */
export function quoteShellString(text: string): string {
  let out = "'";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\') out += '\\\\';
    else if (char === "'") out += "\\'";
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029)
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return out + "'";
}

/**
 * The mongosh expression that reaches a collection: `db.orders` when the name is a plain property
 * that no `Database` member shadows, else `db.getCollection('name')` with the name quoted.
 */
export function collectionAccess(name: string): string {
  return PROPERTY_NAME.test(name) && !DATABASE_MEMBERS.has(name)
    ? `db.${name}`
    : `db.getCollection(${quoteShellString(name)})`;
}
