// An idle client connection has no server opid, so the adapter gives it the id "conn:<n>" instead.
const SYNTHETIC_OPID = /^conn:\d+$/;

/** True for the placeholder id of an idle connection, which the server cannot kill. */
export function isSyntheticOpid(opid: string | number): boolean {
  return typeof opid === 'string' && SYNTHETIC_OPID.test(opid);
}
