import type { ServerParameter } from '@mongo-gui/core';

/** Parameters whose name or value text contains the query, case-insensitive. */
export function filterParameters(
  parameters: readonly ServerParameter[],
  query: string,
): ServerParameter[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return [...parameters];
  }
  return parameters.filter(
    (parameter) =>
      parameter.name.toLowerCase().includes(needle) ||
      valueText(parameter).toLowerCase().includes(needle),
  );
}

/** The value as the table shows it. Objects and missing values show their canonical text. */
export function valueText(parameter: ServerParameter): string {
  if (parameter.value === undefined) {
    return parameter.valueEjson;
  }
  return typeof parameter.value === 'string' ? parameter.value : String(parameter.value);
}
