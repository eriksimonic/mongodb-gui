import { collectionAccess } from '@mongo-gui/core';

/**
 * The statement that lists the documents of a collection. A name that `db.<name>` does not reach
 * goes through `db.getCollection`, with the name single-quoted and escaped.
 */
export function collectionQueryStatement(collection: string): string {
  return `${collectionAccess(collection)}.find({})`;
}

/** Words that need brackets when they name a collection in SQL. */
const SQL_KEYWORDS = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'ORDER',
  'GROUP',
  'BY',
  'JOIN',
  'ON',
  'AS',
  'SET',
  'VALUES',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TOP',
  'DISTINCT',
  'HAVING',
  'LEFT',
  'INNER',
  'INTO',
  'TABLE',
  'USER',
]);

const PLAIN_SQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A collection name as SQL. A name that is not a plain identifier, or that is a SQL keyword, goes
 * in brackets with `]` doubled.
 */
function sqlCollectionName(collection: string): string {
  const plain = PLAIN_SQL_NAME.test(collection) && !SQL_KEYWORDS.has(collection.toUpperCase());
  return plain ? collection : `[${collection.replaceAll(']', ']]')}]`;
}

/** The SQL statement that lists the documents of a collection, or only the first `top` of them. */
export function collectionSelectStatement(collection: string, top?: number): string {
  const limit = top === undefined ? '' : `TOP ${top} `;
  return `SELECT ${limit}* FROM ${sqlCollectionName(collection)};`;
}

/** The SQL statement that counts the documents of a collection. */
export function collectionCountStatement(collection: string): string {
  return `SELECT COUNT(*) FROM ${sqlCollectionName(collection)};`;
}
