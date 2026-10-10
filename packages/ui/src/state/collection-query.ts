/**
 * A collection name that mongosh reads as a property of `db`, such as `orders`. The shell returns
 * `undefined` for a property that starts with `_` or contains `$`, so those names are left out.
 */
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
 * The statement that lists the documents of a collection. A name that `db.<name>` does not reach
 * goes through `db.getCollection`, with the name JSON-escaped.
 */
export function collectionQueryStatement(collection: string): string {
  return PROPERTY_NAME.test(collection) && !DATABASE_MEMBERS.has(collection)
    ? `db.${collection}.find({})`
    : `db.getCollection(${JSON.stringify(collection)}).find({})`;
}
