import { Alert, Button, Checkbox, Group, PasswordInput, Radio, Stack, Text } from '@mantine/core';
import { IconAlertCircle, IconCheck } from '@tabler/icons-react';
import { toAppError, type DeviceKeyAvailability } from '@mongo-gui/core';
import { useEffect, useState, type FormEvent } from 'react';
import { runReported } from '../kit/notify-error';
import { useAppStore } from '../state/app-store-context';
import { CenteredScreen } from './CenteredScreen';
import { DeviceKeyNotice } from './DeviceKeyNotice';
import { invalidInputStyles } from './field-state';
import { PasswordStrengthMeter } from './PasswordStrengthMeter';
import { validateNewPassword } from './password-rules';

type Choice = 'device' | 'password';

export function FirstRunScreen() {
  const initialise = useAppStore((state) => state.initialise);
  const initialiseDevice = useAppStore((state) => state.initialiseDevice);
  const deviceKeyAvailability = useAppStore((state) => state.deviceKeyAvailability);
  const [step, setStep] = useState<'choose' | 'password'>('choose');
  const [choice, setChoice] = useState<Choice | undefined>(undefined);
  const [accepted, setAccepted] = useState(false);
  const [availability, setAvailability] = useState<DeviceKeyAvailability | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [checkedOnce, setCheckedOnce] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  useEffect(() => {
    void runReported(async () => setAvailability(await deviceKeyAvailability()));
  }, [deviceKeyAvailability]);

  const unavailable = availability !== undefined && !availability.available;

  async function checkAgain() {
    setChecking(true);
    await runReported(async () => setAvailability(await deviceKeyAvailability()));
    setCheckedOnce(true);
    setChecking(false);
  }

  async function handleContinue() {
    if (choice === 'password') {
      setStep('password');
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      await initialiseDevice();
    } catch (error) {
      setFailure(toAppError(error).message);
      setBusy(false);
    }
  }

  const errors = validateNewPassword(password, confirmation);
  const shownPassword = submitted ? errors.password : undefined;
  const shownConfirmation = submitted ? errors.confirmation : undefined;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (errors.password !== undefined || errors.confirmation !== undefined) {
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      await initialise(password);
    } catch (error) {
      setFailure(toAppError(error).message);
      setBusy(false);
    }
  }

  if (step === 'choose') {
    return (
      <CenteredScreen title="Choose how to protect your data">
        <Text size="sm" c="dimmed">
          Mongo GUI encrypts your saved connections, passwords and history. Choose what protects the
          key.
        </Text>
        <Radio.Group value={choice ?? null} onChange={(value) => setChoice(value as Choice)}>
          <Stack gap="sm">
            <Radio.Card value="device" disabled={unavailable} p="md" radius="md">
              <Group wrap="nowrap" align="flex-start">
                <Radio.Indicator />
                <Stack gap={4} style={{ opacity: unavailable ? 0.5 : undefined }}>
                  <Text fw={600}>Machine encryption</Text>
                  <Text size="sm" c="dimmed">
                    Your operating system protects the key for your user account on this computer.
                    The app opens without a password.
                  </Text>
                  <Text size="sm" c="dimmed">
                    The data opens only for this user on this computer. If you reinstall the system,
                    lose your user profile or copy the data folder elsewhere, the data cannot be
                    opened and the only way out is a reset. Use connection export files to move
                    connections to another computer.
                  </Text>
                </Stack>
              </Group>
            </Radio.Card>
            {availability !== undefined && unavailable ? (
              <DeviceKeyNotice
                availability={availability}
                onCheckAgain={() => void checkAgain()}
                checking={checking}
                checkedOnce={checkedOnce}
              />
            ) : null}
            <Radio.Card value="password" p="md" radius="md">
              <Group wrap="nowrap" align="flex-start">
                <Radio.Indicator />
                <Stack gap={4}>
                  <Text fw={600}>Password encryption</Text>
                  <Text size="sm" c="dimmed">
                    A master password protects the key. You type it when the app starts and after
                    the idle lock. The data folder can be moved to another computer.
                  </Text>
                </Stack>
              </Group>
            </Radio.Card>
          </Stack>
        </Radio.Group>
        {choice === 'device' ? (
          <Checkbox
            label="I understand that this data cannot be moved or recovered."
            checked={accepted}
            onChange={(event) => setAccepted(event.currentTarget.checked)}
          />
        ) : null}
        {failure === undefined ? null : (
          <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>
            {failure}
          </Alert>
        )}
        <Button
          fullWidth
          loading={busy}
          disabled={choice === undefined || (choice === 'device' && !accepted)}
          onClick={() => void handleContinue()}
        >
          Continue
        </Button>
      </CenteredScreen>
    );
  }

  return (
    <CenteredScreen title="Create master password">
      <Text size="sm" c="dimmed">
        Saved connections are encrypted with this password, and nobody can recover it for you if you
        forget it.
      </Text>
      <form onSubmit={(event) => void handleSubmit(event)} noValidate>
        <Stack gap="sm">
          <PasswordInput
            label="Master password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            styles={invalidInputStyles(shownPassword)}
            aria-invalid={shownPassword !== undefined}
            autoFocus
          />
          {shownPassword === undefined ? null : <Text size="xs">{shownPassword}</Text>}
          <PasswordStrengthMeter password={password} />
          <PasswordInput
            label={
              <Group gap={6} component="span" wrap="nowrap">
                Confirm master password
                {confirmation !== '' && confirmation === password ? (
                  <IconCheck size={14} color="var(--mg-ok)" aria-label="Passwords match" />
                ) : null}
              </Group>
            }
            value={confirmation}
            onChange={(event) => setConfirmation(event.currentTarget.value)}
            styles={invalidInputStyles(shownConfirmation)}
            aria-invalid={shownConfirmation !== undefined}
          />
          {shownConfirmation === undefined ? null : <Text size="xs">{shownConfirmation}</Text>}
          {failure === undefined ? null : (
            <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>
              {failure}
            </Alert>
          )}
          <Group grow>
            <Button type="button" variant="default" onClick={() => setStep('choose')}>
              Back
            </Button>
            <Button type="submit" loading={busy}>
              Create vault
            </Button>
          </Group>
        </Stack>
      </form>
    </CenteredScreen>
  );
}
