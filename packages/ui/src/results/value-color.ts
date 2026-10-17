import type { BsonType } from './result-model';

/** Value colour by BSON type, from the design tokens. */
export function valueColor(type: BsonType): string | undefined {
  switch (type) {
    case 'String':
      return 'var(--mg-ok)';
    case 'Int32':
    case 'Int64':
    case 'Double':
    case 'Decimal128':
      return 'var(--mg-warn)';
    case 'ObjectId':
      return 'var(--mg-series-4)';
    case 'Date':
      return 'var(--mg-danger)';
    case 'Null':
      return 'var(--mg-text-faint)';
    default:
      return undefined;
  }
}
