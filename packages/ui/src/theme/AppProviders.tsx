/// <reference types="vite/client" />
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './tokens.css';
import { MantineProvider } from '@mantine/core';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import type { ReactNode } from 'react';
import { appTheme } from './theme';
import type { ColorScheme } from './color-scheme';

export interface AppProvidersProps {
  /** The scheme to render. Mantine forces it, so the app follows the setting, not the OS. */
  readonly colorScheme?: ColorScheme;
  readonly children: ReactNode;
}

// Vitest sets MODE to 'test'. Tests switch off Mantine transitions and portals, so no transition timer
// can outlive the jsdom environment. The app and Storybook keep their defaults.
const inTests = import.meta.env.MODE === 'test';
const testModalProps = inTests ? { transitionProps: { duration: 0 } } : {};
const testNotificationProps = inTests ? { transitionDuration: 0 } : {};

/** Mantine theme, modal host and notification host. Wraps every screen. */
export function AppProviders({ colorScheme = 'dark', children }: AppProvidersProps) {
  return (
    <MantineProvider
      theme={appTheme}
      forceColorScheme={colorScheme}
      env={inTests ? 'test' : 'default'}
    >
      <ModalsProvider modalProps={testModalProps}>
        <Notifications position="bottom-right" {...testNotificationProps} />
        {children}
      </ModalsProvider>
    </MantineProvider>
  );
}
