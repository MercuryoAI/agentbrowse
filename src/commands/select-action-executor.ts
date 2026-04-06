import type { FrameLocator, Locator, Page } from 'playwright-core';
import { runActionExecutionGuard, type ActionExecutionGuards } from './action-execution-guards.js';

type LocatorRoot = Page | FrameLocator | Locator;

const OPTION_RESOLVE_TIMEOUT_MS = 250;
const ASYNC_OPTION_WAIT_MS = 1_000;
const OPTION_POLL_INTERVAL_MS = 100;
const LOCATOR_SELECT_TIMEOUT_MS = 1_500;

type NativeSelectState = {
  value: string;
  label: string;
  text: string;
};

type SelectActionHelpers = {
  focusLocator: (page: Page, locator: Locator, attempts: string[]) => Promise<void>;
  clearLocatorForReplacement: (locator: Locator, attempts: string[]) => Promise<void>;
};

function normalizeNativeSelectComparable(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function compactNativeSelectComparable(value: string | null | undefined): string {
  return normalizeNativeSelectComparable(value).replace(/\s+/g, '');
}

async function readNativeSelectState(
  locator: Locator,
  guards?: ActionExecutionGuards
): Promise<NativeSelectState | null> {
  await runActionExecutionGuard(guards, 'select.native-state');
  return locator
    .evaluate(
      (element) => {
        const selectElement =
          element instanceof HTMLSelectElement
            ? element
            : element instanceof HTMLLabelElement && element.control instanceof HTMLSelectElement
              ? element.control
              : null;
        if (!selectElement) {
          return null;
        }

        const selected = selectElement.options[selectElement.selectedIndex] ?? null;
        return {
          value: selectElement.value,
          label: selected?.label ?? '',
          text: selected?.text ?? selected?.textContent ?? '',
        };
      },
      { mode: 'selected-state' }
    )
    .catch(() => null);
}

function nativeSelectStateMatchesRequest(
  requestedValue: string,
  state: NativeSelectState | null
): boolean {
  if (!state) {
    return false;
  }

  const requested = normalizeNativeSelectComparable(requestedValue);
  const requestedCompact = compactNativeSelectComparable(requestedValue);
  if (!requested && !requestedCompact) {
    return false;
  }

  const candidates = [state.value, state.label, state.text];
  return candidates.some((candidate) => {
    const normalizedCandidate = normalizeNativeSelectComparable(candidate);
    const compactCandidate = compactNativeSelectComparable(candidate);
    return (
      (requested.length > 0 && normalizedCandidate === requested) ||
      (requestedCompact.length > 0 && compactCandidate === requestedCompact)
    );
  });
}

async function acceptIfNativeSelectSettled(
  locator: Locator,
  requestedValue: string,
  attempts: string[],
  guards: ActionExecutionGuards | undefined,
  attemptLabel: string
): Promise<boolean> {
  const nativeSelectState = await readNativeSelectState(locator, guards);
  if (!nativeSelectStateMatchesRequest(requestedValue, nativeSelectState)) {
    return false;
  }

  attempts.push(attemptLabel);
  return true;
}

async function clickOptionFromRoot(
  root: LocatorRoot,
  value: string,
  attempts: string[],
  options?: {
    waitForMs?: number;
  },
  guards?: ActionExecutionGuards
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, options?.waitForMs ?? 0);

  while (true) {
    await runActionExecutionGuard(guards, 'select.option-resolve');
    const roleCandidates: Array<Parameters<Page['getByRole']>[0]> = ['option', 'menuitem'];
    for (const role of roleCandidates) {
      attempts.push(`option.resolve:role:${role}`);
      try {
        const option = root.getByRole(role, { name: value }).first();
        await option.click({ timeout: OPTION_RESOLVE_TIMEOUT_MS });
        attempts.push(`option.click:role:${role}`);
        return true;
      } catch {
        // Try the next candidate.
      }
    }

    attempts.push('option.resolve:text');
    try {
      const option = root.getByText(value).first();
      await option.click({ timeout: OPTION_RESOLVE_TIMEOUT_MS });
      attempts.push('option.click:text');
      return true;
    } catch {
      if (Date.now() >= deadline) {
        return false;
      }
    }

    await runActionExecutionGuard(guards, 'select.option-await');
    attempts.push('option.await');
    await new Promise((resolve) => setTimeout(resolve, OPTION_POLL_INTERVAL_MS));
  }
}

async function tryTypeToFilterSelectOption(
  root: LocatorRoot,
  locator: Locator,
  value: string,
  attempts: string[],
  helpers: SelectActionHelpers,
  guards?: ActionExecutionGuards
): Promise<boolean> {
  if (typeof locator.pressSequentially !== 'function') {
    return false;
  }

  await helpers.clearLocatorForReplacement(locator, attempts);
  attempts.push('locator.pressSequentially.select');
  try {
    await runActionExecutionGuard(guards, 'select.press-sequentially');
    await locator.pressSequentially(value);
  } catch {
    return false;
  }

  return clickOptionFromRoot(root, value, attempts, { waitForMs: ASYNC_OPTION_WAIT_MS }, guards);
}

async function pressSelectTriggerKey(
  locator: Locator,
  key: 'Enter' | 'Space' | 'ArrowDown',
  attempts: string[]
): Promise<boolean> {
  attempts.push(`locator.press:${key}`);
  try {
    await locator.press(key);
    return true;
  } catch {
    return false;
  }
}

export async function applySelectLikeAction(
  page: Page,
  root: LocatorRoot,
  locator: Locator,
  value: string,
  attempts: string[],
  helpers: SelectActionHelpers,
  guards?: ActionExecutionGuards
): Promise<boolean> {
  attempts.push('locator.selectOption');
  try {
    await locator.selectOption(value, { timeout: LOCATOR_SELECT_TIMEOUT_MS });
    return false;
  } catch {
    if (
      await acceptIfNativeSelectSettled(
        locator,
        value,
        attempts,
        guards,
        'locator.selectOption.accepted-after-error'
      )
    ) {
      return false;
    }
    await runActionExecutionGuard(guards, 'select.after-error');
    await helpers.focusLocator(page, locator, attempts);
    if (await clickOptionFromRoot(root, value, attempts, undefined, guards)) {
      return true;
    }
    if (
      await acceptIfNativeSelectSettled(
        locator,
        value,
        attempts,
        guards,
        'locator.selectOption.accepted-after-fallback'
      )
    ) {
      return false;
    }
    if (await tryTypeToFilterSelectOption(root, locator, value, attempts, helpers, guards)) {
      return true;
    }
    if (
      await acceptIfNativeSelectSettled(
        locator,
        value,
        attempts,
        guards,
        'locator.selectOption.accepted-after-fallback'
      )
    ) {
      return false;
    }
    for (const key of ['Enter', 'Space', 'ArrowDown'] as const) {
      await runActionExecutionGuard(guards, `select.press:${key.toLowerCase()}`);
      const pressed = await pressSelectTriggerKey(locator, key, attempts);
      if (!pressed) {
        continue;
      }
      if (await clickOptionFromRoot(root, value, attempts, undefined, guards)) {
        return true;
      }
      if (
        await acceptIfNativeSelectSettled(
          locator,
          value,
          attempts,
          guards,
          'locator.selectOption.accepted-after-fallback'
        )
      ) {
        return false;
      }
    }
    throw new Error('select_option_not_found');
  }
}
