import type { Page } from '@playwright/test';
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const outputRoot = resolve(import.meta.dirname, '..', 'output');
const docsScreenshotDir = resolve(import.meta.dirname, '..', '..', 'docs', 'screenshots');

/** README screenshots that the smoke run refreshes when E2E_UPDATE_DOCS=1. */
export type DocsScreenshot = 'connection-tree.png' | 'unlock.png';

/**
 * Saves `e2e/output/<spec>/<step>.png`. With E2E_UPDATE_DOCS=1 and a docs name, the same image
 * also replaces that file under docs/screenshots.
 */
export async function captureStep(
  page: Page,
  spec: string,
  step: string,
  docs?: DocsScreenshot,
): Promise<void> {
  const specDir = join(outputRoot, spec);
  await mkdir(specDir, { recursive: true });
  const file = join(specDir, `${step}.png`);
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
  if (docs !== undefined && process.env['E2E_UPDATE_DOCS'] === '1') {
    await copyFile(file, join(docsScreenshotDir, docs));
  }
}
