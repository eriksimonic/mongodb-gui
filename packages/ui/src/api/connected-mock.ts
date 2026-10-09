import { localConnectionId } from './mock-fixtures';
import { createMockUiApi } from './mock-rpc-client';
import type { UiApi } from './ui-api';

/**
 * A mock backend with the local connection already connected, so management calls run. Tests and
 * stories load it, and tests spy on its `rpc.management` methods to check the input sent.
 */
export async function connectedMockApi(): Promise<UiApi> {
  const api = createMockUiApi({ preset: 'unlocked' });
  await api.rpc.connections.connect({ id: localConnectionId });
  return api;
}
