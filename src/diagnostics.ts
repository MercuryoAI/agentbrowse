import type { BrowserSessionState } from './browser-session-state.js';
import { getAgentbrowseSessionBindings } from './client-bindings.js';

/** Command names emitted through the diagnostics hook surface. */
export type DiagnosticCommand =
  | 'launch'
  | 'navigate'
  | 'observe'
  | 'act'
  | 'extract'
  | 'screenshot'
  | 'browser-status'
  | 'status'
  | 'close';

export type DiagnosticStepRefs = {
  pageRef?: string;
  targetRef?: string;
  surfaceRef?: string;
  fillRef?: string;
  requestId?: string;
};

export type DiagnosticSnapshotPhase = 'before' | 'after' | 'point-in-time';

export type DiagnosticChildSpanKind = 'client';

/** Step handle returned by `startStep(...)` and passed back to later hooks. */
export type DiagnosticStepHandle = {
  runId: string;
  stepId: string;
  command: DiagnosticCommand;
};

export type DiagnosticStepStartInput = {
  runId?: string;
  command: DiagnosticCommand;
  input?: Record<string, unknown>;
  refs?: DiagnosticStepRefs;
  protectedStep?: boolean;
};

export type DiagnosticStepFinishInput = {
  step: DiagnosticStepHandle | null | undefined;
  success: boolean;
  outcomeType?: string;
  message?: string;
  reason?: string;
  artifactManifestId?: string;
};

export type DiagnosticSnapshotInput = {
  step: DiagnosticStepHandle | null | undefined;
  session: BrowserSessionState;
  phase: DiagnosticSnapshotPhase;
  pageRef?: string;
  url?: string;
  title?: string;
  artifactRefs?: {
    screenshotPath?: string;
    htmlPath?: string;
    tracePath?: string;
    logPath?: string;
  };
};

export type DiagnosticLifecycleEventInput = {
  step: DiagnosticStepHandle | null | undefined;
  phase: 'started' | 'completed' | 'failed';
  attributes?: Record<string, unknown>;
};

export type DiagnosticChildSpanInput = {
  step: DiagnosticStepHandle | null | undefined;
  name: string;
  kind?: DiagnosticChildSpanKind;
  startedAt: string;
  endedAt: string;
  statusCode: 'unset' | 'ok' | 'error';
  statusMessage?: string;
  attributes?: Record<string, unknown>;
};

export type DiagnosticArtifactManifest = {
  artifactManifestId: string;
  stepId: string;
  screenshots: Array<{
    path: string;
    purpose: string;
    storageBucket?: string;
    storagePath?: string;
  }>;
  htmlSnapshots: Array<{
    path: string;
    purpose: string;
    storageBucket?: string;
    storagePath?: string;
  }>;
  traces: Array<{
    path: string;
    purpose: string;
    storageBucket?: string;
    storagePath?: string;
  }>;
  logs: Array<{
    path: string;
    purpose: string;
    storageBucket?: string;
    storagePath?: string;
  }>;
  suppressed: Array<{
    kind: 'screenshot' | 'html' | 'trace' | 'log';
    reason: 'protected_exposure_active' | 'sensitive_scope' | 'policy_blocked' | 'capture_failed';
  }>;
};

export type DiagnosticArtifactManifestInput = {
  runId: string;
  step?: DiagnosticStepHandle | null;
  manifest: DiagnosticArtifactManifest;
};

export type AgentbrowseDiagnosticsHooks = {
  startStep?: (input: DiagnosticStepStartInput) => DiagnosticStepHandle | null;
  finishStep?: (input: DiagnosticStepFinishInput) => void | Promise<void>;
  captureSnapshot?: (input: DiagnosticSnapshotInput) => void | Promise<void>;
  recordCommandEvent?: (input: DiagnosticLifecycleEventInput) => void | Promise<void>;
  recordChildSpan?: (input: DiagnosticChildSpanInput) => void | Promise<void>;
  recordArtifactManifest?: (input: DiagnosticArtifactManifestInput) => void | Promise<void>;
  flushRun?: (runId: string | undefined) => void | Promise<void>;
};

let currentHooks: AgentbrowseDiagnosticsHooks = {};
const hooksByStep = new WeakMap<DiagnosticStepHandle, AgentbrowseDiagnosticsHooks>();

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value;
}

