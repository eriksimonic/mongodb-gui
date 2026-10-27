import { Anchor, Button, Stack, Text } from '@mantine/core';
import type { DeviceKeyAvailability } from '@mongo-gui/core';
import { useUiApi } from '../api/ui-api';
import { runReported } from '../kit/notify-error';
import { KEYRING_HELP_URL } from '../settings/links';

const REASON_TEXT = {
  'basic-text':
    'No keyring is running, so Linux would keep the key in plain text. Set up GNOME Keyring or KWallet, then restart the app.',
  'unknown-backend':
    'The app could not tell which keyring this Linux desktop uses. Set up GNOME Keyring or KWallet, then restart the app.',
  'no-encryption':
    'This system offers no key storage for your user account. On Linux, set up GNOME Keyring or KWallet, then restart the app.',
} as const;

export interface DeviceKeyNoticeProps {
  readonly availability: DeviceKeyAvailability;
  readonly onCheckAgain: () => void;
  readonly checking: boolean;
  readonly checkedOnce: boolean;
}

/** Explains why machine encryption is unavailable, with a link to the keyring setup page and a re-check button. */
export function DeviceKeyNotice({
  availability,
  onCheckAgain,
  checking,
  checkedOnce,
}: DeviceKeyNoticeProps) {
  const { rpc } = useUiApi();
  if (availability.available) {
    return null;
  }

  const reason = availability.reason ?? 'no-encryption';
  return (
    <Stack gap="xs">
      <Text size="sm">{REASON_TEXT[reason]}</Text>
      {checkedOnce ? (
        <Text size="sm">
          Still not available. Linux picks the keyring when the app starts, so restart the app after
          you set one up.
        </Text>
      ) : null}
      <Stack gap={6} align="flex-start">
        <Anchor
          href={KEYRING_HELP_URL}
          size="sm"
          onClick={(event) => {
            event.preventDefault();
            void runReported(() => rpc.app.openExternal({ url: KEYRING_HELP_URL }));
          }}
        >
          How to set up a keyring
        </Anchor>
        <Button variant="default" size="xs" loading={checking} onClick={onCheckAgain}>
          Check again
        </Button>
      </Stack>
    </Stack>
  );
}
