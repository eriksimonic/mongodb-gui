import type { MongoClient } from 'mongodb';
import {
  NamespaceSchema,
  type NamespaceTarget,
  SetValidationInputSchema,
  type SetValidationInput,
  type ValidationCheckResult,
  type ValidationRules,
} from '@mongo-gui/core';
import {
  isPlainObject,
  readArray,
  readField,
  readNumber,
  readRecord,
  readString,
} from '../documents';
import { stringifyEjson, parseEjson, parseEjsonDocument } from './ejson';
import { parseInput, toAppException, validationError } from './errors';

const DEFAULT_LEVEL: ValidationRules['validationLevel'] = 'strict';
const DEFAULT_ACTION: ValidationRules['validationAction'] = 'error';
const MAX_SAMPLE_SIZE = 10_000;
const MAX_REPORTED_IDS = 20;

interface StoredRules {
  readonly validator: unknown;
  readonly validationLevel: ValidationRules['validationLevel'];
  readonly validationAction: ValidationRules['validationAction'];
}

export async function getValidation(
  client: MongoClient,
  database: string,
  collection: string,
): Promise<ValidationRules> {
  const target = parseInput<NamespaceTarget>(NamespaceSchema, { database, collection });
  try {
    const stored = await readStoredRules(client, target.database, target.collection);
    return {
      validatorEjson: stringifyEjson(stored.validator),
      validationLevel: stored.validationLevel,
      validationAction: stored.validationAction,
    };
  } catch (error) {
    throw toAppException(error);
  }
}

// collMod with an empty validator removes the validator.
export async function setValidation(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<SetValidationInput>(SetValidationInputSchema, input);
  const validator = parseEjsonDocument(parsed.rules.validatorEjson, 'The validator');
  try {
    await client.db(parsed.database).command({
      collMod: parsed.collection,
      validator,
      validationLevel: parsed.rules.validationLevel,
      validationAction: parsed.rules.validationAction,
    });
  } catch (error) {
    throw toAppException(error);
  }
}

// Runs a validator as a $nor filter over a random sample. The validator is a query expression,
// so $nor finds the documents the server would reject on write. Without validatorEjson, the
// validator stored on the collection is checked. With it, a draft is checked and not stored.
export async function checkDocumentsAgainstValidator(
  client: MongoClient,
  database: string,
  collection: string,
  sampleSize: number,
  validatorEjson?: string,
): Promise<ValidationCheckResult> {
  const target = parseInput<NamespaceTarget>(NamespaceSchema, { database, collection });
  if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > MAX_SAMPLE_SIZE) {
    throw validationError(`The sample size must be an integer from 1 to ${MAX_SAMPLE_SIZE}`);
  }
  try {
    const validator =
      validatorEjson === undefined
        ? (await readStoredRules(client, target.database, target.collection)).validator
        : parseEjson(validatorEjson, 'The validator');
    if (!isPlainObject(validator)) {
      throw validationError('The validator must be a JSON object');
    }
    if (Object.keys(validator).length === 0) {
      return { ok: true, errors: [], failingIds: [] };
    }
    const rows: unknown[] = await client
      .db(target.database)
      .collection(target.collection)
      .aggregate([
        { $sample: { size: sampleSize } },
        { $match: { $nor: [validator] } },
        {
          $facet: {
            failing: [{ $count: 'count' }],
            ids: [{ $limit: MAX_REPORTED_IDS }, { $project: { _id: 1 } }],
          },
        },
      ])
      .toArray();
    const facet = rows[0];
    const failing = readNumber(readArray(facet, 'failing')[0], 'count') ?? 0;
    if (failing === 0) {
      return { ok: true, errors: [], failingIds: [] };
    }
    const failingIds = readArray(facet, 'ids').map((row) => stringifyEjson(readField(row, '_id')));
    return {
      ok: false,
      errors: [{ message: `${failing} sampled documents fail the validator.` }],
      failingIds,
    };
  } catch (error) {
    throw toAppException(error);
  }
}

async function readStoredRules(
  client: MongoClient,
  database: string,
  collection: string,
): Promise<StoredRules> {
  const rows: unknown[] = await client
    .db(database)
    .listCollections({ name: collection }, { nameOnly: false })
    .toArray();
  const row = rows[0];
  if (row === undefined) {
    throw validationError('The collection does not exist');
  }
  const options = readRecord(row, 'options');
  return {
    validator: readField(options, 'validator') ?? {},
    validationLevel: toLevel(readString(options, 'validationLevel')),
    validationAction: toAction(readString(options, 'validationAction')),
  };
}

function toLevel(value: string | undefined): ValidationRules['validationLevel'] {
  return value === 'off' || value === 'strict' || value === 'moderate' ? value : DEFAULT_LEVEL;
}

function toAction(value: string | undefined): ValidationRules['validationAction'] {
  return value === 'error' || value === 'warn' ? value : DEFAULT_ACTION;
}
