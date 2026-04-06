import type { FrameLocator, Locator, Page } from 'playwright-core';
import type { LocatorCandidate } from '../runtime-state.js';

export type LocatorRoot = Page | FrameLocator | Locator;

function escapeSelectorAttributeValue(value: string): string {
  return JSON.stringify(value);
}

function buildTestIdSelector(value: string, attribute?: 'data-testid' | 'data-test-id'): string {
  const escapedValue = escapeSelectorAttributeValue(value);
  if (attribute) {
    return `[${attribute}=${escapedValue}]`;
  }
  return `[data-testid=${escapedValue}], [data-test-id=${escapedValue}]`;
}

export function resolveLocatorRoot(page: Page, framePath?: ReadonlyArray<string>): LocatorRoot {
  if (!framePath || framePath.length === 0) {
    return page;
  }

  let root: LocatorRoot = page;
  for (const frameSelector of framePath) {
    root = root.frameLocator(frameSelector);
  }
  return root;
}

export function buildLocator(root: LocatorRoot, candidate: LocatorCandidate): Locator | null {
  switch (candidate.strategy) {
    case 'role': {
      const role = candidate.value as Parameters<Page['getByRole']>[0];
      return root.getByRole(role, candidate.name ? { name: candidate.name } : undefined);
    }
    case 'label':
      return root.getByLabel(candidate.value);
    case 'placeholder':
      return root.getByPlaceholder(candidate.value);
    case 'text':
      return root.getByText(candidate.value);
    case 'title':
      return root.getByTitle(candidate.value);
    case 'testId':
      return root.locator(buildTestIdSelector(candidate.value, candidate.attribute));
    case 'css':
    case 'xpath':
      return root.locator(candidate.value);
    default:
      return null;
  }
}
