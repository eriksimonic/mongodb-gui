// The adapter names idle client connections "conn<n>" because they have no server opid.
const SYNTHETIC_OPID = /^conn:\d+$/;

/** True for the placeholder id of an idle connection, which the server cannot kill. */
export function isSyntheticOpid(opid: string | number): boolean {
  return typeof opid === 'string' && SYNTHETIC_OPID.test(opid);
}
