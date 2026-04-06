import type { Locator, Page } from 'playwright-core';
import { applyTriggerAction } from './click-action-executor.js';

export async function applyStructuredGridAction(
  page: Page,
  locator: Locator,
  attempts: string[]
): Promise<boolean> {
  return applyTriggerAction(page, locator, attempts);
}
