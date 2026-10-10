import { ObjectId } from 'mongodb';

/** An ObjectId from its 24 hex characters. The generators write the hex, and the driver type is set here. */
export function objectIdFromHex(hex: string): ObjectId {
  return ObjectId.createFromHexString(hex);
}
