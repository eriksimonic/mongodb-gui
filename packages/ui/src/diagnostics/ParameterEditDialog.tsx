import { Button, Group, Modal, NumberInput, Select, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import type { ServerParameter } from '@mongo-gui/core';
import { ConfirmDialog } from '../kit/ConfirmDialog';
import { valueText, type ParameterValue } from './parameter-search';

export interface ParameterEditDialogProps {
  readonly parameter: ServerParameter;
  readonly current: ParameterValue;
  readonly onSet: (name: string, value: ParameterValue) => Promise<void>;
  readonly onClose: () => void;
}

/**
 * Edits one parameter. The first step takes the new value. The second step names the change and
 * asks for confirmation before anything reaches the server.
 */
export function ParameterEditDialog({
  parameter,
  current,
  onSet,
  onClose,
}: ParameterEditDialogProps) {
  const [value, setValue] = useState<ParameterValue>(current);
  const [confirming, setConfirming] = useState(false);
  const changed = value !== current && !(typeof value === 'number' && Number.isNaN(value));

  if (confirming) {
    return (
      <ConfirmDialog
        title={`Set ${parameter.name}`}
        description={
          <>
            Change {parameter.name} from <b>{valueText(parameter)}</b> to <b>{String(value)}</b> on
            this server. The change takes effect now and lasts until the server restarts.
          </>
        }
        confirmLabel="Set value"
        confirmColor="yellow"
        onConfirm={() => onSet(parameter.name, value)}
        onClose={onClose}
      />
    );
  }

  return (
    <Modal opened onClose={onClose} title={`Edit ${parameter.name}`} centered size={440}>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Current value: {valueText(parameter)}
        </Text>
        {typeof current === 'boolean' ? (
          <Select
            label="Value"
            allowDeselect={false}
            data={[
              { value: 'true', label: 'true' },
              { value: 'false', label: 'false' },
            ]}
            value={String(value)}
            onChange={(next) => setValue(next === 'true')}
          />
        ) : typeof current === 'number' ? (
          <NumberInput
            label="Value"
            value={typeof value === 'number' ? value : current}
            onChange={(next) => setValue(typeof next === 'number' ? next : Number.NaN)}
          />
        ) : (
          <TextInput
            label="Value"
            value={String(value)}
            onChange={(event) => setValue(event.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!changed} onClick={() => setConfirming(true)}>
            Review change
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
