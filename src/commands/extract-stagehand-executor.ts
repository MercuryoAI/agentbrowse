import type { Page } from 'playwright-core';
import { extract as runExtract } from '@browserbasehq/stagehand/lib/inference.js';
import { v3Logger } from '@browserbasehq/stagehand/lib/v3/logger.js';
import { captureHybridSnapshot } from '@browserbasehq/stagehand/lib/v3/understudy/a11y/snapshot/index.js';
import type { z } from 'zod';
import type { BrowseSession } from '../session.js';
import { incrementMetric, recordLlmUsage, recordPayloadBudget } from '../runtime-metrics.js';
import { stagehandRuntimeResolution, type RuntimeResolution } from '../runtime-resolution.js';
import { withStagehand } from '../stagehand-runtime.js';
import { readLocatorOuterHtml } from './descriptor-validation.js';
import { budgetExtractSnapshot, sanitizeExtractSnapshot } from './extract-snapshot-sanitizer.js';

export type ExtractStagehandExecution = RuntimeResolution & {
  data: unknown;
  resolvedBy: 'stagehand-extract';
};

type InternalStagehand = {
  resolvePage?: (page?: Page) => Promise<unknown>;
  extract?: (
    instruction: string,
    schema: z.ZodType,
    options: { page: Page; selector?: string }
  ) => Promise<unknown>;
  llmClient: unknown;
  opts?: {
    systemPrompt?: string;
  };
  logInferenceToFile?: boolean;
  experimental?: boolean;
};

const SCOPED_EXTRACT_MIRROR_SELECTOR = '#agentbrowse-scope';

async function mirrorScopedSnapshotPage(
  page: Page,
  selector: string
): Promise<{
  page: Page;
  focusSelector: string;
  cleanup: () => Promise<void>;
} | null> {
  if (!selector || selector === SCOPED_EXTRACT_MIRROR_SELECTOR) {
    return null;
  }

  const locator = page.locator(selector);
  const first = locator.first();
  const count = typeof first.count === 'function' ? await first.count().catch(() => 0) : 1;
  if (count === 0) {
    return null;
  }

  let scopedHtml = await readLocatorOuterHtml(first).catch(() => null);
  if (!scopedHtml) {
    scopedHtml = await first
      .evaluate((element) => (element instanceof Element ? element.outerHTML : null))
      .catch(() => null);
  }
  if (!scopedHtml) {
    return null;
  }

  const scratchPage = await page.context().newPage();
  await scratchPage.setContent(
    `<!doctype html><html lang="en"><body><div id="agentbrowse-scope">${scopedHtml}</div></body></html>`
  );

  return {
    page: scratchPage,
    focusSelector: SCOPED_EXTRACT_MIRROR_SELECTOR,
    cleanup: async () => {
      await scratchPage.close().catch(() => undefined);
    },
  };
}

export async function executeStagehandExtract(args: {
  session: BrowseSession;
  instruction: string;
  schema: z.ZodType;
  page: Page;
  selector?: string;
  degradationReason?: string;
}): Promise<ExtractStagehandExecution> {
  const { session, instruction, schema, page, selector, degradationReason } = args;
  const data = await withStagehand(session, async (stagehand) => {
    incrementMetric(session, 'stagehandCalls');
    const internalStagehand = stagehand as unknown as InternalStagehand;
    const resolvePage = internalStagehand.resolvePage;

    if (typeof resolvePage !== 'function') {
      if (typeof internalStagehand.extract !== 'function') {
        throw new Error('Stagehand runtime does not expose resolvePage() for sanitized extract');
      }

      return internalStagehand.extract(instruction, schema, {
        page,
        selector,
      });
    }

    const extractPage = await resolvePage.call(internalStagehand, page);
    let snapshotPage = extractPage;
    let focusSelector = selector?.replace(/^xpath=/i, '') ?? '';
    let cleanupMirroredSnapshot: (() => Promise<void>) | null = null;

    try {
      if (selector) {
        const mirroredSnapshot = await mirrorScopedSnapshotPage(page, selector);
        if (mirroredSnapshot) {
          cleanupMirroredSnapshot = mirroredSnapshot.cleanup;
          snapshotPage = await resolvePage.call(internalStagehand, mirroredSnapshot.page);
          focusSelector = mirroredSnapshot.focusSelector;
        }
      }

      const snapshot = await captureHybridSnapshot(snapshotPage as never, {
        experimental: internalStagehand.experimental ?? false,
        focusSelector,
      });

      recordPayloadBudget(session, {
        extractSnapshotLinesSeen: snapshot.combinedTree.split(/\r?\n/).length,
      });
      const sanitizedTree = sanitizeExtractSnapshot(snapshot.combinedTree);
      const budgetedTree = budgetExtractSnapshot(sanitizedTree, {
        scoped: Boolean(selector),
      });
      recordPayloadBudget(session, {
        extractSnapshotLinesSent: budgetedTree.split(/\r?\n/).length,
      });
      const extractionResponse = await runExtract({
        instruction,
        domElements: budgetedTree,
        schema: schema as never,
        llmClient: internalStagehand.llmClient as never,
        userProvidedInstructions: internalStagehand.opts?.systemPrompt ?? '',
        logger: v3Logger,
        logInferenceToFile: internalStagehand.logInferenceToFile ?? false,
      });
      const {
        metadata: _metadata,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        reasoning_tokens: reasoningTokens,
        cached_input_tokens: cachedInputTokens,
        inference_time_ms: _inferenceTimeMs,
        ...result
      } = extractionResponse as Record<string, unknown>;
      recordLlmUsage(session, {
        purpose: 'browse.extract',
        inputChars: budgetedTree.length,
        promptTokens: typeof promptTokens === 'number' ? promptTokens : undefined,
        completionTokens: typeof completionTokens === 'number' ? completionTokens : undefined,
        cachedInputTokens: typeof cachedInputTokens === 'number' ? cachedInputTokens : undefined,
        reasoningTokens: typeof reasoningTokens === 'number' ? reasoningTokens : undefined,
      });

      return result;
    } finally {
      if (cleanupMirroredSnapshot) {
        await cleanupMirroredSnapshot().catch(() => undefined);
      }
    }
  });

  return {
    resolvedBy: 'stagehand-extract',
    ...stagehandRuntimeResolution(degradationReason),
    data,
  };
}
