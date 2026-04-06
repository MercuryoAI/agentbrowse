/**
 * browse extract '<schema-json>' [scopeRef] — Extract structured data from the page or a stored scope.
 */

import { z } from 'zod';
import { AssistiveStructuredOutputTruncatedError } from '../assistive-runtime.js';
import type { BrowserCommandSession } from '../browser-session-state.js';
import { saveSession } from '../session.js';
import {
  getSurface,
  getTarget,
  markSurfaceLifecycle,
  markTargetLifecycle,
} from '../runtime-state.js';
import { getPageScopeEpoch, setCurrentPage } from '../runtime-page-state.js';
import type { SurfaceDescriptor, TargetDescriptor } from '../runtime-state.js';
import {
  outputContractFailure,
  outputJSON,
  type BrowseContractFailure,
  type BrowseResult,
} from '../output.js';
import {
  captureDiagnosticSnapshotBestEffort,
  finishDiagnosticStepBestEffort,
  recordCommandLifecycleEventBestEffort,
  startDiagnosticStep,
} from '../diagnostics.js';
import {
  connectPlaywright,
  disconnectPlaywright,
  resolveCurrentPageContext,
  resolvePageByRef as resolvePlaywrightPageByRef,
  syncSessionPage,
} from '../playwright-runtime.js';
import { withApiTraceContext } from '../command-api-tracing.js';
import { normalizePageSignature } from './descriptor-validation.js';
import { readScopedDialogText } from './extract-scoped-dialog-text.js';
import { resolveScopedExtractContext } from './extract-scope-resolution.js';
import { executeStagehandExtract } from './extract-stagehand-executor.js';

type ScopeTarget = TargetDescriptor | SurfaceDescriptor;

type ExtractSchemaPrimitive = 'string' | 'number' | 'boolean';

/** Recursive descriptor node for the plain object extraction schema format. */
export type ExtractSchemaValue =
  | ExtractSchemaPrimitive
  | ExtractSchemaDescriptor
  | ExtractSchemaValue[];

/** Plain object schema accepted by `extract(session, schema, scopeRef?)`. */
export interface ExtractSchemaDescriptor {
  [key: string]: ExtractSchemaValue;
}

/** Extraction schema accepted by the public library API. */
export type ExtractSchemaInput = ExtractSchemaDescriptor | z.ZodTypeAny;

/** Stable top-level error codes returned by `extract(...)`. */
export const EXTRACT_ERROR_CODES = [
  'browser_connection_failed',
  'expired_extract_scope',
  'extract_failed',
  'extract_output_truncated',
  'invalid_extract_schema',
  'invalid_extract_scope',
  'stale_extract_scope',
  'unknown_scope_ref',
] as const;

/** Stable outcome categories emitted by `extract(...)`. */
export const EXTRACT_OUTCOME_TYPES = [
  'binding_stale',
  'blocked',
  'extraction_completed',
  'unsupported',
] as const;

export type ExtractErrorCode = (typeof EXTRACT_ERROR_CODES)[number];
export type ExtractOutcomeType = (typeof EXTRACT_OUTCOME_TYPES)[number];

/** Successful structured extraction result. */
export type ExtractSuccessResult = BrowseResult & {
  success: true;
  data: unknown;
  resolvedBy: string;
};

type ExtractFailurePayload = {
  error: ExtractErrorCode;
  outcomeType: Extract<ExtractOutcomeType, 'binding_stale' | 'blocked' | 'unsupported'>;
  message: string;
  reason: string;
  pageRef?: string;
  scopeRef?: string;
  staleScope?: boolean;
  staleReason?: string;
  provider?: string;
  model?: string;
  finishReason?: string;
  maxOutputTokens?: number;
  completionTokens?: number;
};

/** Failed structured extraction result. */
export type ExtractFailureResult = { success: false } & ExtractFailurePayload;

export type ExtractResult = ExtractSuccessResult | ExtractFailureResult;

