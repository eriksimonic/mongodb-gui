/**
 * Reads one JavaScript literal from an acorn expression and returns it as canonical EJSON. It
 * accepts only the forms the query builder can show and write back. Any other node returns
 * `{ unsupported }` with a reason, and the caller leaves the statement text unchanged.
 */

import type {
  ArrayExpression,
  CallExpression,
  Expression,
  Literal,
  NewExpression,
  ObjectExpression,
  SpreadElement,
  TemplateLiteral,
  UnaryExpression,
} from 'acorn';

export type EjsonValue =
  null | boolean | number | string | EjsonValue[] | { readonly [key: string]: EjsonValue };

export type LiteralResult = { readonly value: EjsonValue } | { readonly unsupported: string };

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const INTEGER_TEXT = /^[+-]?\d+$/;
const DECIMAL_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
// The flags Mongo accepts. The same set as `LITERAL_REGEX_FLAGS` in ejson/format.ts.
const REGEX_FLAGS = /^[imsu]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const ZONE_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/;
const INT32 = { min: -(2n ** 31n), max: 2n ** 31n - 1n };
const INT64 = { min: -(2n ** 63n), max: 2n ** 63n - 1n };

export function parseLiteral(node: Expression): LiteralResult {
  switch (node.type) {
    case 'Literal':
      return literalValue(node);
    case 'TemplateLiteral':
      return templateValue(node);
    case 'ArrayExpression':
      return arrayValue(node);
    case 'ObjectExpression':
      return objectValue(node);
    case 'UnaryExpression':
      return negativeNumber(node);
    case 'CallExpression':
      return callValue(node);
    case 'NewExpression':
      return newValue(node);
    case 'Identifier':
      return refuse('identifier');
    default:
      return refuse(`not a literal (${node.type})`);
  }
}

function refuse(reason: string): { readonly unsupported: string } {
  return { unsupported: reason };
}

function literalValue(node: Literal): LiteralResult {
  if (node.regex) {
    return regexValue(node.regex.pattern, node.regex.flags);
  }
  const { value } = node;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { value } : refuse('number out of range');
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
    return { value };
  }
  return refuse('BigInt literal');
}

function regexValue(pattern: string, flags: string): LiteralResult {
  if (!REGEX_FLAGS.test(flags)) {
    return refuse('regex flag other than i, m, s, u');
  }
  return { value: { $regularExpression: { pattern, options: flags } } };
}

// A template string without an expression is a plain string.
function templateValue(node: TemplateLiteral): LiteralResult {
  if (node.expressions.length > 0) {
    return refuse('template string with an expression');
  }
  const cooked = node.quasis[0]?.value.cooked;
  return typeof cooked === 'string' ? { value: cooked } : refuse('template string');
}

function arrayValue(node: ArrayExpression): LiteralResult {
  const items: EjsonValue[] = [];
  for (const element of node.elements) {
    if (element === null) {
      return refuse('array hole');
    }
    if (element.type === 'SpreadElement') {
      return refuse('spread');
    }
    const item = parseLiteral(element);
    if ('unsupported' in item) {
      return item;
    }
    items.push(item.value);
  }
  return { value: items };
}

function objectValue(node: ObjectExpression): LiteralResult {
  const entries: Array<[string, EjsonValue]> = [];
  for (const property of node.properties) {
    if (property.type === 'SpreadElement') {
      return refuse('spread');
    }
    if (property.computed) {
      return refuse('computed key');
    }
    if (property.kind !== 'init' || property.method) {
      return refuse('method or accessor');
    }
    const key = propertyKey(property.key);
    if (key === undefined) {
      return refuse('property key');
    }
    // An object literal with a __proto__ key sets the prototype in JavaScript, not a field.
    if (key === '__proto__') {
      return refuse('__proto__ key');
    }
    const value = parseLiteral(property.value);
    if ('unsupported' in value) {
      return value;
    }
    entries.push([key, value.value]);
  }
  return { value: Object.fromEntries(entries) };
}

function propertyKey(key: Expression): string | undefined {
  if (key.type === 'Identifier') {
    return key.name;
  }
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) {
    return String(key.value);
  }
  return undefined;
}

