import { BSON } from 'mongodb';
import { AppErrorException, appError } from '@mongo-gui/core';
import { isPlainObject, type PlainObject } from '../documents';

export const EJSON = BSON.EJSON;

const EJSON_OPTIONS = { relaxed: false } as const;
const POSITION_PATTERN = /position (\d+)/;
const LINE_COLUMN_PATTERN = /line (\d+) column (\d+)/;

export function stringifyEjson(value: unknown): string {
  return EJSON.stringify(value, EJSON_OPTIONS);
}

// V8 parse messages quote the input around the failure, so they can carry document content.
// Only the position is kept.
export function parseEjson(text: string, label: string): unknown {
  let value: unknown;
  try {
    value = EJSON.parse(text, EJSON_OPTIONS);
  } catch (error) {
    throw invalidEjson(label, error);
  }
  if (containsInvalidDate(value)) {
    throw new AppErrorException(appError('VALIDATION', `${label} contains an invalid date`));
  }
  return value;
}

export function parseEjsonDocument(text: string, label: string): PlainObject {
  const value = parseEjson(text, label);
  if (!isPlainObject(value)) {
    throw new AppErrorException(appError('VALIDATION', `${label} must be a JSON object`));
  }
  return value;
}

function containsInvalidDate(value: unknown): boolean {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime());
  }
  if (Array.isArray(value)) {
    return value.some(containsInvalidDate);
  }
  if (isPlainObject(value)) {
    return Object.values(value).some(containsInvalidDate);
  }
  return false;
}

function invalidEjson(label: string, error: unknown): AppErrorException {
  const message = error instanceof Error ? error.message : '';
  const detail = positionDetail(message);
  const text = `${label} is not valid Extended JSON`;
  return new AppErrorException(
    detail === undefined ? appError('VALIDATION', text) : appError('VALIDATION', text, detail),
  );
}

function positionDetail(message: string): string | undefined {
  const line = LINE_COLUMN_PATTERN.exec(message);
  if (line !== null) {
    return `Parse error at line ${line[1] ?? '?'}, column ${line[2] ?? '?'}`;
  }
  const position = POSITION_PATTERN.exec(message);
  if (position !== null) {
    return `Parse error at character ${position[1] ?? '?'}`;
  }
  return undefined;
}
