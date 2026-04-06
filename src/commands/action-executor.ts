import type { Locator, Page } from 'playwright-core';
import type { TargetControlFamily } from '../runtime-state.js';
import type { BrowseAction } from './browse-actions.js';
import type { LocatorRoot } from './action-fallbacks.js';
import type { ActionExecutionGuards } from './action-execution-guards.js';
import type { ClickActivationStrategy } from './click-activation-policy.js';
import {
  applyValueWithJsFallback,
  blurLocator,
  clearLocatorForReplacement,
  focusLocator,
  normalizeFillValue,
} from './action-executor-helpers.js';
import { applyEditableClickAction, applyTriggerAction } from './click-action-executor.js';
import { applyDatepickerAction } from './datepicker-action-executor.js';
import { applySelectLikeAction } from './select-action-executor.js';
import { applyStructuredGridAction } from './structured-grid-action-executor.js';
import { applyTextFillAction, applyTypeAction } from './text-input-action-executor.js';

type ActionExecutionOptions = {
  beforeClickRetry?: () => Promise<void>;
  guards?: ActionExecutionGuards;
  clickActivationStrategy?: ClickActivationStrategy;
};

export async function applyActionWithFallbacks(
  page: Page,
  root: LocatorRoot,
  locator: Locator,
  action: BrowseAction,
  value: string | undefined,
  attempts: string[],
  family?: TargetControlFamily,
  options?: ActionExecutionOptions
): Promise<boolean> {
  switch (action) {
    case 'click':
      if (family === 'structured-grid') {
        return applyStructuredGridAction(page, locator, attempts);
      }
      if (family === 'trigger') {
        return applyTriggerAction(page, locator, attempts, {
          beforeRetry: options?.beforeClickRetry,
          guards: options?.guards,
          clickActivationStrategy: options?.clickActivationStrategy,
        });
      }
      return applyEditableClickAction(page, locator, attempts, {
        beforeRetry: options?.beforeClickRetry,
        guards: options?.guards,
      });
    case 'fill':
      return family === 'datepicker'
        ? applyDatepickerAction(
            page,
            locator,
            value!,
            attempts,
            {
              normalizeFillValue,
              focusLocator,
              clearLocatorForReplacement,
              applyValueWithJsFallback,
              blurLocator,
            },
            options?.guards
          )
        : applyTextFillAction(page, locator, value!, attempts, options?.guards);
    case 'type':
      return applyTypeAction(page, locator, value!, attempts, options?.guards);
    case 'select':
      return applySelectLikeAction(
        page,
        root,
        locator,
        value!,
        attempts,
        {
          focusLocator,
          clearLocatorForReplacement,
        },
        options?.guards
      );
    case 'press':
      attempts.push('locator.press');
      await locator.press(value!);
      return false;
  }
}
