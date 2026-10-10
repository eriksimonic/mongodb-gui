import { Code, Group, Stack, Text } from '@mantine/core';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { CopyIcon, KeyValueTable, LoadState, RefreshButton, Section } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import { formatBytes, formatCount } from './format';

export interface HostBuildTabProps {
  readonly store: DiagnosticsStore;
}

const MIB = 1024 * 1024;

/** The host, the build and the command line the server started with. */
export function HostBuildTab({ store }: HostBuildTabProps) {
  const state = useStore(store, (current) => current.hostAndBuild);
  const load = useStore(store, (current) => current.loadHostAndBuild);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Stack gap="md" p="sm">
      <Group>
        <RefreshButton loading={state.loading} onRefresh={() => void load()} />
      </Group>
      <LoadState state={state}>
        {({ host, build, cmdLine }) => {
          const parsed = JSON.stringify(cmdLine.parsed, null, 2) ?? '';
          return (
            <>
              <Section title="Host">
                <KeyValueTable
                  rows={[
                    { label: 'Host name', value: host.hostname },
                    { label: 'Operating system', value: host.os?.name },
                    { label: 'OS version', value: host.os?.version },
                    { label: 'CPU architecture', value: host.cpu?.arch },
                    {
                      label: 'Cores',
                      value:
                        host.cpu?.cores === undefined ? undefined : formatCount(host.cpu.cores),
                    },
                    {
                      label: 'Memory',
                      value:
                        host.memSizeMb === undefined
                          ? undefined
                          : formatBytes(host.memSizeMb * MIB),
                    },
                    {
                      label: 'NUMA',
                      value:
                        host.numaEnabled === undefined
                          ? undefined
                          : host.numaEnabled
                            ? 'Yes'
                            : 'No',
                    },
                  ]}
                />
              </Section>
              <Section title="Build">
                <KeyValueTable
                  rows={[
                    { label: 'Version', value: build.version },
                    { label: 'Git version', value: build.gitVersion },
                    { label: 'Allocator', value: build.allocator },
                    { label: 'JavaScript engine', value: build.javascriptEngine },
                    { label: 'Bits', value: build.bits },
                    {
                      label: 'Max BSON object size',
                      value:
                        build.maxBsonObjectSize === undefined
                          ? undefined
                          : formatBytes(build.maxBsonObjectSize),
                    },
                    { label: 'Storage engines', value: build.storageEngines.join(', ') },
                    { label: 'Modules', value: build.modules.join(', ') },
                  ]}
                />
              </Section>
              <Section title="Command line">
                <Group gap="xs" mb={4}>
                  <Text size="xs" c="dimmed">
                    Arguments
                  </Text>
                  <CopyIcon text={cmdLine.argv.join(' ')} label="Copy arguments" />
                </Group>
                <Code block fz="xs">
                  {cmdLine.argv.join(' ') || '(none)'}
                </Code>
                <Group gap="xs" mt="xs" mb={4}>
                  <Text size="xs" c="dimmed">
                    Parsed options, with secrets masked
                  </Text>
                  <CopyIcon text={parsed} label="Copy parsed options" />
                </Group>
                <Code block fz="xs">
                  {parsed}
                </Code>
              </Section>
            </>
          );
        }}
      </LoadState>
    </Stack>
  );
}
