import { describe, expectTypeOf, it } from 'vitest';
import type { ConnectionStatus } from '../domain/connection';
import type { RpcClient } from './client';

describe('RpcClient', () => {
  it('types connections.connect as taking an id and returning a status', () => {
    expectTypeOf<RpcClient['connections']['connect']>().toEqualTypeOf<
      (input: { id: string }) => Promise<ConnectionStatus>
    >();
  });

  it('types calls without a payload as taking void', () => {
    expectTypeOf<RpcClient['vault']['lock']>().toBeCallableWith();
    expectTypeOf<RpcClient['vault']['lock']>().returns.toEqualTypeOf<Promise<void>>();
  });

  it('types history.list with optional filters', () => {
    expectTypeOf<RpcClient['history']['list']>().parameter(0).toEqualTypeOf<{
      connectionId?: string | undefined;
      search?: string | undefined;
      limit?: number | undefined;
    }>();
  });
});
