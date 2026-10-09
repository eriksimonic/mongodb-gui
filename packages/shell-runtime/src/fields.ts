// Reads one field from a driver reply. Replies arrive as unknown, so each read checks the type.

export function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  return typeof field === 'string' ? field : undefined;
}

export function readBoolean(value: unknown, key: string): boolean | undefined {
  const field = readField(value, key);
  return typeof field === 'boolean' ? field : undefined;
}

function readField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return Reflect.get(value, key);
}
