import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createMockUiApi } from './api/mock-rpc-client';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element in index.html');
}

// ?preset=unlocked starts unlocked with fixtures. Any other value starts on the first-run screen.
const preset =
  new URLSearchParams(window.location.search).get('preset') === 'unlocked' ? 'unlocked' : 'fresh';
// ?profilerRows=5000 replaces the shop profiler fixtures with generated rows, for performance checks.
const profilerRowsParam = Number(new URLSearchParams(window.location.search).get('profilerRows'));
const profilerRows =
  Number.isInteger(profilerRowsParam) && profilerRowsParam > 0 ? profilerRowsParam : undefined;
// ?sharding=cluster makes the local connection report a sharded topology with the seeded cluster.
const sharding =
  new URLSearchParams(window.location.search).get('sharding') === 'cluster'
    ? 'cluster'
    : 'standalone';
// ?replset=member makes the local connection a three-member set. ?replset=uninitiated makes it a
// standalone started with --replSet that has no configuration yet.
const replsetParam = new URLSearchParams(window.location.search).get('replset');
const api = createMockUiApi({
  preset,
  latencyMs: 120,
  profilerRows,
  replication: replsetParam === 'member',
  replSetUninitiated: replsetParam === 'uninitiated',
  sharding,
});

createRoot(container).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
