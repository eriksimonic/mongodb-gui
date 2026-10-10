/** A collection name that the shell reads as a property, such as `orders` or `$system`. */
const PROPERTY_NAME = /^[A-Za-z_$][\w$]*$/;

/**
 * The statement that lists the documents of a collection. A name that is not a plain property
 * name goes through `db.getCollection`, with the name JSON-escaped.
 */
export function collectionQueryStatement(collection: string): string {
  return PROPERTY_NAME.test(collection)
    ? `db.${collection}.find({})`
    : `db.getCollection(${JSON.stringify(collection)}).find({})`;
}
