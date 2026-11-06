import { compareVersions, firstToolsFor } from '../backup/versions';
import type { CopyFinding } from './assess';

/**
 * The newest installed tools version that fits both servers, or undefined when none fits. The
 * copy service and the copy dialog both choose the tools this way, so their findings agree.
 */
export function newestFittingTools(
  installed: readonly string[],
  serverVersions: readonly string[],
): string | undefined {
  const minimums = serverVersions
    .map((version) => firstToolsFor(version)?.tools)
    .filter((version): version is string => version !== undefined);
  const fits = (version: string) =>
    minimums.every((minimum) => compareVersions(version, minimum) >= 0);
  return installed.filter(fits).sort((a, b) => compareVersions(b, a))[0];
}

/** The findings that stop a copy: every block, and each strong finding the user did not acknowledge. */
export function unresolvedCopyFindings(
  findings: readonly CopyFinding[],
  acknowledged: readonly string[],
): CopyFinding[] {
  return findings.filter(
    (item) =>
      item.severity === 'block' ||
      (item.severity === 'strong' && !acknowledged.includes(item.code)),
  );
}
