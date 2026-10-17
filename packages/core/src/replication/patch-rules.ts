import type { ReplicaSetMemberConfig, ReplicaSetMemberPatch } from './types';

const REMOVE_AND_ADD = 'Remove it and add the new member instead.';

/** The first rule an edit of an existing member breaks, or undefined when the patch is allowed. */
export function memberPatchRefusal(
  target: Pick<ReplicaSetMemberConfig, 'id' | 'host' | 'arbiterOnly' | 'buildIndexes'>,
  patch: ReplicaSetMemberPatch,
): string | undefined {
  if (patch.id !== undefined && patch.id !== target.id) {
    return `Member ${target.host} keeps its id ${target.id}. ${REMOVE_AND_ADD}`;
  }
  if (patch.host !== undefined && patch.host !== target.host) {
    return `Member ${target.id} keeps its host ${target.host}. ${REMOVE_AND_ADD}`;
  }
  if (patch.arbiterOnly !== undefined && patch.arbiterOnly !== target.arbiterOnly) {
    return `Member ${target.host} cannot change between an arbiter and a data member. ${REMOVE_AND_ADD}`;
  }
  if (patch.buildIndexes !== undefined && patch.buildIndexes !== target.buildIndexes) {
    return `Member ${target.host} cannot change buildIndexes. ${REMOVE_AND_ADD}`;
  }
  return undefined;
}
