import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@mongo-gui/ui';
import { createElectronUiApi } from './electron-ui-api';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('Missing #root element in index.html');
}

const api = createElectronUiApi();

createRoot(container).render(
  <StrictMode>
    <App api={api} />
  </StrictMode>,
);
