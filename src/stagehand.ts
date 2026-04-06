/**
 * Generic Stagehand v3 connector for an existing browser session.
 */

import { Stagehand } from '@browserbasehq/stagehand';

export interface StagehandSession {
  stagehand: Stagehand;
}

export interface StagehandConnectOptions {
  llmClient?: unknown;
  domSettleTimeout?: number;
  verbose?: 0 | 1 | 2;
}

/** Connect to an existing browser via CDP URL. */
export async function connectStagehand(
  cdpUrl: string,
  options: StagehandConnectOptions = {}
): Promise<Stagehand> {
  const stagehand = new Stagehand({
    env: 'LOCAL',
    ...(options.llmClient ? { llmClient: options.llmClient as never } : {}),
    localBrowserLaunchOptions: {
      cdpUrl,
    },
    keepAlive: true,
    domSettleTimeout: options.domSettleTimeout ?? 5000,
    verbose: options.verbose ?? 0,
  });

  await stagehand.init();
  return stagehand;
}
