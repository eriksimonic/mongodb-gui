import type { ServerParameter } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { filterParameters, valueText } from './parameter-search';

const PARAMETERS: ServerParameter[] = [
  { name: 'logLevel', value: 0, valueEjson: '{"$numberInt":"0"}' },
  { name: 'notablescan', value: false, valueEjson: 'false' },
  { name: 'authenticationMechanisms', value: 'SCRAM-SHA-256', valueEjson: '"SCRAM-SHA-256"' },
  { name: 'internalQueryCache', value: undefined, valueEjson: '{"size":4}' },
];

describe('filterParameters', () => {
  it('returns every parameter for an empty query', () => {
    expect(filterParameters(PARAMETERS, '  ')).toHaveLength(4);
  });

  it('matches the name, ignoring case', () => {
    expect(filterParameters(PARAMETERS, 'LOGLEVEL').map((item) => item.name)).toEqual(['logLevel']);
  });

  it('matches the value text', () => {
    expect(filterParameters(PARAMETERS, 'sha-256').map((item) => item.name)).toEqual([
      'authenticationMechanisms',
    ]);
    expect(filterParameters(PARAMETERS, 'false').map((item) => item.name)).toEqual(['notablescan']);
  });

  it('shows the canonical text of a value with no scalar form', () => {
    expect(filterParameters(PARAMETERS, 'size')).toEqual([PARAMETERS[3]]);
    expect(valueText(PARAMETERS[3] as ServerParameter)).toBe('{"size":4}');
  });

  it('shows an object value by its canonical text', () => {
    const parameter: ServerParameter = {
      name: 'featureFlags',
      value: { enabled: true },
      valueEjson: '{"enabled":true}',
    };
    expect(valueText(parameter)).toBe('{"enabled":true}');
  });
});
