import type { Page } from '@playwright/test';
import { MongoClient, type Document } from 'mongodb';
import { expect, test } from '../../fixtures';
import { mongoUriFromEnv } from '../../../support/mongo';

/** Connects Local dev, then opens its Diagnostics panel from the Monitoring submenu. */
async function openDiagnostics(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Connect', exact: true }).click();
  await page.getByRole('treeitem', { name: 'Local dev', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Monitoring', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Diagnostics', exact: true }).click();
}

/** The message of each log line in a getLog reply. The server returns each line as a JSON string. */
function messagesOf(reply: Document): string[] {
  return (reply['log'] as string[]).map((line) => (JSON.parse(line) as { msg: string }).msg);
}

test('logs: a failed sign-in writes lines the search finds', async ({ page, wiring }) => {
  // A user name made up for this test, so the failed sign-in line is ours alone.
  const user = `diag-log-journey-${Date.now()}`;
  const probeUrl = new URL(mongoUriFromEnv());
  probeUrl.username = user;
  probeUrl.password = 'wrong-password';
  // The server rejects the sign-in. The failed sign-in writes three lines that name the user.
  const probe = new MongoClient(probeUrl.toString());
  try {
    await expect(probe.connect()).rejects.toThrow();
  } finally {
    await probe.close();
  }

  const client = new MongoClient(mongoUriFromEnv());
  let lines: string[];
  try {
    lines = (await client.db('admin').command({ getLog: 'global' }))['log'] as string[];
  } finally {
    await client.close();
  }
  // One sign-in writes three lines that name the user: an unknown-user note and two failures.
  // The second failure is the real attempt. The first comes from the speculative auth in the handshake.
  const matching = lines
    .filter((line) => line.includes(user))
    .map((line) => JSON.parse(line) as { msg: string });
  expect(matching.length).toBeGreaterThan(0);

  await openDiagnostics(page, wiring.url);
  await page.getByRole('textbox', { name: 'Search log', exact: true }).fill(user);

  // The search matches attributes too, so only lines naming the user show.
  const grid = page.getByRole('grid', { name: 'Server log lines', exact: true });
  const counts = new Map<string, number>();
  for (const line of matching) {
    counts.set(line.msg, (counts.get(line.msg) ?? 0) + 1);
  }
  for (const [message, count] of counts) {
    await expect(grid.getByRole('gridcell', { name: message, exact: true })).toHaveCount(count);
  }
});

test('warnings: the tab lists the startup warnings the server holds', async ({ page, wiring }) => {
  const client = new MongoClient(mongoUriFromEnv());
  let messages: string[];
  try {
    messages = messagesOf(await client.db('admin').command({ getLog: 'startupWarnings' }));
  } finally {
    await client.close();
  }

  await openDiagnostics(page, wiring.url);
  // The tab shows a count badge once the server holds warnings, so its name is "Startup warnings N".
  await page.getByRole('tab', { name: /^Startup warnings/ }).click();

  // The toolbar counts the lines the tab holds. With no warnings, the count is zero and no line shows.
  const count = messages.length;
  await expect(
    page.getByText(`Showing ${count} of ${count} · logged once at server start`),
  ).toBeVisible();
  const [first] = messages;
  if (first !== undefined) {
    const grid = page.getByRole('grid', { name: 'Server log lines', exact: true });
    await expect(grid.getByRole('gridcell', { name: first, exact: true })).toBeVisible();
  }
});

test('host and build: the version, host name and argv match the server', async ({
  page,
  wiring,
}) => {
  const client = new MongoClient(mongoUriFromEnv());
  let build: Document;
  let host: Document;
  let cmdLine: Document;
  try {
    const admin = client.db('admin');
    build = await admin.command({ buildInfo: 1 });
    host = await admin.command({ hostInfo: 1 });
    cmdLine = await admin.command({ getCmdLineOpts: 1 });
  } finally {
    await client.close();
  }
  const hostname = (host['system'] as { hostname: string }).hostname;
  const argv = cmdLine['argv'] as string[];

  await openDiagnostics(page, wiring.url);
  await page.getByRole('tab', { name: 'Host and build', exact: true }).click();

  // Each label sits in a text block, and its value in the block that follows it.
  const valueOf = (label: string) =>
    page.getByText(label, { exact: true }).locator('xpath=following-sibling::*[1]');
  await expect(valueOf('Version')).toHaveText(build['version'] as string);
  await expect(valueOf('Host name')).toHaveText(hostname);
  // The arguments show as one line, joined with spaces.
  await expect(page.getByText(argv.join(' '), { exact: true })).toBeVisible();
});

test('parameters: a search by name shows the value the server returns', async ({
  page,
  wiring,
}) => {
  const client = new MongoClient(mongoUriFromEnv());
  let value: unknown;
  try {
    const reply = await client.db('admin').command({ getParameter: 1, notablescan: 1 });
    value = reply['notablescan'];
  } finally {
    await client.close();
  }

  await openDiagnostics(page, wiring.url);
  await page.getByRole('tab', { name: 'Parameters', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search parameters', exact: true }).fill('notablescan');

  // The value cell shows the parameter as text, so a boolean reads as true or false.
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'notablescan', exact: true }) });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('cell').nth(1)).toHaveText(String(value));
});

test('server status: the host field shows the value the server returns', async ({
  page,
  wiring,
}) => {
  const client = new MongoClient(mongoUriFromEnv());
  let host: string;
  try {
    const status = await client.db('admin').command({ serverStatus: 1 });
    host = status['host'] as string;
  } finally {
    await client.close();
  }

  await openDiagnostics(page, wiring.url);
  await page.getByRole('tab', { name: 'Server status', exact: true }).click();

  // The top level of the tree lists host with its value as plain text.
  await expect(page.getByText('host', { exact: true })).toBeVisible();
  await expect(page.getByText(host, { exact: true })).toBeVisible();
});
