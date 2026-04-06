import type { Locator, Page } from 'playwright-core';
import {
  LOCATOR_FILL_TIMEOUT_MS,
  applyValueWithJsFallback,
  blurLocator,
  clearLocatorForReplacement,
  deriveMaskedSequentialValue,
  focusLocator,
  normalizeFillValue,
  planTextFillStrategy,
  readLocatorCurrentValue,
} from './action-executor-helpers.js';
import { runActionExecutionGuard, type ActionExecutionGuards } from './action-execution-guards.js';

export async function applyTextFillAction(
  page: Page,
  locator: Locator,
  value: string,
  attempts: string[],
  guards?: ActionExecutionGuards
): Promise<boolean> {
  const { normalizedValue, preferSequential, settleMs, initialPhonePrefix, blurAfterFill } =
    await planTextFillStrategy(locator, value, attempts);
  if (preferSequential) {
    await focusLocator(page, locator, attempts);
    await clearLocatorForReplacement(locator, attempts);
    const residualValue = await readLocatorCurrentValue(locator);
    const sequentialValue = deriveMaskedSequentialValue(
      normalizedValue,
      residualValue,
      initialPhonePrefix,
      attempts
    );

    if (typeof locator.pressSequentially === 'function') {
      attempts.push('locator.pressSequentially.masked');
      try {
        await runActionExecutionGuard(guards, 'fill.masked.press-sequentially');
        await locator.pressSequentially(sequentialValue);
        if (settleMs > 0 && typeof page.waitForTimeout === 'function') {
          attempts.push(`fill.settle:${settleMs}`);
          await page.waitForTimeout(settleMs);
        }
        if (blurAfterFill) {
          await blurLocator(locator, attempts);
        }
        return true;
      } catch {
        // Fall through to fill/js fallback with the normalized masked value.
      }
    }

    attempts.push('locator.fill.masked-fallback');
    try {
      await runActionExecutionGuard(guards, 'fill.masked.fill');
      await locator.fill(sequentialValue, { timeout: LOCATOR_FILL_TIMEOUT_MS });
      if (settleMs > 0 && typeof page.waitForTimeout === 'function') {
        attempts.push(`fill.settle:${settleMs}`);
        await page.waitForTimeout(settleMs);
      }
      if (blurAfterFill) {
        await blurLocator(locator, attempts);
      }
      return true;
    } catch {
      await runActionExecutionGuard(guards, 'fill.masked.js-fallback');
      await applyValueWithJsFallback(locator, sequentialValue, attempts);
      if (blurAfterFill) {
        await blurLocator(locator, attempts);
      }
      return true;
    }
  }

  const directFillValue = await normalizeFillValue(locator, normalizedValue, attempts);
  attempts.push('locator.fill');
  try {
    await locator.fill(directFillValue, { timeout: LOCATOR_FILL_TIMEOUT_MS });
    return false;
  } catch {
    await runActionExecutionGuard(guards, 'fill.after-error');
    await focusLocator(page, locator, attempts);
    await clearLocatorForReplacement(locator, attempts);
    if (typeof locator.pressSequentially === 'function') {
      attempts.push('locator.pressSequentially');
      try {
        await runActionExecutionGuard(guards, 'fill.press-sequentially');
        await locator.pressSequentially(directFillValue);
        if (blurAfterFill) {
          await blurLocator(locator, attempts);
        }
        return true;
      } catch {
        // Fall through to retry and DOM-event fallback.
      }
    }
    attempts.push('locator.fill.retry');
    try {
      await runActionExecutionGuard(guards, 'fill.retry');
      await locator.fill(directFillValue, { timeout: LOCATOR_FILL_TIMEOUT_MS });
      if (blurAfterFill) {
        await blurLocator(locator, attempts);
      }
      return true;
    } catch {
      await runActionExecutionGuard(guards, 'fill.js-fallback');
      await applyValueWithJsFallback(locator, directFillValue, attempts);
    }
    if (blurAfterFill) {
      await blurLocator(locator, attempts);
    }
    return true;
  }
}

export async function applyTypeAction(
  page: Page,
  locator: Locator,
  value: string,
  attempts: string[],
  guards?: ActionExecutionGuards
): Promise<boolean> {
  await focusLocator(page, locator, attempts);
  if (typeof locator.pressSequentially === 'function') {
    attempts.push('locator.pressSequentially');
    try {
      await runActionExecutionGuard(guards, 'type.press-sequentially');
      await locator.pressSequentially(value);
      return false;
    } catch {
      // Fall through to fill/DOM-event fallback.
    }
  }
  attempts.push('locator.fill');
  try {
    await runActionExecutionGuard(guards, 'type.fill');
    await locator.fill(value, { timeout: LOCATOR_FILL_TIMEOUT_MS });
  } catch {
    await runActionExecutionGuard(guards, 'type.js-fallback');
    await applyValueWithJsFallback(locator, value, attempts);
  }
  return true;
}
