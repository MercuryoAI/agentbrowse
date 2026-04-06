import type { Locator, Page } from 'playwright-core';
import { runActionExecutionGuard, type ActionExecutionGuards } from './action-execution-guards.js';

const DATEPICKER_DAY_ROLES: Array<Parameters<Page['getByRole']>[0]> = [
  'gridcell',
  'button',
  'option',
];
const DATEPICKER_CONTAINER_SELECTORS = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[data-testid*="calendar"]',
  '[data-testid*="datepicker"]',
  '[class*="calendar"]',
  '[class*="datepicker"]',
] as const;
const ISO_DATE_ENTRY_RE = /^\d{4}-\d{2}-\d{2}$/;

type DatepickerSearchRoot = Page | Locator;

type DatepickerActionHelpers = {
  normalizeFillValue: (locator: Locator, value: string, attempts: string[]) => Promise<string>;
  focusLocator: (page: Page, locator: Locator, attempts: string[]) => Promise<void>;
  clearLocatorForReplacement: (locator: Locator, attempts: string[]) => Promise<void>;
  applyValueWithJsFallback: (locator: Locator, value: string, attempts: string[]) => Promise<void>;
  blurLocator: (locator: Locator, attempts: string[]) => Promise<void>;
};

function isLiteralDateEntry(value: string): boolean {
  return /\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(value);
}

async function isNativeDateInput(locator: Locator): Promise<boolean> {
  const type = await locator.getAttribute('type').catch(() => null);
  return (type ?? '').toLowerCase() === 'date';
}

function datepickerDayLabels(value: string): string[] {
  const labels = new Set<string>([value]);
  const triplet = value.match(/^(\d{1,4})[./-](\d{1,2})[./-](\d{1,4})$/);
  const parts = value.match(/\d+/g);
  if (!parts || parts.length < 3) {
    return [...labels];
  }

  let day: string | undefined;
  if (triplet) {
    const firstPart = triplet[1];
    const lastPart = triplet[3];
    if (firstPart && firstPart.length === 4) {
      day = lastPart;
    } else if (lastPart && lastPart.length === 4) {
      day = firstPart;
    }
  }

  if (!day) {
    day = parts.at(-1);
  }
  if (!day) {
    return [...labels];
  }

  const normalized = String(Number(day));
  if (normalized) {
    labels.add(normalized);
  }
  if (day.length === 2) {
    labels.add(day);
  }

  return [...labels];
}

async function trySelectDateFromPicker(
  page: Page,
  anchor: Locator,
  value: string,
  attempts: string[],
  guards?: ActionExecutionGuards
): Promise<boolean> {
  const labels = datepickerDayLabels(value);
  if (labels.length === 1 && labels[0] === value && !/\d/.test(value)) {
    return false;
  }

  const scopedContainers: Array<{ selector: string; container: Locator }> = [];
  for (const selector of DATEPICKER_CONTAINER_SELECTORS) {
    const containers = page.locator(selector);
    const count = await containers.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const container = containers.nth(index);
      const visible = await container.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      scopedContainers.push({ selector, container });
    }
  }

  const scopedRoots =
    scopedContainers.length > 0
      ? scopedContainers
      : [{ selector: 'page', container: page as unknown as Locator }];
  const anchorBox = await anchor.boundingBox().catch(() => null);

  async function clickBestMatch(
    root: DatepickerSearchRoot,
    descriptor: string,
    locatorFactory: () => Locator
  ): Promise<boolean> {
    const locator = locatorFactory();
    const count = await locator.count().catch(() => 0);
    let bestCandidate: { locator: Locator; score: number } | null = null;

    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }

      const box = await candidate.boundingBox().catch(() => null);
      const score =
        anchorBox && box
          ? Math.abs(box.y - anchorBox.y) * 10 + Math.abs(box.x - anchorBox.x)
          : index;

      if (!bestCandidate || score < bestCandidate.score) {
        bestCandidate = { locator: candidate, score };
      }
    }

    if (!bestCandidate) {
      return false;
    }

    await bestCandidate.locator.evaluate((element) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error('unsupported_datepicker_dom_click');
      }
      element.click();
    });
    attempts.push(`datepicker.click.dom:${descriptor}`);
    return true;
  }

  for (const { selector, container } of scopedRoots) {
    await runActionExecutionGuard(guards, `datepicker.scope:${selector}`);
    attempts.push(`datepicker.scope:${selector}`);
    for (const role of DATEPICKER_DAY_ROLES) {
      for (const label of labels) {
        const descriptor = `${role}:${label}`;
        attempts.push(`datepicker.resolve:${descriptor}`);
        try {
          const clicked = await clickBestMatch(container, descriptor, () =>
            container.getByRole(role, { name: label })
          );
          if (!clicked) {
            continue;
          }
          return true;
        } catch {
          // Try the next label/role combination.
        }
      }
    }

    for (const label of labels) {
      const descriptor = `text:${label}`;
      attempts.push(`datepicker.resolve:${descriptor}`);
      try {
        const clicked = await clickBestMatch(container, descriptor, () =>
          container.getByText(label)
        );
        if (!clicked) {
          continue;
        }
        return true;
      } catch {
        // Try next text label.
      }
    }
  }

  return false;
}

