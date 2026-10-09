import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, createMockUiApi } from '@mongo-gui/ui';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element in index.html');
}

// Temporary until P1-4 wires the Electron RPC client.
const api = createMockUiApi({ preset: 'fresh' });

createRoot(container).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