type ExtractSchemaSummary = {
  schemaKind: 'descriptor' | 'zod' | 'invalid';
  fields: string[];
};

type NormalizedExtractSchema = {
  schema: z.ZodTypeAny;
  summary: ExtractSchemaSummary;
  requestsScopedDialogText: boolean;
};

function surfaceExtractScopeLifetime(surface: SurfaceDescriptor): 'durable' | 'snapshot' {
  if (surface.extractScopeLifetime === 'durable' || surface.extractScopeLifetime === 'snapshot') {
    return surface.extractScopeLifetime;
  }

  return (surface.kind ?? '').toLowerCase() === 'form' && surface.locatorCandidates.length > 0
    ? 'durable'
    : 'snapshot';
}

function snapshotScopeUnavailableReason(
  session: BrowserCommandSession,
  surface: SurfaceDescriptor
): string | null {
  if (surfaceExtractScopeLifetime(surface) !== 'snapshot') {
    return null;
  }

  if (surface.availability.state !== 'available') {
    return `Snapshot scope ${surface.ref} is no longer visible or current (availability=${surface.availability.state}${surface.availability.reason ? `:${surface.availability.reason}` : ''}).`;
  }

  const currentEpoch = getPageScopeEpoch(session, surface.pageRef);
  if ((surface.scopeEpoch ?? currentEpoch) !== currentEpoch) {
    return `Snapshot scope ${surface.ref} belongs to page scope epoch ${surface.scopeEpoch ?? 0}, but the current epoch is ${currentEpoch}.`;
  }

  return null;
}

function buildSchemaValue(descriptor: ExtractSchemaValue): z.ZodTypeAny {
  if (descriptor === 'string') return z.string();
  if (descriptor === 'number') return z.number();
  if (descriptor === 'boolean') return z.boolean();

  if (Array.isArray(descriptor)) {
    const itemDescriptor = descriptor[0];
    return z.array(itemDescriptor === undefined ? z.unknown() : buildSchemaValue(itemDescriptor));
  }

  if (typeof descriptor === 'object' && descriptor !== null) {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, value] of Object.entries(descriptor)) {
      shape[key] = buildSchemaValue(value);
    }
    return z.object(shape);
  }

  return z.unknown();
}

function buildSchema(descriptor: ExtractSchemaDescriptor): z.ZodTypeAny {
  return buildSchemaValue(descriptor);
}

function describeSchema(descriptor: ExtractSchemaDescriptor, prefix?: string): string[] {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(descriptor)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if (value === 'string' || value === 'number' || value === 'boolean') {
      lines.push(`${fieldPath}: ${value}`);
      continue;
    }

    if (Array.isArray(value)) {
      const itemDescriptor = value[0];
      if (
        itemDescriptor === 'string' ||
        itemDescriptor === 'number' ||
        itemDescriptor === 'boolean'
      ) {
        lines.push(`${fieldPath}[]: ${itemDescriptor}`);
      } else if (
        typeof itemDescriptor === 'object' &&
        itemDescriptor !== null &&
        !Array.isArray(itemDescriptor)
      ) {
        lines.push(...describeSchema(itemDescriptor as ExtractSchemaDescriptor, `${fieldPath}[]`));
      } else {
        lines.push(`${fieldPath}[]: unknown`);
      }
      continue;
    }

    if (typeof value === 'object' && value !== null) {
      lines.push(...describeSchema(value as ExtractSchemaDescriptor, fieldPath));
      continue;
    }

    lines.push(`${fieldPath}: unknown`);
  }

  return lines;
}

function buildInstruction(fields: string[], scopeRef?: string): string {
  const scopeNote = scopeRef
    ? 'Only inspect the provided scoped container, not the full page.'
    : 'Inspect the current page.';

  return [
    'Extract structured data that is explicitly visible in the current DOM state.',
    scopeNote,
    'Return only the fields defined by the schema and do not infer missing values.',
    fields.length > 0
      ? `Fields: ${fields.join('; ')}.`
      : 'Return data that matches the provided schema exactly.',
  ].join(' ');
}

