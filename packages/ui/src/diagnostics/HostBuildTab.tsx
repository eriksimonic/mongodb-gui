import { Box, Code, Group, SimpleGrid, Text } from '@mantine/core';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { CopyIcon, KeyValueCard, LoadState, ScrollLayout, Toolbar } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import { formatBytes, formatCount } from './format';
import { highlightJson } from './json-highlight';
import { relaxEjson } from './relax-ejson';

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
    <ScrollLayout toolbar={<Toolbar loading={state.loading} onRefresh={() => void load()} />}>
      <LoadState state={state}>
        {({ host, build, cmdLine }) => {
          const parsed = JSON.stringify(relaxEjson(cmdLine.parsed), null, 2) ?? '';
          return (
            <>
              <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                <KeyValueCard
                  title="Host"
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
                <KeyValueCard
                  title="Build"
                  rows={[
                    { label: 'Version', value: build.version },
                    { label: 'Git version', value: build.gitVersion },
                    { label: 'Allocator', value: build.allocator },
                    { label: 'JavaScript engine', value: build.javascriptEngine },
                    {
                      label: 'Bits',
                      value: build.bits === undefined ? undefined : String(build.bits),
                    },
                    { label: 'Debug build', value: debugBuild(build.rawJson) },
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
              </SimpleGrid>
              <Box style={{ border: '1px solid var(--mg-border)', borderRadius: 8 }} p="md">
                <Text fw={600} mb="xs">
                  Command line
                </Text>
                <CodeBlock
                  label="Arguments"
                  text={cmdLine.argv.join(' ') || '(none)'}
                  copy={cmdLine.argv.join(' ')}
                />
                <CodeBlock
                  label="Parsed options, with secrets masked"
                  text={parsed}
                  copy={parsed}
                  json
                />
              </Box>
            </>
          );
        }}
      </LoadState>
    </ScrollLayout>
  );
}

/** Yes or No from the raw buildInfo reply, or undefined when the server does not say. */
function debugBuild(rawJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    const debug = (parsed as { debug?: unknown }).debug;
    return typeof debug === 'boolean' ? (debug ? 'Yes' : 'No') : undefined;
  } catch {
    return undefined;
  }
}

/** A labelled block of code with a copy button, in the same box style as the log attributes. */
function CodeBlock({
  label,
  text,
  copy,
  json = false,
}: {
  readonly label: string;
  readonly text: string;
  readonly copy: string;
  /** Colours the text as JSON. */
  readonly json?: boolean;
}) {
  return (
    <Box mb="sm">
      <Group gap="xs" mb={4}>
        <Text size="xs" c="dimmed">
          {label}
        </Text>
        <CopyIcon text={copy} label={`Copy ${label.toLowerCase()}`} />
      </Group>
      <Code
        block
        fz="xs"
        style={{
          background: 'var(--mg-surface-1)',
          border: '1px solid var(--mg-border)',
          borderRadius: 6,
          padding: '10px 12px',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {json ? highlightJson(text) : text}
      </Code>
    </Box>
  );
}