// A minus sign before a number literal. Mongo filters often compare with negative numbers.
function negativeNumber(node: UnaryExpression): LiteralResult {
  const { argument } = node;
  if (node.operator !== '-' || argument.type !== 'Literal') {
    return refuse('unary operator');
  }
  const { value } = argument;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return refuse('unary operator');
  }
  return { value: -value };
}

function callValue(node: CallExpression): LiteralResult {
  if (node.callee.type !== 'Identifier') {
    return refuse('call');
  }
  const { name } = node.callee;
  switch (name) {
    case 'ObjectId':
      return objectIdValue(node.arguments);
    case 'ISODate':
      return isoDateValue(stringArgument(node.arguments));
    case 'NumberInt':
      return integerValue(name, node.arguments);
    case 'NumberLong':
      return integerValue(name, node.arguments);
    case 'Decimal128':
    case 'NumberDecimal':
      return decimalValue(name, node.arguments);
    default:
      return refuse(`call to ${name}`);
  }
}

// Only `new Date("...")` is a literal. Other constructors are refused.
function newValue(node: NewExpression): LiteralResult {
  if (node.callee.type !== 'Identifier' || node.callee.name !== 'Date') {
    return refuse('constructor call');
  }
  const text = stringArgument(node.arguments);
  if (text === undefined) {
    return refuse('new Date needs one string');
  }
  // A date text without a zone uses the local time zone, as in JavaScript.
  return dateValue(Date.parse(text));
}

function singleArgument(args: Array<Expression | SpreadElement>): Expression | undefined {
  const [first] = args;
  if (args.length !== 1 || first === undefined || first.type === 'SpreadElement') {
    return undefined;
  }
  return first;
}

function stringArgument(args: Array<Expression | SpreadElement>): string | undefined {
  const arg = singleArgument(args);
  return arg?.type === 'Literal' && typeof arg.value === 'string' ? arg.value : undefined;
}

// The text of one string or number argument, for NumberInt, NumberLong and Decimal128.
function scalarArgument(args: Array<Expression | SpreadElement>): string | undefined {
  const arg = singleArgument(args);
  if (arg === undefined) {
    return undefined;
  }
  const parsed = parseLiteral(arg);
  if ('unsupported' in parsed) {
    return undefined;
  }
  const { value } = parsed;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function objectIdValue(args: Array<Expression | SpreadElement>): LiteralResult {
  const hex = stringArgument(args);
  if (hex === undefined || !OBJECT_ID.test(hex)) {
    return refuse('ObjectId needs one 24 hex character string');
  }
  return { value: { $oid: hex } };
}

// Mongo reads a date-time with no zone as UTC. JavaScript reads it as local time, so add Z.
function isoDateValue(text: string | undefined): LiteralResult {
  if (text === undefined || !ISO_DATE.test(text)) {
    return refuse('ISODate needs one ISO 8601 string');
  }
  const zoned = text.includes('T') && !ZONE_SUFFIX.test(text) ? `${text}Z` : text;
  return dateValue(Date.parse(zoned));
}

function dateValue(millis: number): LiteralResult {
  return Number.isFinite(millis)
    ? { value: { $date: { $numberLong: String(millis) } } }
    : refuse('invalid date');
}

function integerValue(
  name: 'NumberInt' | 'NumberLong',
  args: Array<Expression | SpreadElement>,
): LiteralResult {
  const text = scalarArgument(args);
  if (text === undefined || !INTEGER_TEXT.test(text)) {
    return refuse(`${name} needs an integer`);
  }
  const number = BigInt(text);
  const range = name === 'NumberInt' ? INT32 : INT64;
  if (number < range.min || number > range.max) {
    return refuse(`${name} out of range`);
  }
  return name === 'NumberInt'
    ? { value: { $numberInt: number.toString() } }
    : { value: { $numberLong: number.toString() } };
}

// formatMongoshSyntax writes NumberDecimal, so both names read as the same decimal.
function decimalValue(
  name: 'Decimal128' | 'NumberDecimal',
  args: Array<Expression | SpreadElement>,
): LiteralResult {
  const text = scalarArgument(args);
  if (text === undefined || !DECIMAL_TEXT.test(text)) {
    return refuse(`${name} needs a decimal`);
  }
  return { value: { $numberDecimal: text } };
}
