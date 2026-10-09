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
const api = createMockUiApi({ preset, latencyMs: 120 });

createRoot(container).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
