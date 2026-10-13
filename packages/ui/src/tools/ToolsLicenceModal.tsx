import { Modal, ScrollArea, Stack, Text, Title } from '@mantine/core';
import type { ToolsInstallId, ToolsLicenceOutput } from '@mongo-gui/core';
import { useEffect, useState } from 'react';
import { useUiApi } from '../api/ui-api';
import { runReported } from '../kit/notify-error';

interface ToolsLicenceModalProps {
  /** The install whose licence is shown. The modal is closed while this is undefined. */
  readonly installId: ToolsInstallId | undefined;
  readonly onClose: () => void;
}

/** The licence and third-party notices that ship with a tools install. */
export function ToolsLicenceModal({ installId, onClose }: ToolsLicenceModalProps) {
  return (
    <Modal
      opened={installId !== undefined}
      onClose={onClose}
      title="MongoDB Database Tools licence"
      size="lg"
      centered
    >
      {installId === undefined ? null : <LicenceBody installId={installId} />}
    </Modal>
  );
}

function LicenceBody({ installId }: { readonly installId: ToolsInstallId }) {
  const { rpc } = useUiApi();
  const [licence, setLicence] = useState<ToolsLicenceOutput | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void runReported(async () => {
      const loaded = await rpc.tools.licence({ id: installId });
      if (active) {
        setLicence(loaded);
      }
    });
    return () => {
      active = false;
    };
  }, [rpc, installId]);

  if (licence === undefined) {
    return (
      <Text size="sm" c="dimmed">
        Loading licence
      </Text>
    );
  }
  return (
    <ScrollArea.Autosize mah={420}>
      <Stack gap="md">
        <Text size="sm" fw={600}>
          Version {licence.version}
        </Text>
        <Text size="xs" ff="monospace" style={{ whiteSpace: 'pre-wrap' }}>
          {licence.licence}
        </Text>
        <Title order={6}>Third-party notices</Title>
        <Text size="xs" ff="monospace" style={{ whiteSpace: 'pre-wrap' }}>
          {licence.thirdPartyNotices}
        </Text>
      </Stack>
    </ScrollArea.Autosize>
  );
}
