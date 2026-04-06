import type { BrowseSession } from '../session.js';
import {
  ensureRuntimeState,
  markSurfaceLifecycle,
  markTargetLifecycle,
  replaceSurfacesForPage,
  setSurfaceAvailability,
  setTargetAvailability,
} from '../runtime-state.js';
import type { LocatorCandidate, SurfaceDescriptor, TargetDescriptor } from '../runtime-state.js';
import type { DomObservedTarget } from './observe-inventory.js';
import {
  buildSyntheticFormSurfaceId,
  collectSurfaceDescriptors,
  pushUniqueLocatorCandidate,
  surfaceReplacementKey,
} from './observe-surfaces.js';

export function toDomDescriptor(
  pageRef: string,
  target: DomObservedTarget,
  surfaceRefMap: ReadonlyMap<string, string>
): Omit<TargetDescriptor, 'ref'> {
  const locatorCandidates: LocatorCandidate[] = [];

  if (target.role && target.label) {
    pushUniqueLocatorCandidate(locatorCandidates, {
      strategy: 'role' as const,
      value: target.role,
      name: target.label,
    });
  }
  if (target.label) {
    pushUniqueLocatorCandidate(locatorCandidates, {
      strategy: 'label' as const,
      value: target.label,
    });
  }
  if (target.placeholder) {
    pushUniqueLocatorCandidate(locatorCandidates, {
      strategy: 'placeholder' as const,
      value: target.placeholder,
    });
  }
  if (target.text) {
    pushUniqueLocatorCandidate(locatorCandidates, {
      strategy: 'text' as const,
      value: target.text,
    });
  }
  if (target.title) {
    pushUniqueLocatorCandidate(locatorCandidates, {
      strategy: 'title' as const,
      value: target.title,
    });
  }
  if (target.testId) {
    pushUniqueLocatorCandidate(locatorCandidates, {
      strategy: 'testId' as const,
      value: target.testId,
      attribute: target.testIdAttribute,
    });
  }
  if (target.selector) {
    pushUniqueLocatorCandidate(locatorCandidates, {
      strategy: target.selector.startsWith('xpath=') ? ('xpath' as const) : ('css' as const),
      value: target.selector,
      scope: 'root',
    });
  }

  return {
    pageRef,
    framePath: target.framePath,
    frameUrl: target.frameUrl,
    kind: target.kind,
    label: target.label ?? target.text ?? target.placeholder ?? target.title,
    displayLabel: target.displayLabel,
    placeholder: target.placeholder,
    inputName: target.inputName,
    inputType: target.inputType,
    autocomplete: target.autocomplete,
    ariaAutocomplete: target.ariaAutocomplete,
    surfaceKind: target.surfaceKind,
    controlsSurfaceSelector: target.controlsSurfaceSelector,
    validation: target.validation,
    locatorCandidates,
    semantics:
      target.role || target.label || target.states
        ? {
            role: target.role,
            name: target.label,
            states: target.states,
            source:
              target.semanticsSource === 'aria-snapshot'
                ? ('aria-snapshot' as const)
                : ('dom' as const),
          }
        : undefined,
    structure: target.structure,
    context: target.context,
    capability: target.capability ?? 'actionable',
    lifecycle: 'live' as const,
    availability: target.availability ?? { state: 'available' as const },
    allowedActions: target.allowedActions ?? [],
    controlFamily: target.controlFamily,
    acceptancePolicy: target.acceptancePolicy,
    surfaceRef: target.surfaceRef ? surfaceRefMap.get(target.surfaceRef) : undefined,
    createdAt: Date.now(),
    pageSignature: target.pageSignature,
    domSignature: target.domSignature,
  };
}

export function attachObservedTargetOwners(
  domTargets: ReadonlyArray<DomObservedTarget>,
  targets: TargetDescriptor[]
): void {
  for (const [index, observedTarget] of domTargets.entries()) {
    if (typeof observedTarget.ownerIndex !== 'number') {
      continue;
    }
    const ownerSlot = domTargets.findIndex(
      (candidate) => candidate.ordinal === observedTarget.ownerIndex
    );
    if (ownerSlot >= 0 && targets[ownerSlot]) {
      targets[index]!.ownerRef = targets[ownerSlot]!.ref;
    }
  }
}

