import { Badge, Stack, Tabs } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
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
  const loadLog = useStore(store, (state) => state.loadLog);
  const warningCount = useStore(store, (state) => state.logs.startupWarnings.data?.total);

  // The tab label shows the count, so the warnings load before the tab opens.
  useEffect(() => {
    void loadLog('startupWarnings');
  }, [loadLog]);

  return (
    <Stack gap={0} h="100%">
      <Tabs
        value={tab}
        onChange={(value) => setTab(toTab(value))}
        styles={{
          root: { height: '100%', display: 'flex', flexDirection: 'column' },
          panel: { flex: 1, minHeight: 0, overflow: 'auto' },
        }}
      >
        <Tabs.List px="md" pt="sm">
          <Tabs.Tab value="logs">Logs</Tabs.Tab>
          <Tabs.Tab
            value="warnings"
            rightSection={
              warningCount === undefined || warningCount === 0 ? null : (
                <Badge size="sm" variant="light" color="orange">
                  {warningCount}
                </Badge>
              )
            }
          >
            Startup warnings
          </Tabs.Tab>
          <Tabs.Tab value="parameters">Parameters</Tabs.Tab>
          <Tabs.Tab value="status">Server status</Tabs.Tab>
          <Tabs.Tab value="host">Host and build</Tabs.Tab>
          <Tabs.Tab value="top">Top</Tabs.Tab>
          <Tabs.Tab value="pools">Connection pools</Tabs.Tab>
          <Tabs.Tab value="sessions">Sessions</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="logs" style={FILL}>
          {tab === 'logs' ? (
            <LogsTab store={store} connectionId={connectionId} kind="global" />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="warnings" style={FILL}>
          {tab === 'warnings' ? (
            <LogsTab store={store} connectionId={connectionId} kind="startupWarnings" />
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="parameters" style={FILL}>
          {tab === 'parameters' ? <ParametersTab store={store} /> : null}
        </Tabs.Panel>
        <Tabs.Panel value="status" style={FILL}>
          {tab === 'status' ? <ServerStatusTab store={store} /> : null}
        </Tabs.Panel>
        <Tabs.Panel value="host" style={FILL}>
          {tab === 'host' ? <HostBuildTab store={store} /> : null}
        </Tabs.Panel>
        <Tabs.Panel value="top" style={FILL}>
          {tab === 'top' ? <TopTab store={store} /> : null}
        </Tabs.Panel>
        <Tabs.Panel value="pools" style={FILL}>
          {tab === 'pools' ? <PoolsTab store={store} /> : null}
        </Tabs.Panel>
        <Tabs.Panel value="sessions" style={FILL}>
          {tab === 'sessions' ? <SessionsTab store={store} /> : null}
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

/** Lets a tab fill the panel height, so a long list uses the room under the tab bar. */
const FILL = { display: 'flex', flexDirection: 'column' } as const;

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
