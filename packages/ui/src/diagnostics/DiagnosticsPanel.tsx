import { Stack, Tabs } from '@mantine/core';
import { useState } from 'react';
import { useUiApi } from '../api/ui-api';
import { HostBuildTab } from './HostBuildTab';
import { LogsTab } from './LogsTab';
import { ParametersTab } from './ParametersTab';
import { PoolsTab } from './PoolsTab';
import { ServerStatusTab } from './ServerStatusTab';
import { SessionsTab } from './SessionsTab';
import { TopTab } from './TopTab';
import { createDiagnosticsStore } from './diagnostics-store';

export type DiagnosticsTab =
  'logs' | 'warnings' | 'parameters' | 'status' | 'host' | 'top' | 'pools' | 'sessions';

export interface DiagnosticsPanelProps {
  readonly connectionId: string;
  readonly initialTab?: DiagnosticsTab | undefined;
}

/** The server diagnostics of one connection: logs, parameters, status, host, top, pools, sessions. */
export function DiagnosticsPanel({ connectionId, initialTab = 'logs' }: DiagnosticsPanelProps) {
  const { rpc } = useUiApi();
  const [store] = useState(() => createDiagnosticsStore({ connectionId }, rpc.diagnostics));
  const [tab, setTab] = useState<DiagnosticsTab>(initialTab);

  return (
    <Stack gap={0} h="100%">
      <Tabs
        value={tab}
        onChange={(value) => setTab(toTab(value))}
        styles={{ panel: { flex: 1, minHeight: 0, overflow: 'auto' } }}
      >
        <Tabs.List px="sm" pt="xs">
          <Tabs.Tab value="logs">Logs</Tabs.Tab>
          <Tabs.Tab value="warnings">Startup warnings</Tabs.Tab>
          <Tabs.Tab value="parameters">Parameters</Tabs.Tab>
          <Tabs.Tab value="status">Server status</Tabs.Tab>
          <Tabs.Tab value="host">Host and build</Tabs.Tab>
          <Tabs.Tab value="top">Top</Tabs.Tab>
          <Tabs.Tab value="pools">Connection pools</Tabs.Tab>
          <Tabs.Tab value="sessions">Sessions</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="logs">
          {tab === 'logs' ? <LogsTab store={store} kind="global" /> : null}
        </Tabs.Panel>
        <Tabs.Panel value="warnings">
          {tab === 'warnings' ? <LogsTab store={store} kind="startupWarnings" /> : null}
        </Tabs.Panel>
        <Tabs.Panel value="parameters">
          {tab === 'parameters' ? <ParametersTab store={store} /> : null}
        </Tabs.Panel>
        <Tabs.Panel value="status">
          {tab === 'status' ? <ServerStatusTab store={store} /> : null}
        </Tabs.Panel>
        <Tabs.Panel value="host">
          {tab === 'host' ? <HostBuildTab store={store} /> : null}
        </Tabs.Panel>
        <Tabs.Panel value="top">{tab === 'top' ? <TopTab store={store} /> : null}</Tabs.Panel>
        <Tabs.Panel value="pools">{tab === 'pools' ? <PoolsTab store={store} /> : null}</Tabs.Panel>
        <Tabs.Panel value="sessions">
          {tab === 'sessions' ? <SessionsTab store={store} /> : null}
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

const TABS: readonly DiagnosticsTab[] = [
  'logs',
  'warnings',
  'parameters',
  'status',
  'host',
  'top',
  'pools',
  'sessions',
];

function toTab(value: string | null): DiagnosticsTab {
  const found = TABS.find((tab) => tab === value);
  return found ?? 'logs';
}
