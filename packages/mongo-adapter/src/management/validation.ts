import type { MongoClient } from 'mongodb';
import {
  SetValidationInputSchema,
  type SetValidationInput,
  type ValidationCheckResult,
  type ValidationRules,
} from '@mongo-gui/core';
import {
  readField,
  readRecord,
  readArray,
  readNumber,
  readString,
  isPlainObject,
} from '../documents';
import { parseInput, toAppException, validationError } from './errors';
import { stringifyEjson } from './ejson';

const DEFAULT_LEVEL: ValidationRules['validationLevel'] = 'strict';
const DEFAULT_ACTION: ValidationRules['validationAction'] = 'error';
const MAX_SAMPLE_SIZE = 10_000;
const MAX_REPORTED_IDS = 20;

export async function getValidation(
  client: MongoClient,
  database: string,
  collection: string,
): Promise<ValidationRules> {
  try {
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
  } catch (error) {
    throw toAppException(error);
  }
}

// collMod with an empty validator removes the validator.
export async function setValidation(client: MongoClient, input: unknown): Promise<void> {
  const parsed = parseInput<SetValidationInput>(SetValidationInputSchema, input);
  try {
    await client.db(parsed.database).command({
      collMod: parsed.collection,
      validator: parsed.rules.validator ?? {},
      validationLevel: parsed.rules.validationLevel,
      validationAction: parsed.rules.validationAction,
    });
  } catch (error) {
    throw toAppException(error);
  }
}

// Runs the stored validator as a $nor filter over a random sample. The validator is a query
// expression, so $nor finds exactly the documents the server would reject on write.
export async function checkDocumentsAgainstValidator(
  client: MongoClient,
  database: string,
  collection: string,
  sampleSize: number,
): Promise<ValidationCheckResult> {
  if (!Number.isInteger(sampleSize) || sampleSize < 1 || sampleSize > MAX_SAMPLE_SIZE) {
    throw validationError(`The sample size must be an integer from 1 to ${MAX_SAMPLE_SIZE}`);
  }
  const rules = await getValidation(client, database, collection);
  if (!isPlainObject(rules.validator)) {
    throw validationError('The validator must be a JSON object');
  }
  if (Object.keys(rules.validator).length === 0) {
    return { ok: true, errors: [] };
  }
  try {
    const rows: unknown[] = await client
      .db(database)
      .collection(collection)
      .aggregate([
        { $sample: { size: sampleSize } },
        { $match: { $nor: [rules.validator] } },
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
      return { ok: true, errors: [] };
    }
    const ids = readArray(facet, 'ids').map((row) => stringifyEjson(readField(row, '_id')));
    return {
      ok: false,
      errors: [
        {
          message: `${failing} sampled documents fail the validator. First failing _id values as Extended JSON: [${ids.join(', ')}]`,
        },
      ],
    };
  } catch (error) {
    throw toAppException(error);
  }
}

function toLevel(value: string | undefined): ValidationRules['validationLevel'] {
  return value === 'off' || value === 'strict' || value === 'moderate' ? value : DEFAULT_LEVEL;
}

function toAction(value: string | undefined): ValidationRules['validationAction'] {
  return value === 'error' || value === 'warn' ? value : DEFAULT_ACTION;
}
