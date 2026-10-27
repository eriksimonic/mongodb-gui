import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createMockUiApi } from './api/mock-rpc-client';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element in index.html');
}

// ?preset=unlocked starts unlocked with fixtures. device and device-locked start with machine
// encryption, unlocked or locked. Any other value starts on the first-run screen.
const presetParam = new URLSearchParams(window.location.search).get('preset');
const preset =
  presetParam === 'unlocked' || presetParam === 'device' || presetParam === 'device-locked'
    ? presetParam
    : 'fresh';
// ?devicekey=basic-text, no-encryption or unknown-backend makes machine encryption unavailable.
const deviceKeyParam = new URLSearchParams(window.location.search).get('devicekey');
const deviceKey =
  deviceKeyParam === 'no-encryption' ||
  deviceKeyParam === 'basic-text' ||
  deviceKeyParam === 'unknown-backend'
    ? deviceKeyParam
    : 'available';
// ?deviceunlock=fail makes unlocking a machine-encrypted vault fail, as an unreadable keyring would.
const deviceUnlock =
  new URLSearchParams(window.location.search).get('deviceunlock') === 'fail' ? 'fail' : 'ok';
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
// ?tools=missing, mismatch or broken picks the MongoDB Database Tools the mock has. Default is ok.
const toolsParam = new URLSearchParams(window.location.search).get('tools');
const tools =
  toolsParam === 'missing' || toolsParam === 'mismatch' || toolsParam === 'broken'
    ? toolsParam
    : 'ok';
const api = createMockUiApi({
  preset,
  latencyMs: 120,
  profilerRows,
  replication: replsetParam === 'member',
  replSetUninitiated: replsetParam === 'uninitiated',
  sharding,
  tools,
  deviceKey,
  deviceUnlock,
});

createRoot(container).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
