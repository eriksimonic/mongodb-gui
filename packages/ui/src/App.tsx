import { Alert, Center, Loader } from '@mantine/core';
import { AppRoot } from './AppRoot';
import type { UiApi } from './api/ui-api';
import { FirstRunScreen } from './screens/FirstRunScreen';
import { ShellScreen } from './screens/ShellScreen';
import { UnlockScreen } from './screens/UnlockScreen';
import { useAppStore } from './state/app-store-context';

export interface AppProps {
  readonly api: UiApi;
}

/** The application. Picks the screen from the vault state. A `vault:locked` event returns to unlock. */
export function App({ api }: AppProps) {
  return (
    <AppRoot api={api}>
      <VaultScreen />
    </AppRoot>
  );
}

function VaultScreen() {
  const vault = useAppStore((state) => state.vault);
  if (vault === 'loading') {
    return (
      <Center mih="100vh">
        <Loader aria-label="Loading" />
      </Center>
    );
  }
  if (vault === 'failed') {
    return (
      <Center mih="100vh" p="md">
        <Alert color="red" title="Cannot read the vault" maw={420}>
          The app backend did not answer. Restart the app.
        </Alert>
      </Center>
    );
  }
  if (vault === 'uninitialised') {
    return <FirstRunScreen />;
  }
  if (vault === 'locked') {
    return <UnlockScreen />;
  }
  return <ShellScreen />;
}
