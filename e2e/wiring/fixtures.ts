import { test as base, expect } from '@playwright/test';
import { installBridge } from './bridge';
import {
  loadRouterModules,
  startWiringServer,
  type RouterModules,
  type UnexpectedOutcome,
} from './server';
import { mongoUriFromEnv } from '../support/mongo';

interface WiringFixtures {
  wiring: {
    readonly url: string;
    readonly unexpectedOutcomes: UnexpectedOutcome[];
    /** Queues paths for the next file dialogs. Empty cancels. */
    setDialogPicks(paths: readonly string[]): void;
  };
  /** Uses the host docker engine instead of a missing socket. Set with test.use in docker journeys. */
  realDocker: boolean;
  /** Automatic. Fails the test on page errors, console errors, 4xx or 5xx, or unexpected outcomes. */
  pageChecks: undefined;
}

interface WorkerFixtures {
  routerModules: RouterModules;
}

export const test = base.extend<WiringFixtures, WorkerFixtures>({
  // One Vite loader per worker. Each test still gets its own router, see wiring below.
  routerModules: [
    // Playwright needs the object pattern here, even with no fixtures to read.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const loader = await loadRouterModules();
      await use(loader.modules);
      await loader.close();
    },
    { scope: 'worker' },
  ],

  realDocker: [false, { option: true }],

  wiring: async ({ routerModules, realDocker }, use) => {
    const server = await startWiringServer({
      modules: routerModules,
      mongoUri: mongoUriFromEnv(),
      realDocker,
    });
    await use({
      url: server.url,
      unexpectedOutcomes: server.unexpectedOutcomes,
      setDialogPicks: (paths) => server.setDialogPicks(paths),
    });
    await server.stop();
  },

  pageChecks: [
    async ({ page, wiring }, use) => {
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      const badResponses: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(`${message.text()} (${message.location().url})`);
        }
      });
      page.on('response', (response) => {
        if (response.status() >= 400) {
          badResponses.push(`${response.status()} ${response.url()}`);
        }
      });
      await page.addInitScript(installBridge);

      await use(undefined);

      expect(pageErrors, 'uncaught errors in the page').toEqual([]);
      expect(consoleErrors, 'console errors in the page').toEqual([]);
      expect(badResponses, 'responses with status 400 or more').toEqual([]);
      expect(
        wiring.unexpectedOutcomes,
        'RPC calls that returned INTERNAL, or that the router rejected as unknown or invalid',
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
