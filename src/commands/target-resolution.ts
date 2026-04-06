import type { Locator, Page } from 'playwright-core';
import type { SurfaceDescriptor } from '../runtime-state.js';
import { buildLocator, resolveLocatorRoot } from './action-fallbacks.js';

const STRUCTURAL_SURFACE_STRATEGIES = new Set(['css', 'xpath', 'testId', 'role']);

export async function resolveSurfaceScopeRoot(
  page: Page,
  surface: SurfaceDescriptor | null,
  attempts?: string[]
): Promise<Locator | null> {
  if (!surface) {
    return null;
  }

  const baseRoot = resolveLocatorRoot(page, surface.framePath);
  for (const candidate of surface.locatorCandidates) {
    if (!STRUCTURAL_SURFACE_STRATEGIES.has(candidate.strategy)) {
      continue;
    }

    attempts?.push(`surface.resolve:${candidate.strategy}`);
    const locator = buildLocator(baseRoot, candidate);
    if (!locator) {
      attempts?.push(`surface.resolve.skip:${candidate.strategy}:unsupported`);
      continue;
    }

    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      attempts?.push(`surface.resolve.skip:${candidate.strategy}:empty`);
      continue;
    }

    const resolvedSurface = locator.first();
    const visible = await resolvedSurface.isVisible().catch(() => false);
    if (!visible) {
      attempts?.push(`surface.resolve.skip:${candidate.strategy}:hidden`);
      continue;
    }

    attempts?.push(`surface.resolve.ok:${candidate.strategy}`);
    return resolvedSurface;
  }

  return null;
}
