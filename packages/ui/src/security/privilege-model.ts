import type {
  Privilege,
  PrivilegeActionCatalog,
  PrivilegeResource,
  RoleInfo,
  UserRoleRef,
} from '@mongo-gui/core';
import { ExistingCollectionNameSchema } from '@mongo-gui/core';
import { databaseNameError } from '../management/input-rules';

/** The resource a privilege row names. `systemBuckets` is kept for rows the editor cannot build. */
export type ResourceKind =
  | 'cluster'
  | 'anyDatabase'
  | 'database'
  | 'collection'
  | 'collectionInAnyDatabase'
  | 'anyResource'
  | 'systemBuckets';

/** One privilege row in the editor. `key` is stable across edits, so React keeps the row's state. */
export interface PrivilegeDraft {
  readonly key: string;
  readonly kind: ResourceKind;
  /** The database a database or collection row names. Empty for cluster, any-database and any-database collection rows. */
  readonly db: string;
  /** The collection a collection row names. Empty for database rows. */
  readonly collection: string;
  readonly actions: readonly string[];
  /** The resource of a row the editor cannot rebuild from its fields. Set for systemBuckets only. */
  readonly preserved?: PrivilegeResource | undefined;
}

export interface ResourceOption {
  readonly value: ResourceKind;
  readonly label: string;
}

/** The resource kinds the editor offers when it creates a row. */
export const RESOURCE_OPTIONS: readonly ResourceOption[] = [
  { value: 'cluster', label: 'Cluster' },
  { value: 'anyDatabase', label: 'Any database' },
  { value: 'database', label: 'This database' },
  { value: 'collection', label: 'A collection' },
  { value: 'collectionInAnyDatabase', label: 'A collection in any database' },
  { value: 'anyResource', label: 'Any resource' },
];

export interface ActionItem {
  readonly value: string;
  readonly label: string;
}

export interface ActionGroup {
  readonly label: string;
  readonly items: readonly ActionItem[];
}

const CATEGORY_LABELS: Readonly<Record<keyof PrivilegeActionCatalog, string>> = {
  queryAndWrite: 'Query and write',
  databaseManagement: 'Database management',
  deploymentManagement: 'Deployment management',
  changeStream: 'Change streams',
  replication: 'Replication',
  sharding: 'Sharding',
  serverAdministration: 'Server administration',
  session: 'Sessions',
  searchIndex: 'Search indexes',
  freeMonitoring: 'Free monitoring',
  diagnostic: 'Diagnostics',
  internal: 'Internal',
};

/** A new row for the database the panel shows. It starts on that database with no actions. */
export function newPrivilegeDraft(key: string, database: string): PrivilegeDraft {
  return { key, kind: 'database', db: database, collection: '', actions: [] };
}

/** Reads a privilege from the server into an editable row. */
export function draftFromPrivilege(privilege: Privilege, key: string): PrivilegeDraft {
  const { resource } = privilege;
  const base = { key, actions: [...privilege.actions] };
  if ('cluster' in resource) {
    return { ...base, kind: 'cluster', db: '', collection: '' };
  }
  if ('anyResource' in resource) {
    return { ...base, kind: 'anyResource', db: '', collection: '' };
  }
  if ('system_buckets' in resource) {
    return {
      ...base,
      kind: 'systemBuckets',
      db: resource.db,
      collection: resource.system_buckets,
      preserved: resource,
    };
  }
  if (resource.db === '' && resource.collection === '') {
    return { ...base, kind: 'anyDatabase', db: '', collection: '' };
  }
  if (resource.collection === '') {
    return { ...base, kind: 'database', db: resource.db, collection: '' };
  }
  if (resource.db === '') {
    return { ...base, kind: 'collectionInAnyDatabase', db: '', collection: resource.collection };
  }
  return { ...base, kind: 'collection', db: resource.db, collection: resource.collection };
}

/**
 * Turns a row into a privilege the server accepts. Returns the first problem as text, so the
 * dialog can show it next to the row. `database` is the database the panel shows.
 */
export function privilegeFromDraft(
  draft: PrivilegeDraft,
  database: string,
): { readonly privilege: Privilege } | { readonly error: string } {
  if (draft.actions.length === 0) {
    return { error: 'Choose at least one action for each row.' };
  }
  const resource = resourceFromDraft(draft, database);
  if ('error' in resource) {
    return resource;
  }
  return { privilege: { resource: resource.resource, actions: [...draft.actions] } };
}

