import type { Document, MongoClient } from 'mongodb';
import { toAppException } from '../management/errors';

// Runs a command against the admin database and maps driver failures to AppError.
export async function runAdminCommand(client: MongoClient, command: Document): Promise<unknown> {
  try {
    const reply: unknown = await client.db('admin').command(command);
    return reply;
  } catch (error) {
    throw toAppException(error);
  }
}