export function persistObservedSurfacesForPage(
  session: BrowseSession,
  pageRef: string,
  targets: ReadonlyArray<DomObservedTarget>,
  options?: {
    allSurfaceInputs?: ReadonlyArray<Omit<SurfaceDescriptor, 'ref'>>;
    explicitSurfaceIds?: ReadonlySet<string>;
  }
): {
  observedScopes: SurfaceDescriptor[];
  surfaceRefMap: Map<string, string>;
} {
  const runtime = ensureRuntimeState(session);
  const pageScopeEpoch = runtime.pages[pageRef]?.scopeEpoch ?? 0;
  const derivedSurfaces = collectSurfaceDescriptors(pageRef, targets);
  const descriptors = new Map<string, Omit<SurfaceDescriptor, 'ref'>>();

  for (const surface of derivedSurfaces) {
    descriptors.set(surface.surfaceId, {
      ...surface,
      scopeEpoch: pageScopeEpoch,
    });
  }
  for (const surface of options?.allSurfaceInputs ?? []) {
    if (!options?.explicitSurfaceIds?.has(surface.surfaceId)) {
      continue;
    }
    if (!descriptors.has(surface.surfaceId)) {
      descriptors.set(surface.surfaceId, {
        ...surface,
        scopeEpoch: pageScopeEpoch,
      });
    }
  }

  const observedScopes = replaceSurfacesForPage(session, pageRef, [...descriptors.values()], {
    preserveExistingOnEmpty: false,
    preserveExisting: true,
  });
  const activeSurfaceRefs = new Set(observedScopes.map((scope) => scope.ref));
  const activeSurfaceSlots = new Set(observedScopes.map((scope) => surfaceReplacementKey(scope)));
  for (const surface of Object.values(runtime.surfaces)) {
    if (surface.pageRef !== pageRef) continue;
    if (activeSurfaceRefs.has(surface.ref)) {
      markSurfaceLifecycle(session, surface.ref, 'live');
      setSurfaceAvailability(session, surface.ref, 'available');
    } else if (activeSurfaceSlots.has(surfaceReplacementKey(surface))) {
      markSurfaceLifecycle(session, surface.ref, 'invalidated', 'surface-replaced');
      setSurfaceAvailability(session, surface.ref, 'hidden', 'surface-replaced');
    } else {
      setSurfaceAvailability(session, surface.ref, 'hidden', 'surface-not-observed');
    }
  }

  for (const target of Object.values(runtime.targets)) {
    if (target.pageRef !== pageRef || !target.surfaceRef) continue;
    if (activeSurfaceRefs.has(target.surfaceRef)) {
      continue;
    }
    const linkedSurface = runtime.surfaces[target.surfaceRef];
    if (linkedSurface?.lifecycle === 'invalidated') {
      markTargetLifecycle(session, target.ref, 'invalidated', linkedSurface.lifecycleReason);
      setTargetAvailability(
        session,
        target.ref,
        'hidden',
        linkedSurface.lifecycleReason ?? 'surface-replaced'
      );
    } else {
      setTargetAvailability(session, target.ref, 'surface-inactive', 'surface-not-observed');
    }
  }

  return {
    observedScopes,
    surfaceRefMap: new Map(observedScopes.map((scope) => [scope.surfaceId, scope.ref])),
  };
}

export function reconcileObservedTargetsForPage(
  session: BrowseSession,
  pageRef: string,
  observedTargets: ReadonlyArray<Pick<TargetDescriptor, 'ref'>>
): void {
  const runtime = ensureRuntimeState(session);
  const activeTargetRefs = new Set(observedTargets.map((target) => target.ref));

  for (const target of Object.values(runtime.targets)) {
    if (target.pageRef !== pageRef || activeTargetRefs.has(target.ref)) {
      continue;
    }

    const linkedSurface = target.surfaceRef ? runtime.surfaces[target.surfaceRef] : null;
    if (linkedSurface) {
      if (linkedSurface.lifecycle === 'invalidated') {
        continue;
      }
      if (linkedSurface.availability.state !== 'available') {
        continue;
      }
    }

    markTargetLifecycle(session, target.ref, 'stale', 'target-not-observed');
    setTargetAvailability(session, target.ref, 'hidden', 'target-not-observed');
  }
}

function pushUniqueRef(map: Map<string, string[]>, key: string, ref: string): void {
  const refs = map.get(key) ?? [];
  if (!refs.includes(ref)) {
    refs.push(ref);
    map.set(key, refs);
  }
}

export function linkObservedSurfaceGraph(
  session: BrowseSession,
  pageRef: string,
  domTargets: ReadonlyArray<DomObservedTarget>,
  persistedTargets: ReadonlyArray<TargetDescriptor>,
  observedScopes: ReadonlyArray<SurfaceDescriptor>,
  surfaceRefMap: ReadonlyMap<string, string>
): SurfaceDescriptor[] {
  const runtime = ensureRuntimeState(session);
  const activeSurfaceRefs = new Set(observedScopes.map((scope) => scope.ref));
  const targetRefsBySurface = new Map<string, string[]>();
  const parentBySurface = new Map<string, string>();
  const childRefsByParent = new Map<string, string[]>();

  for (const [index, persistedTarget] of persistedTargets.entries()) {
    if (persistedTarget.pageRef !== pageRef) {
      continue;
    }

    if (persistedTarget.surfaceRef) {
      pushUniqueRef(targetRefsBySurface, persistedTarget.surfaceRef, persistedTarget.ref);
    }

    const domTarget = domTargets[index];
    if (!domTarget) {
      continue;
    }

    const syntheticFormSurfaceId = buildSyntheticFormSurfaceId(domTarget);
    const formSurfaceRef = syntheticFormSurfaceId
      ? surfaceRefMap.get(syntheticFormSurfaceId)
      : undefined;
    if (
      !formSurfaceRef ||
      !persistedTarget.surfaceRef ||
      persistedTarget.surfaceRef === formSurfaceRef
    ) {
      continue;
    }

    parentBySurface.set(persistedTarget.surfaceRef, formSurfaceRef);
    pushUniqueRef(childRefsByParent, formSurfaceRef, persistedTarget.surfaceRef);
  }

  for (const surface of Object.values(runtime.surfaces)) {
    if (surface.pageRef !== pageRef) {
      continue;
    }

    runtime.surfaces[surface.ref] = {
      ...surface,
      parentSurfaceRef: activeSurfaceRefs.has(surface.ref)
        ? parentBySurface.get(surface.ref)
        : undefined,
      childSurfaceRefs: activeSurfaceRefs.has(surface.ref)
        ? [...(childRefsByParent.get(surface.ref) ?? [])]
        : [],
      targetRefs: activeSurfaceRefs.has(surface.ref)
        ? [...(targetRefsBySurface.get(surface.ref) ?? [])]
        : [],
    };
  }

  return observedScopes.map((scope) => runtime.surfaces[scope.ref] ?? scope);
}
