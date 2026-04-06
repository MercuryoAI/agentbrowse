import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import type { BrowseAction } from './browse-actions.js';

type TraceController = {
  finishSuccess(): Promise<void>;
  finishFailure(artifactDir: string): Promise<string | undefined>;
};

export type ActionFailureArtifacts = {
  dir: string;
  screenshotPath?: string;
  htmlPath?: string;
  tracePath?: string;
  actionLogPath: string;
};

function sanitizeSegment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'item'
  );
}

export async function startActionTrace(
  page: Page,
  options: {
    suppressSensitiveArtifacts?: boolean;
  } = {}
): Promise<TraceController> {
  if (options.suppressSensitiveArtifacts) {
    return {
      finishSuccess: async () => {},
      finishFailure: async () => undefined,
    };
  }

  const tracing = (
    page.context() as {
      tracing?: {
        start(options?: unknown): Promise<void>;
        stop(options?: unknown): Promise<void>;
      };
    }
  ).tracing;

  if (!tracing?.start || !tracing?.stop) {
    return {
      finishSuccess: async () => {},
      finishFailure: async () => undefined,
    };
  }

  let active = false;
  try {
    await tracing.start({ screenshots: true, snapshots: true });
    active = true;
  } catch {
    active = false;
  }

  return {
    finishSuccess: async () => {
      if (!active) return;
      active = false;
      try {
        await tracing.stop();
      } catch {
        // Best effort only.
      }
    },
    finishFailure: async (artifactDir: string) => {
      if (!active) return undefined;
      active = false;
      const tracePath = path.join(artifactDir, 'trace.zip');
      try {
        await tracing.stop({ path: tracePath });
        return tracePath;
      } catch {
        return undefined;
      }
    },
  };
}

export async function captureActionFailureArtifacts(params: {
  page: Page;
  targetRef: string;
  action: BrowseAction;
  pageRef: string;
  attempts: string[];
  locatorStrategy?: string | null;
  popup: boolean;
  overlayHandled: boolean;
  iframe: boolean;
  jsFallback: boolean;
  durationMs: number;
  error: string;
  finishTrace(artifactDir: string): Promise<string | undefined>;
}): Promise<ActionFailureArtifacts> {
  const artifactDir = path.join(
    tmpdir(),
    'agentbrowse-artifacts',
    `act-${Date.now()}-${sanitizeSegment(params.targetRef)}-${sanitizeSegment(params.action)}`
  );
  await mkdir(artifactDir, { recursive: true });

  let screenshotPath: string | undefined;
  try {
    screenshotPath = path.join(artifactDir, 'page.png');
    await params.page.screenshot({ path: screenshotPath, fullPage: true });
  } catch {
    screenshotPath = undefined;
  }

  let htmlPath: string | undefined;
  try {
    htmlPath = path.join(artifactDir, 'page.html');
    const html = await params.page.content();
    await writeFile(htmlPath, html, 'utf-8');
  } catch {
    htmlPath = undefined;
  }

  const tracePath = await params.finishTrace(artifactDir);
  const actionLogPath = path.join(artifactDir, 'action-log.json');

  await writeFile(
    actionLogPath,
    JSON.stringify(
      {
        targetRef: params.targetRef,
        action: params.action,
        pageRef: params.pageRef,
        locatorStrategy: params.locatorStrategy ?? undefined,
        attempts: params.attempts,
        popup: params.popup,
        overlayHandled: params.overlayHandled,
        iframe: params.iframe,
        jsFallback: params.jsFallback,
        durationMs: params.durationMs,
        error: params.error,
        screenshotPath,
        htmlPath,
        tracePath,
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  return {
    dir: artifactDir,
    screenshotPath,
    htmlPath,
    tracePath,
    actionLogPath,
  };
}
