/// <reference types="vite/client" />
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import type { ReactNode } from 'react';
import { appTheme } from './theme';

export interface AppProvidersProps {
  readonly children: ReactNode;
}

/** Mantine theme, modal host and notification host. Wraps every screen. */
export function AppProviders({ children }: AppProvidersProps) {
  return (
    <MantineProvider theme={appTheme} defaultColorScheme="dark">
      <ModalsProvider>
        <Notifications position="bottom-right" />
        {children}
      </ModalsProvider>
    </MantineProvider>
  );
}