function fireAndForget(result: unknown): void {
  if (isPromiseLike(result)) {
    void result.then(
      () => undefined,
      () => undefined
    );
  }
}

/** Configures process-global diagnostics hooks for AgentBrowse commands. */
export function configureAgentbrowseDiagnostics(
  hooks: AgentbrowseDiagnosticsHooks | null | undefined
): void {
  currentHooks = hooks ?? {};
}

/** Clears the currently configured process-global diagnostics hooks. */
export function resetAgentbrowseDiagnostics(): void {
  currentHooks = {};
}

function resolveDiagnosticHooks(
  options: {
    session?: BrowserSessionState | null;
    step?: DiagnosticStepHandle | null;
  } = {}
): AgentbrowseDiagnosticsHooks {
  const stepHooks = options.step ? hooksByStep.get(options.step) : null;
  if (stepHooks) {
    return stepHooks;
  }

  const boundHooks = options.session
    ? (getAgentbrowseSessionBindings(options.session)?.diagnostics ?? null)
    : null;

  return boundHooks ?? currentHooks;
}

/** Starts a new diagnostic step when the caller provided a run id and hooks are configured. */
export function startDiagnosticStep(
  input: DiagnosticStepStartInput,
  options: {
    session?: BrowserSessionState | null;
  } = {}
): DiagnosticStepHandle | null {
  if (!input.runId) {
    return null;
  }

  const hooks = resolveDiagnosticHooks(options);
  const step = hooks.startStep?.(input) ?? null;
  if (step) {
    hooksByStep.set(step, hooks);
  }
  return step;
}

/** Finishes a diagnostic step and suppresses hook failures. */
export async function finishDiagnosticStepBestEffort(
  input: DiagnosticStepFinishInput
): Promise<void> {
  if (!input.step) {
    return;
  }

  try {
    await resolveDiagnosticHooks({ step: input.step }).finishStep?.(input);
  } catch {
    // Best effort only.
  }
}

/** Captures a best-effort diagnostics snapshot for the current page state. */
export function captureDiagnosticSnapshotBestEffort(input: DiagnosticSnapshotInput): void {
  if (!input.step) {
    return;
  }

  try {
    fireAndForget(
      resolveDiagnosticHooks({ step: input.step, session: input.session }).captureSnapshot?.(input)
    );
  } catch {
    // Best effort only.
  }
}

/** Records a best-effort command lifecycle event. */
export function recordCommandLifecycleEventBestEffort(input: DiagnosticLifecycleEventInput): void {
  if (!input.step) {
    return;
  }

  try {
    fireAndForget(resolveDiagnosticHooks({ step: input.step }).recordCommandEvent?.(input));
  } catch {
    // Best effort only.
  }
}

/** Records a best-effort child span inside the current command step. */
export function recordDiagnosticChildSpanBestEffort(input: DiagnosticChildSpanInput): void {
  if (!input.step) {
    return;
  }

  try {
    fireAndForget(resolveDiagnosticHooks({ step: input.step }).recordChildSpan?.(input));
  } catch {
    // Best effort only.
  }
}

/** Records a best-effort artifact manifest for the current diagnostics run. */
export async function recordDiagnosticArtifactManifestBestEffort(
  input: DiagnosticArtifactManifestInput | null | undefined
): Promise<string | undefined> {
  if (!input?.runId) {
    return undefined;
  }

  const recordArtifactManifest = resolveDiagnosticHooks({
    step: input.step,
  }).recordArtifactManifest;
  if (!recordArtifactManifest) {
    return undefined;
  }

  try {
    await recordArtifactManifest(input);
    return input.manifest.artifactManifestId;
  } catch {
    return undefined;
  }
}

/** Flushes any pending diagnostics work for the run when hooks provide a flush handler. */
export async function flushDiagnosticRunBestEffort(
  runId: string | undefined,
  options: {
    session?: BrowserSessionState | null;
    step?: DiagnosticStepHandle | null;
  } = {}
): Promise<void> {
  if (!runId) {
    return;
  }

  try {
    await resolveDiagnosticHooks(options).flushRun?.(runId);
  } catch {
    // Best effort only.
  }
}
