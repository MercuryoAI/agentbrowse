import type { Locator, Page } from 'playwright-core';
import {
  LOCATOR_CLICK_TIMEOUT_MS,
  dismissBlockingOverlay,
  looksLikeOverlayInterference,
} from './action-executor-helpers.js';
import type { ClickActivationStrategy } from './click-activation-policy.js';
import { runActionExecutionGuard, type ActionExecutionGuards } from './action-execution-guards.js';

type ClickRetryOptions = {
  beforeRetry?: () => Promise<void>;
  guards?: ActionExecutionGuards;
  clickActivationStrategy?: ClickActivationStrategy;
};

async function handoffFocusFromActiveIframe(
  locator: Locator,
  attempts: string[]
): Promise<boolean> {
  const focused = await locator
    .evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const active = element.ownerDocument.activeElement;
      if (!(active instanceof HTMLIFrameElement)) {
        return false;
      }

      element.focus();
      return element.ownerDocument.activeElement === element;
    })
    .catch(() => false);

  if (focused) {
    attempts.push('locator.focus.handoff-from-iframe');
  }

  return focused;
}

async function waitForPostHandoffQuiescence(
  page: Page,
  attempts: string[],
  options?: ClickRetryOptions
): Promise<void> {
  await runActionExecutionGuard(options?.guards, 'click.focus-handoff.quiescence');
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        })
    )
    .catch(() => undefined);
  attempts.push('locator.focus.handoff-quiescence.raf');
}

async function ensureLocatorRetryReady(
  locator: Locator,
  error: Error,
  options?: ClickRetryOptions
): Promise<void> {
  await runActionExecutionGuard(options?.guards, 'click.before-retry');
  await options?.beforeRetry?.();

  const count = await locator.count().catch(() => 0);
  if (count === 0) {
    throw error;
  }
}

async function applyClickSequence(
  page: Page,
  locator: Locator,
  attempts: string[],
  options?: ClickRetryOptions
): Promise<boolean> {
  const handedOffFocus = await handoffFocusFromActiveIframe(locator, attempts);
  if (handedOffFocus) {
    await waitForPostHandoffQuiescence(page, attempts, options);
  }
  if (options?.clickActivationStrategy === 'dom') {
    await runActionExecutionGuard(options?.guards, 'click.evaluate.primary');
    attempts.push('locator.evaluate.click.primary');
    await locator.evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error('unsupported_js_click_fallback');
      }

      element.click();
    });
    return false;
  }
  attempts.push('locator.click');
  try {
    await locator.click({ timeout: LOCATOR_CLICK_TIMEOUT_MS });
    return false;
  } catch (error) {
    let lastError = error instanceof Error ? error : new Error(String(error));
    await runActionExecutionGuard(options?.guards, 'click.after-error');
    if (looksLikeOverlayInterference(error)) {
      await runActionExecutionGuard(options?.guards, 'click.overlay-dismiss');
      const dismissed = await dismissBlockingOverlay(page, attempts);
      if (dismissed) {
        await ensureLocatorRetryReady(locator, lastError, options);
        attempts.push('locator.click.retry.afterOverlay');
        try {
          await runActionExecutionGuard(options?.guards, 'click.retry.after-overlay');
          await locator.click({ timeout: LOCATOR_CLICK_TIMEOUT_MS });
          return true;
        } catch (retryError) {
          lastError = retryError instanceof Error ? retryError : new Error(String(retryError));
          // Fall through to scroll / JS fallback.
        }
      }
    }

    await ensureLocatorRetryReady(locator, lastError, options);
    await runActionExecutionGuard(options?.guards, 'click.scroll-into-view');
    attempts.push('locator.scrollIntoViewIfNeeded');
    await locator.scrollIntoViewIfNeeded();
    await ensureLocatorRetryReady(locator, lastError, options);
    attempts.push('locator.click.retry');
    try {
      await runActionExecutionGuard(options?.guards, 'click.retry');
      await locator.click({ timeout: LOCATOR_CLICK_TIMEOUT_MS });
      return true;
    } catch (retryError) {
      lastError = retryError instanceof Error ? retryError : new Error(String(retryError));
      await ensureLocatorRetryReady(locator, lastError, options);
      await runActionExecutionGuard(options?.guards, 'click.evaluate');
      attempts.push('locator.evaluate.click');
      await locator.evaluate((element) => {
        if (!(element instanceof HTMLElement)) {
          throw new Error('unsupported_js_click_fallback');
        }
        element.click();
      });
    }
    return true;
  }
}

export async function applyEditableClickAction(
  page: Page,
  locator: Locator,
  attempts: string[],
  options?: ClickRetryOptions
): Promise<boolean> {
  return applyClickSequence(page, locator, attempts, options);
}

export async function applyTriggerAction(
  page: Page,
  locator: Locator,
  attempts: string[],
  options?: ClickRetryOptions
): Promise<boolean> {
  return applyClickSequence(page, locator, attempts, options);
}
