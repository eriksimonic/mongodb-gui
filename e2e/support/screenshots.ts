import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const outputRoot = resolve(import.meta.dirname, '..', 'output');

/** Saves `e2e/output/<spec>/<step>.png`. The docs screenshots are a fixed set, see CLAUDE.md. */
export async function captureStep(page: Page, spec: string, step: string): Promise<void> {
  const specDir = join(outputRoot, spec);
  await mkdir(specDir, { recursive: true });
  const file = join(specDir, `${step}.png`);
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
}
