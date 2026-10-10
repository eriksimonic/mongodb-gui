// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { localConnectionId } from './mock-fixtures';
import { createMockUiApi } from './mock-rpc-client';

const LOOKUP = `db.orders.aggregate([{ $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', pipeline: [{ $match: { active: true } }], as: 'customer' } }])`;

async function connectedApi() {
  const api = createMockUiApi({ preset: 'unlocked' });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}

describe('mock explain verbosity', () => {
  it('shows a plan at queryPlanner for a case that has only executionStats', async () => {
    const api = await connectedApi();
    const result = await api.rpc.explain.run({
      connectionId: localConnectionId,
      database: 'shop',
      code: LOOKUP,
      verbosity: 'queryPlanner',
    });
    expect(result.tree.command).toBe('aggregate');
    expect(result.tree.winning.name).toBe('$lookup');
  });

  it('keeps the requested verbosity when the case has it', async () => {
    const api = await connectedApi();
    const result = await api.rpc.explain.run({
      connectionId: localConnectionId,
      database: 'shop',
      code: LOOKUP,
      verbosity: 'executionStats',
    });
    expect(result.tree.verbosity).toBe('executionStats');
  });
});