export async function applyDatepickerAction(
  page: Page,
  locator: Locator,
  value: string,
  attempts: string[],
  helpers: DatepickerActionHelpers,
  guards?: ActionExecutionGuards
): Promise<boolean> {
  const normalizedValue = await helpers.normalizeFillValue(locator, value, attempts);
  const editable = await locator.isEditable().catch(() => false);
  const nativeDateInput = await isNativeDateInput(locator);

  if (nativeDateInput && editable && ISO_DATE_ENTRY_RE.test(normalizedValue)) {
    attempts.push('datepicker.native:js-value');
    await helpers.applyValueWithJsFallback(locator, normalizedValue, attempts);
    await helpers.blurLocator(locator, attempts);
    return true;
  }

  if (isLiteralDateEntry(normalizedValue)) {
    await helpers.focusLocator(page, locator, attempts);
    if (!editable) {
      attempts.push('datepicker.readonly:picker-only');
      return trySelectDateFromPicker(page, locator, normalizedValue, attempts, guards);
    }
    await helpers.clearLocatorForReplacement(locator, attempts);
    if (typeof locator.pressSequentially === 'function') {
      attempts.push('locator.pressSequentially.datepicker');
      try {
        await runActionExecutionGuard(guards, 'datepicker.press-sequentially');
        await locator.pressSequentially(normalizedValue);
        await helpers.blurLocator(locator, attempts);
        return true;
      } catch {
        // Fall through to fill/picker fallback.
      }
    }
  }

  attempts.push('locator.fill');
  try {
    await locator.fill(normalizedValue, { timeout: 1_500 });
    if (isLiteralDateEntry(normalizedValue)) {
      await helpers.blurLocator(locator, attempts);
    }
    return false;
  } catch {
    await runActionExecutionGuard(guards, 'datepicker.after-error');
    await helpers.focusLocator(page, locator, attempts);
    if (await trySelectDateFromPicker(page, locator, normalizedValue, attempts, guards)) {
      return true;
    }
    await helpers.clearLocatorForReplacement(locator, attempts);
    if (typeof locator.pressSequentially === 'function') {
      attempts.push('locator.pressSequentially');
      try {
        await runActionExecutionGuard(guards, 'datepicker.press-sequentially');
        await locator.pressSequentially(normalizedValue);
        if (isLiteralDateEntry(normalizedValue)) {
          await helpers.blurLocator(locator, attempts);
        }
        return true;
      } catch {
        // Fall through to retry and DOM-event fallback.
      }
    }
    attempts.push('locator.fill.retry');
    try {
      await runActionExecutionGuard(guards, 'datepicker.fill.retry');
      await locator.fill(normalizedValue, { timeout: 1_500 });
      if (isLiteralDateEntry(normalizedValue)) {
        await helpers.blurLocator(locator, attempts);
      }
      return true;
    } catch {
      await runActionExecutionGuard(guards, 'datepicker.js-fallback');
      await helpers.applyValueWithJsFallback(locator, normalizedValue, attempts);
    }
    return true;
  }
}
