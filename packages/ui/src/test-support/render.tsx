// The shims come first. uPlot reads matchMedia when its module loads, and App imports uPlot.
import './browser-shims';
import '@testing-library/jest-dom/vitest';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { App } from '../App';
import { AppRoot } from '../AppRoot';
import { createMockUiApi, type MockUiApiOptions } from '../api/mock-rpc-client';
import type { UiApi } from '../api/ui-api';
import type { AppData } from '../state/app-store';

export interface RenderWithAppOptions {
  readonly mock?: MockUiApiOptions | undefined;
  readonly api?: UiApi | undefined;
  readonly initialState?: Partial<AppData> | undefined;
}

/** Renders a node inside the app providers, backed by the mock api unless one is passed. */
export function renderWithApp(
  ui: ReactElement,
  options: RenderWithAppOptions = {},
): RenderResult & { readonly api: UiApi } {
  const api = options.api ?? createMockUiApi(options.mock);
  const result = render(
    <AppRoot api={api} initialState={options.initialState}>
      {ui}
    </AppRoot>,
  );
  return { ...result, api };
}

export interface RenderAppOptions {
  readonly mock?: MockUiApiOptions | undefined;
  readonly api?: UiApi | undefined;
}

/** Renders the whole application, the same way the browser entry does. */
export function renderApp(options: RenderAppOptions = {}): RenderResult & { readonly api: UiApi } {
  const api = options.api ?? createMockUiApi(options.mock);
  return { ...render(<App api={api} />), api };
}
