import type { BrowseSession } from '../session.js';
import { getSecretCatalog, type TargetDescriptor } from '../runtime-state.js';
import {
  markFillableFormsAbsentForPage,
  markFillableFormsUnknownForPage,
  replaceFillableFormsForPage,
} from '../runtime-protected-state.js';
import { matchStoredSecretsToObservedTargets } from '../secrets/form-matcher.js';

function tryResolveHost(pageUrl: string): string | null {
  try {
    return new URL(pageUrl).hostname || null;
  } catch {
    return null;
  }
}

export async function persistProtectedFillableFormsForPage(
  session: BrowseSession,
  pageRef: string,
  pageUrl: string,
  targets: ReadonlyArray<TargetDescriptor>,
  observedAt: string
) {
  const host = tryResolveHost(pageUrl);
  const catalog = host ? getSecretCatalog(session, host) : null;
  const matchedForms = await matchStoredSecretsToObservedTargets(pageRef, targets, catalog, {
    observedAt,
    session,
  });

  if (matchedForms.length === 0) {
    return markFillableFormsUnknownForPage(session, pageRef);
  }

  return replaceFillableFormsForPage(session, pageRef, matchedForms, {
    preserveExistingOnEmpty: false,
  });
}

export function markProtectedFillableFormsUnknownForPage(session: BrowseSession, pageRef: string) {
  return markFillableFormsUnknownForPage(session, pageRef);
}

export function clearProtectedFillableFormsForPage(session: BrowseSession, pageRef: string) {
  return markFillableFormsAbsentForPage(session, pageRef);
}
