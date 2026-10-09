import {
  ActionIcon,
  Accordion,
  Button,
  Checkbox,
  Fieldset,
  Group,
  Input,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { READ_PREFERENCES, type ReadPreference, type UriForm } from './uri-form';

export interface ConnectionFormProps {
  readonly form: UriForm;
  readonly onChange: (patch: Partial<UriForm>) => void;
}

function replaceAt(items: readonly string[], index: number, value: string): string[] {
  return items.map((item, position) => (position === index ? value : item));
}

function asReadPreference(value: string | null): ReadPreference | undefined {
  return READ_PREFERENCES.find((preference) => preference === value);
}

/** Editable URI fields, grouped as Server, Authentication, Options and a collapsed TLS section. */
export function ConnectionForm({ form, onChange }: ConnectionFormProps) {
  const tlsInUse =
    form.tls.enabled ||
    form.tls.caFile !== '' ||
    form.tls.certFile !== '' ||
    form.tls.allowInvalidCertificates;

  return (
    <Stack gap="sm">
      <Fieldset legend="Server" radius="sm">
        <Stack gap="xs">
          <SegmentedControl
            aria-label="Scheme"
            value={form.scheme}
            onChange={(value) =>
              onChange({ scheme: value === 'mongodb+srv' ? 'mongodb+srv' : 'mongodb' })
            }
            data={['mongodb', 'mongodb+srv']}
          />
          <Stack gap={4}>
            <Input.Label>Hosts</Input.Label>
            {form.hosts.map((host, index) => (
              <Group key={index} gap={4} wrap="nowrap">
                <TextInput
                  flex={1}
                  aria-label={`Host ${index + 1}`}
                  placeholder="localhost:27017"
                  value={host}
                  onChange={(event) =>
                    onChange({ hosts: replaceAt(form.hosts, index, event.currentTarget.value) })
                  }
                />
                <ActionIcon
                  aria-label={`Remove host ${index + 1}`}
                  disabled={form.hosts.length === 1}
                  onClick={() =>
                    onChange({ hosts: form.hosts.filter((_, position) => position !== index) })
                  }
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            ))}
            <Button
              size="xs"
              variant="subtle"
              w="fit-content"
              leftSection={<IconPlus size={14} />}
              onClick={() => onChange({ hosts: [...form.hosts, ''] })}
            >
              Add host
            </Button>
          </Stack>
        </Stack>
      </Fieldset>

      <Fieldset legend="Authentication" radius="sm">
        <Stack gap="xs">
          <Group grow align="flex-start">
            <TextInput
              label="User name"
              value={form.username}
              onChange={(event) => onChange({ username: event.currentTarget.value })}
            />
            <PasswordInput
              label="Password"
              value={form.password}
              onChange={(event) => onChange({ password: event.currentTarget.value })}
            />
          </Group>
          <Group grow align="flex-start">
            <TextInput
              label="Auth database"
              placeholder="Defaults to the default database"
              value={form.authSource}
              onChange={(event) => onChange({ authSource: event.currentTarget.value })}
            />
            <TextInput
              label="Default database"
              value={form.database}
              onChange={(event) => onChange({ database: event.currentTarget.value })}
            />
          </Group>
        </Stack>
      </Fieldset>

      <Fieldset legend="Options" radius="sm">
        <Group grow align="flex-start">
          <TextInput
            label="Replica set name"
            value={form.replicaSet}
            onChange={(event) => onChange({ replicaSet: event.currentTarget.value })}
          />
          <Select
            label="Read preference"
            data={[...READ_PREFERENCES]}
            value={form.readPreference ?? null}
            onChange={(value) => onChange({ readPreference: asReadPreference(value) })}
            clearable
          />
          <NumberInput
            label="Connect timeout (ms)"
            min={1}
            allowDecimal={false}
            value={form.connectTimeoutMs ?? ''}
            onChange={(value) =>
              onChange({ connectTimeoutMs: typeof value === 'number' ? value : undefined })
            }
          />
        </Group>
      </Fieldset>

      <Accordion variant="contained" radius="sm" defaultValue={tlsInUse ? 'tls' : null}>
        <Accordion.Item value="tls">
          <Accordion.Control>TLS</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              <Switch
                label="Use TLS"
                checked={form.tls.enabled}
                onChange={(event) =>
                  onChange({ tls: { ...form.tls, enabled: event.currentTarget.checked } })
                }
              />
              <TextInput
                label="CA file path"
                value={form.tls.caFile}
                onChange={(event) =>
                  onChange({ tls: { ...form.tls, caFile: event.currentTarget.value } })
                }
              />
              <TextInput
                label="Client certificate file path"
                value={form.tls.certFile}
                onChange={(event) =>
                  onChange({ tls: { ...form.tls, certFile: event.currentTarget.value } })
                }
              />
              <Checkbox
                label="Allow invalid certificates"
                checked={form.tls.allowInvalidCertificates}
                onChange={(event) =>
                  onChange({
                    tls: { ...form.tls, allowInvalidCertificates: event.currentTarget.checked },
                  })
                }
              />
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Stack>
  );
}
