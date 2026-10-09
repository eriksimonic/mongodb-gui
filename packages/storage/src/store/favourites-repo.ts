import {
  FavouriteInputSchema,
  FavouriteSchema,
  newId,
  type Favourite,
  type FavouriteInput,
} from '@mongo-gui/core';
import type { EncryptedStore } from './encrypted-store';
import { blobColumn, textColumn } from './columns';
import { parseInput } from './validation';

export class FavouritesRepository {
  readonly #store: EncryptedStore;

  constructor(store: EncryptedStore) {
    this.#store = store;
  }

  list(): Favourite[] {
    this.#store.assertUnlocked();
    return this.#store.db
      .prepare('SELECT id, payload FROM favourites ORDER BY created_at ASC, rowid ASC')
      .all()
      .map((row) =>
        this.#store.decryptPayload<Favourite>(
          'favourites',
          textColumn(row, 'id'),
          blobColumn(row, 'payload'),
          FavouriteSchema,
        ),
      );
  }

  save(input: FavouriteInput): Favourite {
    this.#store.assertUnlocked();
    const data = parseInput(FavouriteInputSchema, input, 'favourite');
    const createdAt = new Date().toISOString();
    const favourite: Favourite = { ...data, id: newId(), createdAt };
    this.#store.db
      .prepare('INSERT INTO favourites (id, created_at, payload) VALUES (?, ?, ?)')
      .run(
        favourite.id,
        createdAt,
        this.#store.encryptPayload('favourites', favourite.id, favourite),
      );
    return favourite;
  }

  /** Removing an id that does not exist is not an error. */
  remove(id: string): void {
    this.#store.assertUnlocked();
    this.#store.db.prepare('DELETE FROM favourites WHERE id = ?').run(id);
  }
}
