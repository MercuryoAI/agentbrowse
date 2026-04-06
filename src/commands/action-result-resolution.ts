import {
  captureSubmitFollowUpSurfaceHash,
  captureLocatorContextHash,
  type AcceptanceProbe,
  type PageObservation,
} from './action-acceptance.js';
import { resolveSurfaceScopeRoot } from './target-resolution.js';

export type SubmitResultClaimKind =
  | 'hard_result'
  | 'hard_blocker'
  | 'intermediate_progress'
  | 'soft_result_candidate'
  | 'noisy_change';

export type SubmitResultClaim = {
  kind: SubmitResultClaimKind;
  source: string;
  reason: string;
  ownerScopeRef?: string;
};

export type SubmitResultResolution = {
  finalVerdict: 'outcome' | 'blocked' | 'progress' | 'none';
  claims: SubmitResultClaim[];
  decisiveClaims: SubmitResultClaim[];
  acceptAsProgress: boolean;
};

export function reduceSubmitResultClaims(
  claims: ReadonlyArray<SubmitResultClaim>
): Omit<SubmitResultResolution, 'claims' | 'acceptAsProgress'> {
  const hardBlockers = claims.filter((claim) => claim.kind === 'hard_blocker');
  if (hardBlockers.length > 0) {
    return {
      finalVerdict: 'blocked',
      decisiveClaims: hardBlockers,
    };
  }

  const hardResults = claims.filter((claim) => claim.kind === 'hard_result');
  if (hardResults.length > 0) {
    return {
      finalVerdict: 'outcome',
      decisiveClaims: hardResults,
    };
  }

  const intermediateProgressClaims = claims.filter(
    (claim) => claim.kind === 'intermediate_progress'
  );
  if (intermediateProgressClaims.length > 0) {
    return {
      finalVerdict: 'progress',
      decisiveClaims: intermediateProgressClaims,
    };
  }

  return {
    finalVerdict: 'none',
    decisiveClaims: [],
  };
}

async function captureAfterSurfaceContextHash(probe: AcceptanceProbe): Promise<string | null> {
  if (probe.surface) {
    const liveSurfaceLocator = await resolveSurfaceScopeRoot(probe.page, probe.surface).catch(
      () => null
    );
    if (liveSurfaceLocator) {
      return captureLocatorContextHash(liveSurfaceLocator).catch(() => null);
    }
  }

  if (probe.surfaceLocator) {
    return captureLocatorContextHash(probe.surfaceLocator).catch(() => null);
  }

  return null;
}

async function captureAfterFollowUpSurfaceHash(probe: AcceptanceProbe): Promise<string | null> {
  if (probe.policy !== 'submit') {
    return null;
  }

  return captureSubmitFollowUpSurfaceHash(probe.page).catch(() => null);
}

export async function resolveSubmitResult(
  probe: AcceptanceProbe,
  afterPageObservation: PageObservation | null
): Promise<SubmitResultResolution> {
  const beforePageObservation = probe.beforePage;
  const claims: SubmitResultClaim[] = [];

  if (!beforePageObservation || !afterPageObservation) {
    return {
      finalVerdict: 'none',
      claims,
      decisiveClaims: [],
      acceptAsProgress: false,
    };
  }

  if (afterPageObservation.validationBlockerCount > beforePageObservation.validationBlockerCount) {
    claims.push({
      kind: 'hard_blocker',
      source: 'validation',
      reason: 'Validation blockers increased after submit.',
      ownerScopeRef: probe.surface?.ref,
    });
  }

  if (
    beforePageObservation.url !== afterPageObservation.url ||
    beforePageObservation.title !== afterPageObservation.title
  ) {
    claims.push({
      kind: 'hard_result',
      source: 'navigation',
      reason: 'Page identity changed after submit.',
      ownerScopeRef: probe.surface?.ref,
    });
  }

  const resultSignalChanged =
    beforePageObservation.resultSignalHash !== afterPageObservation.resultSignalHash &&
    afterPageObservation.resultSignalHash !== null;
  const submitSignalChanged =
    beforePageObservation.submitSignalHash !== afterPageObservation.submitSignalHash &&
    afterPageObservation.submitSignalHash !== null;
  const afterSurfaceContextHash = await captureAfterSurfaceContextHash(probe);
  const afterFollowUpSurfaceHash = await captureAfterFollowUpSurfaceHash(probe);
  const ownerScopeChanged =
    probe.beforeSurfaceContextHash !== null &&
    afterSurfaceContextHash !== null &&
    probe.beforeSurfaceContextHash !== afterSurfaceContextHash;
  const followUpSurfaceChanged =
    probe.beforeFollowUpSurfaceHash !== afterFollowUpSurfaceHash &&
    afterFollowUpSurfaceHash !== null;

  if (resultSignalChanged) {
    claims.push({
      kind: 'soft_result_candidate',
      source: ownerScopeChanged ? 'owner-scope' : 'page-signal',
      reason: ownerScopeChanged
        ? 'Owner-scope result-bearing signal appeared after submit.'
        : 'A result-bearing signal appeared after submit.',
      ownerScopeRef: probe.surface?.ref,
    });
  } else if (ownerScopeChanged) {
    if (submitSignalChanged) {
      claims.push({
        kind: 'intermediate_progress',
        source: 'owner-scope',
        reason: 'Owner scope changed after submit with a submit-relevant follow-up state change.',
        ownerScopeRef: probe.surface?.ref,
      });
    } else {
      claims.push({
        kind: 'noisy_change',
        source: 'owner-scope',
        reason: 'Owner scope changed after submit without a result-bearing signal.',
        ownerScopeRef: probe.surface?.ref,
      });
    }
  } else if (followUpSurfaceChanged) {
    claims.push({
      kind: 'intermediate_progress',
      source: 'follow-up-surface',
      reason: 'A new follow-up surface appeared after submit.',
      ownerScopeRef: probe.surface?.ref,
    });
  }

  const reduced = reduceSubmitResultClaims(claims);
  return {
    ...reduced,
    claims,
    acceptAsProgress:
      reduced.finalVerdict === 'outcome' ||
      reduced.finalVerdict === 'progress' ||
      (reduced.finalVerdict === 'none' &&
        claims.some((claim) => claim.kind === 'soft_result_candidate')),
  };
}
