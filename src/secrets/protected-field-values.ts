import { z } from 'zod';
import type { Page } from 'playwright-core';
import {
  AgentbrowseAssistiveRuntimeMissingError,
  tryCreateAgentbrowseAssistiveLlmClient,
} from '../assistive-runtime.js';
import type { BrowserSessionState } from '../browser-session-state.js';
import type { TargetDescriptor } from '../runtime-state.js';
import { recordLlmUsage, recordPayloadBudget } from '../runtime-metrics.js';
import { resolveProtectedFieldPolicy } from './field-policy.js';
import { resolveDeterministicProtectedBindingValue } from './protected-value-adapters.js';
import { protectedBindingKey, protectedBindingValueHintSchema } from './protected-bindings.js';
import type { FillableFormFieldBinding, StoredSecretFieldPolicies } from './types.js';

const protectedFieldValuesSchema = z.object({
  values: z
    .array(
      z.object({
        targetRef: z.string(),
        fieldKey: z.string(),
        valueHint: protectedBindingValueHintSchema.optional(),
        value: z.string(),
        confidence: z.enum(['high', 'medium', 'low']),
      })
    )
    .max(24),
});

function buildBindingSummary(
  binding: FillableFormFieldBinding,
  target: TargetDescriptor | null
): string {
  const parts = [
    `targetRef=${JSON.stringify(binding.targetRef)}`,
    `fieldKey=${JSON.stringify(binding.fieldKey)}`,
    `valueHint=${JSON.stringify(binding.valueHint ?? 'direct')}`,
  ];

  if (target?.label) parts.push(`label=${JSON.stringify(target.label)}`);
  if (target?.kind || target?.semantics?.role) {
    parts.push(
      `control=${JSON.stringify({
        kind: target?.kind,
        role: target?.semantics?.role,
      })}`
    );
  }

  const ownerLabel =
    target?.context?.container?.label ?? target?.context?.group?.label ?? target?.displayLabel;
  if (ownerLabel) {
    parts.push(`owner=${JSON.stringify(ownerLabel)}`);
  }

  return parts.join(' | ');
}

function canUseDeterministicValueForPolicy(
  binding: FillableFormFieldBinding,
  fieldPolicies: StoredSecretFieldPolicies | undefined
): boolean {
  const policy = resolveProtectedFieldPolicy(fieldPolicies, binding.fieldKey);
  if (policy !== 'llm_assisted') {
    return true;
  }

  return (binding.valueHint ?? 'direct') !== 'direct';
}

export async function resolveAssistedProtectedFieldValues(params: {
  session?: BrowserSessionState;
  page: Page;
  bindings: ReadonlyArray<{
    binding: FillableFormFieldBinding;
    target: TargetDescriptor | null;
  }>;
  protectedValues: Record<string, string>;
  fieldPolicies?: StoredSecretFieldPolicies;
}): Promise<Map<string, string>> {
  const assistedBindings = params.bindings.filter(({ binding }) => {
    return resolveProtectedFieldPolicy(params.fieldPolicies, binding.fieldKey) === 'llm_assisted';
  });

  if (params.session) {
    recordPayloadBudget(params.session, {
      protectedBindingsSeen: params.bindings.length,
    });
  }

  if (assistedBindings.length === 0) {
    return new Map();
  }

  const resolvedValues = new Map<string, string>();
  const unresolvedBindings = assistedBindings.filter(({ binding, target }) => {
    const deterministicValue = resolveDeterministicProtectedBindingValue(
      binding,
      params.protectedValues,
      target ?? undefined
    );
    if (
      typeof deterministicValue !== 'string' ||
      deterministicValue.trim().length === 0 ||
      !canUseDeterministicValueForPolicy(binding, params.fieldPolicies)
    ) {
      return true;
    }

    resolvedValues.set(protectedBindingKey(binding), deterministicValue.trim());
    return false;
  });

  if (params.session) {
    recordPayloadBudget(params.session, {
      protectedBindingsSent: unresolvedBindings.length,
    });
  }

  if (unresolvedBindings.length === 0) {
    return resolvedValues;
  }

  const client = tryCreateAgentbrowseAssistiveLlmClient({ session: params.session });
  if (!client) {
    throw new AgentbrowseAssistiveRuntimeMissingError('protected field value resolution');
  }
  const pageLocale = await params.page
    .evaluate(() => document.documentElement.lang || document.body?.lang || '')
    .catch(() => '');

  const prompt = [
    'You are resolving UI-ready values for already matched protected fields.',
    'Do not invent new bindings. Use only the provided targetRef values.',
    'Return one resolved value per binding.',
    'Use page language, target labels, and field hints to adapt the stored value to the visible UI representation.',
    'Examples:',
    '- full_name + valueHint=full_name.given -> return only the given/first-name part',
    '- full_name + valueHint=full_name.family -> return only the family/last-name part',
    '- nationality or issuing_country may require a localized UI value such as Россия for RU',
    'If unsure, return confidence=low for that binding.',
    '',
    `pageLocale=${JSON.stringify(pageLocale)}`,
    'Bindings:',
    ...unresolvedBindings.map(({ binding, target }) => {
      const storedValue = params.protectedValues[binding.fieldKey] ?? '';
      return `${buildBindingSummary(binding, target)} | storedValue=${JSON.stringify(storedValue)}`;
    }),
  ].join('\n');

  const result = await client.createChatCompletion<z.infer<typeof protectedFieldValuesSchema>>({
    logger: () => {},
    options: {
      messages: [{ role: 'user', content: prompt }],
      response_model: {
        name: 'ProtectedFieldValues',
        schema: protectedFieldValuesSchema,
      },
    },
  });

  if (params.session) {
    recordLlmUsage(params.session, {
      purpose: 'browse.protected_fill.resolve',
      usage: result.usage,
      inputChars: prompt.length,
    });
  }

  const allowedKeys = new Set(
    unresolvedBindings.map(({ binding }) => protectedBindingKey(binding))
  );

  for (const entry of result.data.values) {
    const key = protectedBindingKey(entry);
    if (!allowedKeys.has(key) || entry.confidence === 'low') {
      continue;
    }
    const value = entry.value.trim();
    if (!value) {
      continue;
    }
    resolvedValues.set(key, value);
  }

  return resolvedValues;
}
