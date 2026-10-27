import { Anchor, Button, Center, Loader, Stack, Text } from '@mantine/core';
import { toAppError } from '@mongo-gui/core';
import { useEffect, useState } from 'react';
import { useAppStore } from '../state/app-store-context';
import { CenteredScreen } from './CenteredScreen';
import { ResetStoreModal } from './ResetStoreModal';

/** Opens a device-mode vault on mount. If the key cannot be read, offers a retry or a store reset. */
export function DeviceUnlockScreen() {
  const unlockDevice = useAppStore((state) => state.unlockDevice);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    unlockDevice().catch((error: unknown) => {
      setFailure(toAppError(error).message);
      setBusy(false);
    });
  }, [unlockDevice]);

  function retry() {
    setBusy(true);
    setFailure(undefined);
    unlockDevice().catch((error: unknown) => {
      setFailure(toAppError(error).message);
      setBusy(false);
    });
  }

  if (busy) {
    return (
      <Center mih="100vh">
        <Loader aria-label="Opening the vault" />
      </Center>
    );
  }

  return (
    <CenteredScreen title="The vault cannot be opened on this computer">
      <Stack gap="sm">
        <Text size="sm">
          Machine encryption ties the key to this user account on this computer. The key could not
          be read, for example because the data folder came from another computer or user, or the
          keyring was reset. Without the key the saved data cannot be recovered.
        </Text>
        {failure === undefined ? null : (
          <Text size="xs" c="dimmed">
            {failure}
          </Text>
        )}
        <Button fullWidth onClick={retry}>
          Try again
        </Button>
        <Anchor
          component="button"
          type="button"
          size="sm"
          c="var(--mg-link)"
          onClick={() => setResetOpen(true)}
        >
          Reset store
        </Anchor>
      </Stack>
      <ResetStoreModal opened={resetOpen} onClose={() => setResetOpen(false)} />
    </CenteredScreen>
  );
}
