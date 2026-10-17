import {
  ActionIcon,
  Button,
  Checkbox,
  Box,
  Group,
  Input,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Tabs,
  Switch,
  TextInput,
  Tooltip,
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

/** Editable URI fields in Server, Authentication, TLS and Advanced tabs. */
export function ConnectionForm({ form, onChange }: ConnectionFormProps) {
  const tlsInUse =
    form.tls.enabled ||
    form.tls.caFile !== '' ||
    form.tls.certFile !== '' ||
    form.tls.allowInvalidCertificates;

  return (
    <Tabs defaultValue="server" keepMounted>
      <Tabs.List mb="lg">
        <Tabs.Tab value="server">Server</Tabs.Tab>
        <Tabs.Tab value="auth">Authentication</Tabs.Tab>
        <Tabs.Tab
          value="tls"
          rightSection={
            tlsInUse ? (
              <Box
                w={6}
                h={6}
                aria-label="TLS enabled"
                style={{ borderRadius: '50%', background: 'var(--mg-ok)' }}
              />
            ) : null
          }
        >
          TLS
        </Tabs.Tab>
        <Tabs.Tab value="advanced">Advanced</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="server">
        <Stack gap="lg">
          <SegmentedControl
            aria-label="Scheme"
            value={form.scheme}
            onChange={(value) =>
              onChange({ scheme: value === 'mongodb+srv' ? 'mongodb+srv' : 'mongodb' })
            }
            data={['mongodb', 'mongodb+srv']}
          />
          <Stack gap="sm">
            <Input.Label>Hosts</Input.Label>
            {form.hosts.map((host, index) => (
              <Group key={index} gap={4} wrap="nowrap">
                <TextInput
                  flex={1}
                  aria-label={`Host ${index + 1}`}
                  placeholder="localhost:27017"
                  styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                  value={host}
                  onChange={(event) =>
                    onChange({ hosts: replaceAt(form.hosts, index, event.currentTarget.value) })
                  }
                />
                <ActionIcon
                  variant="default"
                  size={36}
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
          <SimpleGrid cols={2} spacing="lg">
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
            <TextInput
              label="Default database"
              value={form.database}
              onChange={(event) => onChange({ database: event.currentTarget.value })}
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
          </SimpleGrid>
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="auth">
        <Stack gap="lg">
          <SimpleGrid cols={2} spacing="lg">
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
          </SimpleGrid>
          <TextInput
            label="Auth database"
            placeholder="Defaults to the default database"
            value={form.authSource}
            onChange={(event) => onChange({ authSource: event.currentTarget.value })}
          />
        </Stack>
      </Tabs.Panel>

      <Tabs.Panel value="tls">
        <Stack gap="lg">
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
      </Tabs.Panel>

      <Tabs.Panel value="advanced">
        <Tooltip
          multiline
          w={280}
          label="Compress traffic with zlib (compressors=zlib). Saves bandwidth on slow links, costs some CPU. The server must allow it. Snappy and zstd are not bundled."
        >
          <Switch
            label="Compress traffic (zlib)"
            checked={form.zlibCompression}
            onChange={(event) => onChange({ zlibCompression: event.currentTarget.checked })}
          />
        </Tooltip>
      </Tabs.Panel>
    </Tabs>
  );
}
