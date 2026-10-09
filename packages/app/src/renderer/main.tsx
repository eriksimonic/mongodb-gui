import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@mongo-gui/ui';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element in index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
