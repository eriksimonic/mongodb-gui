import type { ConnectionProfile } from '@mongo-gui/core';

/**
 * The docker profiles whose container no longer exists. `containerIds` is the full container
 * list including stopped containers, or undefined when Docker could not be listed. In that case,
 * and for every manual profile, nothing is returned.
 */
export function staleDockerProfiles(
  profiles: readonly ConnectionProfile[],
  containerIds: ReadonlySet<string> | undefined,
): ConnectionProfile[] {
  if (containerIds === undefined) {
    return [];
  }
  return profiles.filter(
    (profile) =>
      profile.source === 'docker' &&
      profile.dockerContainerId !== undefined &&
      !containerIds.has(profile.dockerContainerId),
  );
}
