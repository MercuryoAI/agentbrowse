import type { BrowserSessionState } from './browser-session-state.js';
import type { FillableFormPresence, PersistedFillableForm } from './secrets/types.js';
import { logicalProtectedBindingKey } from './secrets/protected-bindings.js';
import {
  createFillRef,
  ensureRuntimeState,
  type BrowseRuntimeState,
  type ProtectedExposureState,
} from './runtime-state.js';

function syncFillCounter(runtime: BrowseRuntimeState, ref: string): void {
  const match = /^f(\d+)$/.exec(ref);
  if (!match) return;

  const nextFill = Number(match[1]) + 1;
  if (Number.isFinite(nextFill)) {
    runtime.counters.nextFill = Math.max(runtime.counters.nextFill, nextFill);
  }
}

function fillableFormIdentity(
  form: Pick<PersistedFillableForm, 'pageRef' | 'scopeRef' | 'purpose' | 'fields'>
): string {
  const fieldsKey = [...form.fields]
    .map((field) => logicalProtectedBindingKey(field))
    .sort()
    .join('|');
  return [form.pageRef, form.scopeRef ?? '', form.purpose, fieldsKey].join('||');
}

function normalizeFillableForm(
  runtime: BrowseRuntimeState,
  form: PersistedFillableForm
): PersistedFillableForm {
  const pageScopeEpoch = runtime.pages[form.pageRef]?.scopeEpoch ?? 0;
  const scopeEpoch = form.scopeEpoch ?? pageScopeEpoch;
  const presence =
    form.presence === 'absent'
      ? ('absent' satisfies FillableFormPresence)
      : form.presence === 'unknown' || scopeEpoch < pageScopeEpoch
        ? ('unknown' satisfies FillableFormPresence)
        : ('present' satisfies FillableFormPresence);
  return {
    ...form,
    scopeEpoch,
    presence,
  };
}

export function saveFillableForms(
  session: BrowserSessionState,
  forms: ReadonlyArray<PersistedFillableForm>
): PersistedFillableForm[] {
  const runtime = ensureRuntimeState(session);
  for (const form of forms) {
    const pageScopeEpoch = runtime.pages[form.pageRef]?.scopeEpoch ?? 0;
    runtime.fillableForms[form.fillRef] = {
      ...form,
      presence: form.presence ?? 'present',
      scopeEpoch: form.scopeEpoch ?? pageScopeEpoch,
    };
    syncFillCounter(runtime, form.fillRef);
  }
  return forms.map((form) => getFillableForm(session, form.fillRef)!);
}

export function replaceFillableFormsForPage(
  session: BrowserSessionState,
  pageRef: string,
  forms: ReadonlyArray<Omit<PersistedFillableForm, 'fillRef'>>,
  options: {
    preserveExistingOnEmpty?: boolean;
  } = {}
): PersistedFillableForm[] {
  const runtime = ensureRuntimeState(session);
  const pageScopeEpoch = runtime.pages[pageRef]?.scopeEpoch ?? 0;
  const existingEntries = Object.entries(runtime.fillableForms).filter(
    ([, form]) => form.pageRef === pageRef
  );
  const preserveExistingOnEmpty = options.preserveExistingOnEmpty !== false;

  if (forms.length === 0 && preserveExistingOnEmpty) {
    return existingEntries.map(([, form]) => form);
  }

  const reusableRefs = new Map<string, string[]>();
  for (const [fillRef, form] of existingEntries) {
    if (form.presence === 'absent') {
      continue;
    }
    const identity = fillableFormIdentity(form);
    const refs = reusableRefs.get(identity) ?? [];
    refs.push(fillRef);
    reusableRefs.set(identity, refs);
  }

  const reusedRefs = new Set<string>();
  const nextForms: PersistedFillableForm[] = [];

  for (const form of forms) {
    const identity = fillableFormIdentity(form);
    const matchedRef = (reusableRefs.get(identity) ?? []).find((ref) => !reusedRefs.has(ref));
    const fillRef = matchedRef ?? createFillRef(session);
    runtime.fillableForms[fillRef] = {
      ...form,
      fillRef,
      presence: 'present',
      scopeEpoch: pageScopeEpoch,
    };
    syncFillCounter(runtime, fillRef);
    reusedRefs.add(fillRef);
    nextForms.push(runtime.fillableForms[fillRef]!);
  }

  for (const [fillRef, form] of existingEntries) {
    if (!reusedRefs.has(fillRef) && form.presence !== 'absent') {
      delete runtime.fillableForms[fillRef];
    }
  }

  return nextForms;
}

export function markFillableFormsUnknownForPage(
  session: BrowserSessionState,
  pageRef: string
): PersistedFillableForm[] {
  const runtime = ensureRuntimeState(session);
  const pageScopeEpoch = runtime.pages[pageRef]?.scopeEpoch ?? 0;
  const nextForms: PersistedFillableForm[] = [];

  for (const [fillRef, form] of Object.entries(runtime.fillableForms)) {
    if (form.pageRef !== pageRef) {
      continue;
    }
    if (form.presence === 'absent') {
      nextForms.push(runtime.fillableForms[fillRef]!);
      continue;
    }

    runtime.fillableForms[fillRef] = {
      ...form,
      presence: 'unknown' satisfies FillableFormPresence,
      scopeEpoch: pageScopeEpoch,
    };
    nextForms.push(runtime.fillableForms[fillRef]!);
  }

  return nextForms;
}

export function markFillableFormsAbsentForPage(
  session: BrowserSessionState,
  pageRef: string
): PersistedFillableForm[] {
  const runtime = ensureRuntimeState(session);
  const pageScopeEpoch = runtime.pages[pageRef]?.scopeEpoch ?? 0;
  const nextForms: PersistedFillableForm[] = [];

  for (const [fillRef, form] of Object.entries(runtime.fillableForms)) {
    if (form.pageRef !== pageRef) {
      continue;
    }

    runtime.fillableForms[fillRef] = {
      ...form,
      presence: 'absent' satisfies FillableFormPresence,
      scopeEpoch: pageScopeEpoch,
    };
    nextForms.push(runtime.fillableForms[fillRef]!);
  }

  return nextForms;
}

export function getFillableForm(
  session: BrowserSessionState,
  fillRef: string
): PersistedFillableForm | null {
  const runtime = ensureRuntimeState(session);
  const form = runtime.fillableForms[fillRef];
  return form ? normalizeFillableForm(runtime, form) : null;
}

export function saveProtectedExposure(
  session: BrowserSessionState,
  exposure: ProtectedExposureState
): ProtectedExposureState {
  const runtime = ensureRuntimeState(session);
  const exposures = runtime.protectedExposureByPage ?? (runtime.protectedExposureByPage = {});
  exposures[exposure.pageRef] = exposure;
  return exposures[exposure.pageRef]!;
}

export function getProtectedExposure(
  session: BrowserSessionState,
  pageRef: string
): ProtectedExposureState | null {
  const runtime = ensureRuntimeState(session);
  return runtime.protectedExposureByPage?.[pageRef] ?? null;
}

export function clearProtectedExposure(session: BrowserSessionState, pageRef?: string): void {
  const runtime = ensureRuntimeState(session);
  if (!pageRef) {
    runtime.protectedExposureByPage = {};
    return;
  }

  const exposures = runtime.protectedExposureByPage ?? (runtime.protectedExposureByPage = {});
  delete exposures[pageRef];
}
