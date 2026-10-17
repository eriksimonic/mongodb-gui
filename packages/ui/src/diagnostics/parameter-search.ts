import { isSecretKey, type ServerParameter } from '@mongo-gui/core';

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

/**
 * The value as the table shows it. Objects, arrays and missing values show their canonical text. A
 * value cut short already carries its truncation marker in that text.
 */
export function valueText(parameter: ServerParameter): string {
  if (
    parameter.value === undefined ||
    (typeof parameter.value === 'object' && parameter.value !== null)
  ) {
    return parameter.valueEjson;
  }
  return typeof parameter.value === 'string' ? parameter.value : String(parameter.value);
}

/** The colour a value reads in: true blue, false grey, numbers orange, everything else default. */
export function valueColor(text: string): string | undefined {
  if (text === 'true') {
    return 'blue';
  }
  if (text === 'false') {
    return 'dimmed';
  }
  return text !== '' && Number.isFinite(Number(text)) ? 'orange' : undefined;
}

/** The value types a parameter can be changed to from the panel. */
export type ParameterValue = string | number | boolean;

/**
 * The plain value of a parameter the panel can change, or undefined for an object, an array, a cut
 * value or a masked secret.
 */
export function editableValue(parameter: ServerParameter): ParameterValue | undefined {
  const { value } = parameter;
  if (parameter.truncated === true || isSecretKey(parameter.name)) {
    return undefined;
  }
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined;
}