function isExtractSchemaDescriptorValue(value: unknown): value is ExtractSchemaValue {
  if (value === 'string' || value === 'number' || value === 'boolean') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length <= 1 && (value.length === 0 || isExtractSchemaDescriptorValue(value[0]));
  }

  return isExtractSchemaDescriptor(value);
}

function isExtractSchemaDescriptor(value: unknown): value is ExtractSchemaDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => isExtractSchemaDescriptorValue(entry));
}

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return value !== null && typeof value === 'object' && 'safeParse' in value;
}

function unwrapZodSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;

  while (true) {
    const withUnwrap = current as { unwrap?: () => z.ZodTypeAny };
    if (typeof withUnwrap.unwrap === 'function') {
      current = withUnwrap.unwrap();
      continue;
    }

    const innerType = (current as { _def?: { innerType?: z.ZodTypeAny } })._def?.innerType;
    if (innerType && innerType !== current) {
      current = innerType;
      continue;
    }

    const schemaType = (current as { _def?: { schema?: z.ZodTypeAny } })._def?.schema;
    if (schemaType && schemaType !== current) {
      current = schemaType;
      continue;
    }

    const outputType = (current as { _def?: { out?: z.ZodTypeAny } })._def?.out;
    if (outputType && outputType !== current) {
      current = outputType;
      continue;
    }

    break;
  }

  return current;
}

function describeZodSchema(schema: z.ZodTypeAny, prefix?: string): string[] {
  const normalized = unwrapZodSchema(schema);
  const fieldPath = prefix ?? 'value';

  if (normalized instanceof z.ZodString) {
    return [`${fieldPath}: string`];
  }

  if (normalized instanceof z.ZodNumber) {
    return [`${fieldPath}: number`];
  }

  if (normalized instanceof z.ZodBoolean) {
    return [`${fieldPath}: boolean`];
  }

  if (normalized instanceof z.ZodArray) {
    return describeZodSchema(normalized.element, `${fieldPath}[]`);
  }

  if (normalized instanceof z.ZodObject) {
    return Object.entries(normalized.shape).flatMap(([key, value]) =>
      describeZodSchema(value as z.ZodTypeAny, prefix ? `${prefix}.${key}` : key)
    );
  }

  return [`${fieldPath}: structured`];
}

function zodSchemaRequestsScopedDialogText(schema: z.ZodTypeAny): boolean {
  const normalized = unwrapZodSchema(schema);
  if (!(normalized instanceof z.ZodObject)) {
    return false;
  }

  const dialogField = normalized.shape.dialog_text;
  if (!dialogField) {
    return false;
  }

  return unwrapZodSchema(dialogField) instanceof z.ZodString;
}

function normalizeExtractSchemaInput(schemaInput: unknown): NormalizedExtractSchema | null {
  if (isExtractSchemaDescriptor(schemaInput)) {
    return {
      schema: buildSchema(schemaInput),
      summary: {
        schemaKind: 'descriptor',
        fields: describeSchema(schemaInput),
      },
      requestsScopedDialogText: schemaInput.dialog_text === 'string',
    };
  }

  if (isZodSchema(schemaInput)) {
    return {
      schema: schemaInput,
      summary: {
        schemaKind: 'zod',
        fields: describeZodSchema(schemaInput),
      },
      requestsScopedDialogText: zodSchemaRequestsScopedDialogText(schemaInput),
    };
  }

  return null;
}

