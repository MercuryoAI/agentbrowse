import type { BrowserSessionState } from './browser-session-state.js';
import type { Stagehand } from '@browserbasehq/stagehand';
import { connectConfiguredAssistiveStagehand } from './assistive-runtime.js';

/**
 * Connect Stagehand with the currently configured assistive runtime.
 *
 * This stays separate from the generic Stagehand connector so the browser-core
 * layer does not own orchestration/backend setup directly.
 */
export async function connectAssistiveStagehand(
  cdpUrl: string,
  options: {
    session?: BrowserSessionState | null;
  } = {}
): Promise<Stagehand> {
  return connectConfiguredAssistiveStagehand(cdpUrl, options);
}