function resourceFromDraft(
  draft: PrivilegeDraft,
  database: string,
): { readonly resource: PrivilegeResource } | { readonly error: string } {
  switch (draft.kind) {
    case 'cluster':
      return { resource: { cluster: true } };
    case 'anyResource':
      return { resource: { anyResource: true } };
    case 'anyDatabase':
      return { resource: { db: '', collection: '' } };
    case 'database':
      return { resource: { db: database, collection: '' } };
    case 'collection': {
      const dbProblem = databaseNameError(draft.db);
      if (dbProblem !== undefined) {
        return { error: dbProblem };
      }
      const collectionProblem = collectionError(draft.collection);
      if (collectionProblem !== undefined) {
        return { error: collectionProblem };
      }
      return { resource: { db: draft.db, collection: draft.collection } };
    }
    case 'collectionInAnyDatabase': {
      const collectionProblem = collectionError(draft.collection);
      if (collectionProblem !== undefined) {
        return { error: collectionProblem };
      }
      return { resource: { db: '', collection: draft.collection } };
    }
    case 'systemBuckets':
      return draft.preserved === undefined
        ? { error: 'The time series buckets row cannot be rebuilt.' }
        : { resource: draft.preserved };
  }
}

/**
 * The problem with a collection name in a privilege. Privileges may name system collections, so
 * the system. prefix is allowed here, unlike when a collection is created.
 */
export function collectionError(name: string): string | undefined {
  if (name === '') {
    return 'Enter a collection name';
  }
  const result = ExistingCollectionNameSchema.safeParse(name);
  return result.success ? undefined : result.error.issues[0]?.message;
}

/** Builds every row, or returns the first row's problem. An empty list is a problem too. */
export function privilegesFromDrafts(
  drafts: readonly PrivilegeDraft[],
  database: string,
): { readonly privileges: Privilege[] } | { readonly error: string } {
  const privileges: Privilege[] = [];
  for (const draft of drafts) {
    const built = privilegeFromDraft(draft, database);
    if ('error' in built) {
      return built;
    }
    privileges.push(built.privilege);
  }
  return { privileges };
}

/** A text the resource of a privilege reads as, for the table and the editor. */
export function resourceLabel(resource: PrivilegeResource): string {
  if ('cluster' in resource) {
    return 'Cluster';
  }
  if ('anyResource' in resource) {
    return 'Any resource';
  }
  if ('system_buckets' in resource) {
    return `Time series buckets of ${resource.db}.${resource.system_buckets}`;
  }
  if (resource.db === '' && resource.collection === '') {
    return 'Any database';
  }
  if (resource.collection === '') {
    return `Database ${resource.db}`;
  }
  return `${resource.db}.${resource.collection}`;
}

/** One line for a privilege: its actions, then the resource. */
export function privilegeSummary(privilege: Privilege): string {
  return `${privilege.actions.join(', ')} on ${resourceLabel(privilege.resource)}`;
}

/**
 * The action picker's groups, in catalog order. A query keeps the actions whose name contains it,
 * ignoring case, and drops the groups that end up empty.
 */
export function actionGroups(catalog: PrivilegeActionCatalog, query = ''): ActionGroup[] {
  const needle = query.trim().toLowerCase();
  const groups: ActionGroup[] = [];
  for (const category of Object.keys(CATEGORY_LABELS) as (keyof PrivilegeActionCatalog)[]) {
    const items = catalog[category]
      .filter((action) => needle === '' || action.toLowerCase().includes(needle))
      .map((action) => ({ value: action, label: action }));
    if (items.length > 0) {
      groups.push({ label: CATEGORY_LABELS[category], items });
    }
  }
  return groups;
}

/** Adds the action when it is absent and removes it when it is present. */
export function toggleAction(actions: readonly string[], action: string): string[] {
  return actions.includes(action)
    ? actions.filter((item) => item !== action)
    : [...actions, action];
}

/** A role reference as one picker value. The database comes first, and database names have no slash. */
export function roleValue(ref: UserRoleRef): string {
  return `${ref.db}/${ref.role}`;
}

export function roleRefFromValue(value: string): UserRoleRef {
  const separator = value.indexOf('/');
  return { db: value.slice(0, separator), role: value.slice(separator + 1) };
}

export interface RoleGroup {
  readonly group: string;
  readonly items: { value: string; label: string }[];
}

/** Roles grouped by the database they live in. Built-in and custom roles of one database share a group. */
export function roleGroups(roles: readonly RoleInfo[]): RoleGroup[] {
  const byDatabase = new Map<string, { value: string; label: string }[]>();
  const seen = new Set<string>();
  for (const role of roles) {
    const value = roleValue({ db: role.db, role: role.role });
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    const items = byDatabase.get(role.db) ?? [];
    items.push({ value, label: role.isBuiltin ? `${role.role} (built-in)` : role.role });
    byDatabase.set(role.db, items);
  }
  return [...byDatabase.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, items]) => ({ group, items }));
}