function canUseTargetAsExtractScope(target: TargetDescriptor): boolean {
  if (target.capability === 'informational') {
    return false;
  }

  if (target.capability === 'scope') {
    return true;
  }

  const kind = (target.kind ?? '').toLowerCase();
  const role = (target.semantics?.role ?? '').toLowerCase();
  const scopeLikeKinds = new Set([
    'card',
    'article',
    'section',
    'row',
    'grid',
    'gridcell',
    'listitem',
    'dialog',
    'tabpanel',
    'region',
    'form',
    'group',
  ]);
  const leafInteractiveKinds = new Set([
    'input',
    'textarea',
    'select',
    'option',
    'button',
    'link',
    'combobox',
  ]);
  const leafInteractiveRoles = new Set([
    'textbox',
    'combobox',
    'option',
    'menuitem',
    'button',
    'link',
  ]);
  const iframeFieldLike =
    Boolean(target.framePath?.length) &&
    (target.allowedActions.includes('fill') ||
      target.allowedActions.includes('type') ||
      target.allowedActions.includes('select') ||
      ['input', 'textarea', 'select', 'combobox'].includes(kind) ||
      ['textbox', 'combobox'].includes(role));

  if (target.allowedActions.length === 0) {
    return true;
  }

  if (iframeFieldLike) {
    return true;
  }

  if (
    target.allowedActions.includes('fill') ||
    target.allowedActions.includes('type') ||
    target.allowedActions.includes('select')
  ) {
    return false;
  }

  if (leafInteractiveKinds.has(kind) || leafInteractiveRoles.has(role)) {
    return false;
  }

  return Boolean(target.surfaceRef) || scopeLikeKinds.has(kind) || scopeLikeKinds.has(role);
}

function buildTruncationReason(error: AssistiveStructuredOutputTruncatedError): string {
  const details = [
    error.provider ? `provider=${error.provider}` : null,
    error.model ? `model=${error.model}` : null,
    error.finishReason ? `finish_reason=${error.finishReason}` : null,
    Number.isFinite(error.completionTokens) ? `completion_tokens=${error.completionTokens}` : null,
    Number.isFinite(error.maxOutputTokens) ? `max_output_tokens=${error.maxOutputTokens}` : null,
  ].filter((value): value is string => Boolean(value));

  return details.length > 0
    ? `Structured output was truncated by the LLM provider (${details.join(', ')}).`
    : 'Structured output was truncated by the LLM provider.';
}

async function finalizeExtractStepBestEffort(
  step: ReturnType<typeof startDiagnosticStep>,
  options: {
    success: boolean;
    outcomeType?: string;
    message?: string;
    reason?: string;
  }
): Promise<void> {
  await finishDiagnosticStepBestEffort({
    step,
    ...options,
  });
}

async function buildExtractSuccessResult(
  session: BrowserCommandSession,
  step: ReturnType<typeof startDiagnosticStep>,
  payload: ExtractSuccessResult
): Promise<ExtractSuccessResult> {
  captureDiagnosticSnapshotBestEffort({
    session,
    step,
    phase: 'after',
    pageRef:
      typeof payload.pageRef === 'string' ? payload.pageRef : session.runtime?.currentPageRef,
    url: typeof payload.url === 'string' ? payload.url : undefined,
    title: typeof payload.title === 'string' ? payload.title : undefined,
  });
  recordCommandLifecycleEventBestEffort({
    step,
    phase: 'completed',
    attributes: {
      outcomeType: 'extraction_completed',
      pageRef: typeof payload.pageRef === 'string' ? payload.pageRef : undefined,
      scopeRef: typeof payload.scopeRef === 'string' ? payload.scopeRef : undefined,
    },
  });
  await finalizeExtractStepBestEffort(step, {
    success: true,
    outcomeType: 'extraction_completed',
    message: 'Extraction completed.',
  });
  return payload;
}

async function buildExtractContractFailureResult(
  session: BrowserCommandSession,
  params: ExtractFailurePayload & {
    step: ReturnType<typeof startDiagnosticStep>;
  }
): Promise<ExtractFailureResult> {
  captureDiagnosticSnapshotBestEffort({
    session,
    step: params.step,
    phase: 'point-in-time',
    pageRef: typeof params.pageRef === 'string' ? params.pageRef : session.runtime?.currentPageRef,
  });
  recordCommandLifecycleEventBestEffort({
    step: params.step,
    phase: 'failed',
    attributes: {
      outcomeType: params.outcomeType,
      pageRef: typeof params.pageRef === 'string' ? params.pageRef : undefined,
      scopeRef: typeof params.scopeRef === 'string' ? params.scopeRef : undefined,
      staleScope: params.staleScope === true,
      reason: params.reason,
    },
  });
  await finalizeExtractStepBestEffort(params.step, {
    success: false,
    outcomeType: params.outcomeType,
    message: params.message,
    reason: params.reason,
  });
  const { step: _step, ...result } = params;
  return {
    success: false,
    ...result,
  };
}

