import { Button, Checkbox, Group, Modal, PasswordInput, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { DeviceKeyAvailability } from '@mongo-gui/core';
import { useEffect, useState, type FormEvent } from 'react';
import { errorText, runReported } from '../kit/notify-error';
import { DeviceKeyNotice } from '../screens/DeviceKeyNotice';
import { invalidInputStyles } from '../screens/field-state';
import { useAppStore } from '../state/app-store-context';

export interface RemovePasswordModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  /** Runs after the master password is removed. */
  readonly onDone: () => void;
}

/** Switches a vault from a master password to machine encryption. */
export function RemovePasswordModal({ opened, onClose, onDone }: RemovePasswordModalProps) {
  return (
    <Modal opened={opened} onClose={onClose} title="Remove master password" size="sm" centered>
      {opened ? <RemovePasswordForm onClose={onClose} onDone={onDone} /> : null}
    </Modal>
  );
}

interface FormProps {
  readonly onClose: () => void;
  readonly onDone: () => void;
}

function RemovePasswordForm({ onClose, onDone }: FormProps) {
  const removePassword = useAppStore((state) => state.removePassword);
  const deviceKeyAvailability = useAppStore((state) => state.deviceKeyAvailability);
  const [availability, setAvailability] = useState<DeviceKeyAvailability | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [checkedOnce, setCheckedOnce] = useState(false);
  const [current, setCurrent] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  useEffect(() => {
    void runReported(async () => setAvailability(await deviceKeyAvailability()));
  }, [deviceKeyAvailability]);

  // The button waits for a positive check, so a missing key cannot be used to remove the password.
  const ready = availability?.available === true;
  const currentError =
    submitted && current === '' ? 'Enter the current master password.' : undefined;

  async function checkAgain() {
    setChecking(true);
    await runReported(async () => setAvailability(await deviceKeyAvailability()));
    setCheckedOnce(true);
    setChecking(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (busy || !ready || !acknowledged || current === '') {
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      await removePassword(current);
      notifications.show({
        title: 'Master password removed',
        message: 'The app opens without a password on this computer.',
      });
      onDone();
      onClose();
    } catch (error) {
      // The server gives the reason, for example a wrong master password.
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate>
      <Stack gap="sm">
        <Text size="sm">
          The data opens only for this user on this computer. If you reinstall the system, lose your
          user profile or copy the data folder elsewhere, the data cannot be opened and the only way
          out is a reset. Use connection export files to move connections to another computer.
        </Text>
        {availability === undefined || availability.available ? null : (
          <DeviceKeyNotice
            availability={availability}
            onCheckAgain={() => void checkAgain()}
            checking={checking}
            checkedOnce={checkedOnce}
          />
        )}
        <PasswordInput
          label="Current master password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => setCurrent(event.currentTarget.value)}
          error={currentError}
          styles={invalidInputStyles(currentError)}
        />
        <Checkbox
          label="I understand that this data cannot be moved or recovered."
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.currentTarget.checked)}
        />
        {failure === undefined ? null : (
          <Text size="sm" c="red" role="alert">
            {failure}
          </Text>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!ready || !acknowledged}>
            Remove password
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
