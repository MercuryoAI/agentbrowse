import type { ProtectedExposureState } from '../runtime-state.js';

export interface ProtectedArtifactsSuppressed {
  suppressed: true;
  outcomeType: 'protected_exposure_active';
  reason: string;
  pageRef: string;
  fillRef: string;
  requestId: string;
  activatedAt: string;
  exposureReason: ProtectedExposureState['reason'];
  message: string;
}

export function buildProtectedArtifactsSuppressed(
  exposure: ProtectedExposureState
): ProtectedArtifactsSuppressed {
  return {
    suppressed: true,
    outcomeType: 'protected_exposure_active',
    reason:
      'Failure artifacts were suppressed because protected values may still be visible on the page.',
    pageRef: exposure.pageRef,
    fillRef: exposure.fillRef,
    requestId: exposure.requestId,
    activatedAt: exposure.activatedAt,
    exposureReason: exposure.reason,
    message:
      'Failure artifacts were suppressed because protected values may still be visible on the page.',
  };
}

export interface ProtectedScreenshotBlockedResult {
  error: 'protected_screenshot_blocked';
  outcomeType: 'protected_exposure_active';
  reason: string;
  pageRef: string;
  fillRef: string;
  requestId: string;
  activatedAt: string;
  exposureReason: ProtectedExposureState['reason'];
  message: string;
}

export function buildProtectedScreenshotBlockedResult(
  exposure: ProtectedExposureState
): ProtectedScreenshotBlockedResult {
  return {
    error: 'protected_screenshot_blocked',
    outcomeType: 'protected_exposure_active',
    reason:
      'Screenshot capture is currently restricted because protected values may still be visible on the page.',
    pageRef: exposure.pageRef,
    fillRef: exposure.fillRef,
    requestId: exposure.requestId,
    activatedAt: exposure.activatedAt,
    exposureReason: exposure.reason,
    message:
      'Screenshot capture is blocked because protected values may still be visible on the page.',
  };
}

export interface ProtectedObserveBlockedResult {
  error: 'protected_observe_blocked';
  outcomeType: 'protected_exposure_active';
  blockedPath: 'goal-rerank' | 'stagehand-fallback';
  reason: string;
  pageRef: string;
  fillRef: string;
  requestId: string;
  activatedAt: string;
  exposureReason: ProtectedExposureState['reason'];
  message: string;
}

export function buildProtectedObserveBlockedResult(
  exposure: ProtectedExposureState,
  blockedPath: ProtectedObserveBlockedResult['blockedPath']
): ProtectedObserveBlockedResult {
  return {
    error: 'protected_observe_blocked',
    outcomeType: 'protected_exposure_active',
    blockedPath,
    reason:
      blockedPath === 'goal-rerank'
        ? 'Goal-based observe is blocked because it would use assistive page understanding while protected values may still be visible on the page.'
        : 'Assistive observe fallback is blocked because protected values may still be visible on the page.',
    pageRef: exposure.pageRef,
    fillRef: exposure.fillRef,
    requestId: exposure.requestId,
    activatedAt: exposure.activatedAt,
    exposureReason: exposure.reason,
    message:
      blockedPath === 'goal-rerank'
        ? 'Goal-based observe is blocked because protected values may still be visible on the page.'
        : 'Assistive observe fallback is blocked because protected values may still be visible on the page.',
  };
}