function invalidExtractSchemaResult(
  session: BrowserCommandSession,
  step: ReturnType<typeof startDiagnosticStep>
): Promise<ExtractFailureResult> {
  return buildExtractContractFailureResult(session, {
    step,
    error: 'invalid_extract_schema',
    outcomeType: 'blocked',
    message: 'Extraction could not start because the schema is invalid.',
    reason: 'Provide a plain schema object or a Zod schema.',
  });
}

/**
 * Extracts structured data from the current page or a previously observed scope.
 *
 * `schemaInput` accepts either a plain schema object or a Zod schema.
 */
export async function extractBrowser(
  session: BrowserCommandSession,
  schemaInput: ExtractSchemaInput,
  scopeRef?: string
): Promise<ExtractResult> {
  const initialPageRef = session.runtime?.currentPageRef ?? 'p0';
  const normalizedSchema = normalizeExtractSchemaInput(schemaInput);
  const extractStep = startDiagnosticStep(
    {
      runId: session.activeRunId,
      command: 'extract',
      input: {
        schema: normalizedSchema?.summary ?? { schemaKind: 'invalid', fields: [] },
        ...(scopeRef ? { scopeRef } : {}),
      },
      refs: {
        pageRef: initialPageRef,
      },
    },
    { session }
  );
  captureDiagnosticSnapshotBestEffort({
    session,
    step: extractStep,
    phase: 'before',
    pageRef: initialPageRef,
  });
  recordCommandLifecycleEventBestEffort({
    step: extractStep,
    phase: 'started',
    attributes: {
      schemaKind: normalizedSchema?.summary.schemaKind ?? 'invalid',
      schemaFieldCount: normalizedSchema?.summary.fields.length ?? 0,
      pageRef: initialPageRef,
      ...(scopeRef ? { scopeRef } : {}),
    },
  });
  return withApiTraceContext(
    {
      runId: session.activeRunId,
      stepId: extractStep?.stepId,
      command: 'extract',
    },
    async () => {
      if (!normalizedSchema) {
        return invalidExtractSchemaResult(session, extractStep);
      }

      const instruction = buildInstruction(normalizedSchema.summary.fields, scopeRef);
      const targetScope = scopeRef ? getTarget(session, scopeRef) : null;
      const surfaceScope = !targetScope && scopeRef ? getSurface(session, scopeRef) : null;
      const scopeTarget = targetScope ?? surfaceScope;
      let pageRef = scopeTarget?.pageRef ?? session.runtime?.currentPageRef ?? 'p0';

      if (scopeRef && !scopeTarget) {
        return buildExtractContractFailureResult(session, {
          step: extractStep,
          error: 'unknown_scope_ref',
          outcomeType: 'blocked',
          message: 'Extraction could not start because the requested scopeRef is unknown.',
          reason: `No live scope target matches scopeRef ${scopeRef}.`,
          scopeRef,
        });
      }
      if (scopeTarget && scopeTarget.lifecycle !== 'live') {
        return buildExtractContractFailureResult(session, {
          step: extractStep,
          error: 'stale_extract_scope',
          outcomeType: 'binding_stale',
          message: 'Extraction could not start because the requested scope is no longer live.',
          reason: `Scope ${scopeRef} is ${scopeTarget.lifecycle}${scopeTarget.lifecycleReason ? ` because ${scopeTarget.lifecycleReason}` : ''}.`,
          scopeRef,
        });
      }
      if (surfaceScope) {
        const snapshotScopeReason = snapshotScopeUnavailableReason(session, surfaceScope);
        if (snapshotScopeReason) {
          return buildExtractContractFailureResult(session, {
            step: extractStep,
            error: 'expired_extract_scope',
            outcomeType: 'binding_stale',
            message:
              'Extraction could not start because the requested snapshot scope is no longer current.',
            reason: snapshotScopeReason,
            scopeRef,
            pageRef,
            staleScope: true,
            staleReason: 'snapshot-scope-expired',
          });
        }
      }
      if (targetScope && !canUseTargetAsExtractScope(targetScope)) {
        return buildExtractContractFailureResult(session, {
          step: extractStep,
          error: 'invalid_extract_scope',
          outcomeType: 'unsupported',
          message: 'Extraction cannot use the requested target as a scope.',
          reason: `Target ${scopeRef} is a leaf control, not an extractable scope container.`,
          scopeRef,
        });
      }

      let browser = null;
      let failureMessage: string | null = null;
      let cleanupScopedExtract: (() => Promise<void>) | null = null;
      let staleScope = false;
      let staleReason: 'page-signature-mismatch' | 'dom-signature-mismatch' | null = null;

      try {
        browser = await connectPlaywright(session.cdpUrl);
      } catch (err) {
        return buildExtractContractFailureResult(session, {
          step: extractStep,
          error: 'browser_connection_failed',
          outcomeType: 'blocked',
          message:
            'Extraction could not start because AgentBrowse failed to connect to the browser.',
          reason: err instanceof Error ? err.message : String(err),
          scopeRef,
          pageRef,
        });
      }

      try {
        let sourcePage: Awaited<ReturnType<typeof resolvePlaywrightPageByRef>>;
        if (scopeTarget) {
          sourcePage = await resolvePlaywrightPageByRef(browser!, session, pageRef);
        } else {
          const resolvedPage = await resolveCurrentPageContext(browser!, session);
          pageRef = resolvedPage.pageRef;
          sourcePage = resolvedPage.page;
        }
        let page = sourcePage;
        let scopedResolution: Awaited<ReturnType<typeof resolveScopedExtractContext>> | null = null;
        const { url, title } = await syncSessionPage(session, pageRef, sourcePage);

        if (
          scopeTarget?.pageSignature &&
          normalizePageSignature(url) !== scopeTarget.pageSignature
        ) {
          staleScope = true;
          staleReason = 'page-signature-mismatch';
          throw new Error('stale_scope_target_page_signature_changed');
        }

        let effectiveSelector: string | undefined;
        if (scopeTarget) {
          try {
            scopedResolution = await resolveScopedExtractContext({
              page: sourcePage,
              scopeTarget,
              validateDomSignature: Boolean(targetScope),
            });
            cleanupScopedExtract = scopedResolution.cleanup;
            page = scopedResolution.page;
            effectiveSelector = scopedResolution.selector;
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === 'stale_scope_target_dom_signature_changed'
            ) {
              staleScope = true;
              staleReason = 'dom-signature-mismatch';
            } else if (
              surfaceScope &&
              surfaceExtractScopeLifetime(surfaceScope) === 'snapshot' &&
              error instanceof Error &&
              error.message === 'scope_target_unresolvable'
            ) {
              return buildExtractContractFailureResult(session, {
                step: extractStep,
                error: 'expired_extract_scope',
                outcomeType: 'binding_stale',
                message:
                  'Extraction failed because the requested snapshot scope expired before it could be rebound.',
                reason: `Snapshot scope ${scopeRef} is no longer present in the current visible page state.`,
                scopeRef,
                pageRef,
                staleScope: true,
                staleReason: 'snapshot-scope-expired',
              });
            }
            throw error;
          }
        }

        setCurrentPage(session, pageRef);
        const execution = await executeStagehandExtract({
          session,
          instruction,
          schema: normalizedSchema.schema,
          page,
          selector: effectiveSelector,
          degradationReason: scopedResolution?.degraded
            ? scopedResolution.degradationReason
            : undefined,
        });
        let data = execution.data;
        if (
          scopeTarget &&
          effectiveSelector &&
          normalizedSchema.requestsScopedDialogText &&
          data &&
          typeof data === 'object' &&
          !Array.isArray(data)
        ) {
          const dialogText = await readScopedDialogText(page, effectiveSelector);
          if (typeof dialogText === 'string' && dialogText.trim().length > 0) {
            data = {
              ...data,
              dialog_text: dialogText,
            };
          }
        }

        return buildExtractSuccessResult(session, extractStep, {
          success: true,
          ...execution,
          data,
          pageRef,
          scopeRef,
          metrics: session.runtime?.metrics,
          url,
          title,
        });
      } catch (err) {
        if (staleScope && scopeRef) {
          if (targetScope) {
            markTargetLifecycle(session, scopeRef, 'stale', staleReason ?? 'unknown');
          } else if (surfaceScope) {
            markSurfaceLifecycle(session, scopeRef, 'stale', staleReason ?? 'unknown');
          }
        }
        if (!staleScope && err instanceof AssistiveStructuredOutputTruncatedError) {
          return buildExtractContractFailureResult(session, {
            step: extractStep,
            error: 'extract_output_truncated',
            outcomeType: 'blocked',
            message: 'Extraction failed because the provider truncated structured output.',
            reason: buildTruncationReason(err),
            scopeRef,
            pageRef,
            staleScope: false,
            provider: err.provider,
            model: err.model,
            finishReason: err.finishReason,
            maxOutputTokens: err.maxOutputTokens,
            completionTokens: err.completionTokens,
          });
        }
        failureMessage = `Extract failed: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        if (cleanupScopedExtract) {
          await cleanupScopedExtract().catch(() => undefined);
        }
        if (browser) {
          await disconnectPlaywright(browser);
        }
      }

      if (failureMessage) {
        return buildExtractContractFailureResult(session, {
          step: extractStep,
          error: staleScope ? 'stale_extract_scope' : 'extract_failed',
          outcomeType: staleScope ? 'binding_stale' : 'blocked',
          message: staleScope
            ? 'Extraction failed because the requested scope became stale.'
            : 'Extraction failed.',
          reason:
            staleScope && scopeRef
              ? `${failureMessage} (${scopeRef} marked stale: ${staleReason ?? 'stale'})`
              : failureMessage.replace(/^Extract failed:\s*/, ''),
          scopeRef,
          pageRef,
          staleScope,
          staleReason: staleReason ?? undefined,
        });
      }

      return buildExtractContractFailureResult(session, {
        step: extractStep,
        error: 'extract_failed',
        outcomeType: 'blocked',
        message: 'Extraction failed.',
        reason: 'Extraction did not produce a success or failure result.',
        scopeRef,
        pageRef,
      });
    }
  );
}

/** CLI wrapper for `extractBrowser(...)` that accepts JSON text or schema objects. */
export async function extract(
  session: BrowserCommandSession,
  schemaInput: string | ExtractSchemaInput,
  scopeRef?: string
): Promise<void> {
  let normalizedInput: ExtractSchemaInput;

  if (typeof schemaInput === 'string') {
    let parsedSchema: unknown;

    try {
      parsedSchema = JSON.parse(schemaInput) as unknown;
    } catch {
      return outputContractFailure({
        error: 'invalid_extract_schema',
        outcomeType: 'blocked',
        message: 'Extraction could not start because the schema is invalid.',
        reason: 'Provide valid JSON that parses to a plain schema object.',
      });
    }

    normalizedInput = parsedSchema as ExtractSchemaInput;
  } else {
    normalizedInput = schemaInput;
  }

  const result = await extractBrowser(session, normalizedInput, scopeRef);
  if (result.success || result.staleScope === true) {
    saveSession(session);
  }
  if (result.success) {
    return outputJSON(result);
  }

  const { success: _success, ...failure } = result as ExtractFailureResult;
  return outputContractFailure(failure);
}
