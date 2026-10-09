import {
  isBuiltinRole,
  type AuthRestriction,
  type Privilege,
  type PrivilegeResource,
  type UserRoleRef,
} from '@mongo-gui/core';
import {
  definedEntry,
  hasKey,
  readArray,
  readBoolean,
  readField,
  readStringArray,
  readString,
} from '../documents';

// Converts the server's role documents into typed references. Entries without a role or db are
// dropped, since the server always sends both.
export function toRoleRefs(source: unknown, key: string): UserRoleRef[] {
  return readArray(source, key).flatMap((item) => {
    const role = readString(item, 'role');
    const db = readString(item, 'db');
    return role === undefined || db === undefined ? [] : [{ role, db }];
  });
}

export function toRestrictions(source: unknown, key: string): AuthRestriction[] {
  return readArray(source, key).map((item) => ({
    ...definedEntry(
      'clientSource',
      hasKey(item, 'clientSource') ? readStringArray(item, 'clientSource') : undefined,
    ),
    ...definedEntry(
      'serverAddress',
      hasKey(item, 'serverAddress') ? readStringArray(item, 'serverAddress') : undefined,
    ),
  }));
}

export function toPrivileges(source: unknown, key: string): Privilege[] {
  return readArray(source, key).flatMap((item) => {
    const resource = toResource(readField(item, 'resource'));
    return resource === undefined ? [] : [{ resource, actions: readStringArray(item, 'actions') }];
  });
}

function toResource(source: unknown): PrivilegeResource | undefined {
  if (readBoolean(source, 'cluster') === true) {
    return { cluster: true };
  }
  if (readBoolean(source, 'anyResource') === true) {
    return { anyResource: true };
  }
  const db = readString(source, 'db');
  const collection = readString(source, 'collection');
  return db === undefined || collection === undefined ? undefined : { db, collection };
}

// The server reports the inherited lists only when asked for them, so an absent key stays absent.
export function optionalPrivileges(source: unknown, key: string): Privilege[] | undefined {
  return hasKey(source, key) ? toPrivileges(source, key) : undefined;
}

export function optionalRoleRefs(source: unknown, key: string): UserRoleRef[] | undefined {
  return hasKey(source, key) ? toRoleRefs(source, key) : undefined;
}

export function builtinFlag(source: unknown, role: string): boolean {
  return readBoolean(source, 'isBuiltin') ?? isBuiltinRole(role);
}
