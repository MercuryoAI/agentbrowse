import type { Stagehand } from '@browserbasehq/stagehand';
import type { BrowserSessionState } from './browser-session-state.js';
import { connectAssistiveStagehand } from './assistive-stagehand.js';

export async function withStagehand<T>(
  session: BrowserSessionState,
  run: (stagehand: Stagehand) => Promise<T>
): Promise<T> {
  const stagehand = await connectAssistiveStagehand(session.cdpUrl, { session });
  try {
    return await run(stagehand);
  } finally {
    await stagehand.close().catch(() => undefined);
  }
}
