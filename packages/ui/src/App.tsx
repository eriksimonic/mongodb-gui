import { useState } from 'react';

const browserFallbackMessage = 'not available in browser';

export function App() {
  const [status, setStatus] = useState('');

  async function handlePing() {
    const api = window.mongoGui;
    if (api === undefined) {
      setStatus(browserFallbackMessage);
      return;
    }
    try {
      setStatus(await api.ping());
    } catch (error) {
      setStatus(`ping failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <main>
      <h1>Mongo GUI</h1>
      <button type="button" onClick={() => void handlePing()}>
        Ping main
      </button>
      {status === '' ? null : <p role="status">{status}</p>}
    </main>
  );
}
