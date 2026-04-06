import type { BrowserSessionState } from './browser-session-state.js';
import {
  connectPlaywright,
  disconnectPlaywright,
  resolvePageByRef,
  syncSessionPage,
} from './playwright-runtime.js';
import {
  executeProtectedFill,
  type ProtectedFillExecutionResult,
} from './secrets/protected-fill.js';
import type {
  PersistedFillableForm,
  StoredSecretFieldPolicies,
  StoredSecretFieldKey,
} from './secrets/types.js';

export type FillProtectedFormBrowserResult =
  | {
      success: true;
      pageRef: string;
      url: string;
      title: string;
      execution: ProtectedFillExecutionResult;
    }
  | {
      success: false;
      error: 'browser_connection_failed' | 'page_resolution_failed';
      message: string;
      reason: string;
    };

export async function fillProtectedFormBrowser(params: {
  session: BrowserSessionState;
  fillableForm: PersistedFillableForm;
  protectedValues: Partial<Record<StoredSecretFieldKey, string>>;
  fieldPolicies?: StoredSecretFieldPolicies;
}): Promise<FillProtectedFormBrowserResult> {
  let browser: Awaited<ReturnType<typeof connectPlaywright>> | null = null;

  try {
    browser = await connectPlaywright(params.session.cdpUrl);
  } catch (error) {
    return {
      success: false,
      error: 'browser_connection_failed',
      message: 'Protected fill could not connect to the browser.',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const page = await resolvePageByRef(browser, params.session, params.fillableForm.pageRef).catch(
      (error) => {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
    );
    const { url, title } = await syncSessionPage(params.session, params.fillableForm.pageRef, page);
    const execution = await executeProtectedFill({
      session: params.session,
      page,
      fillableForm: params.fillableForm,
      protectedValues: Object.fromEntries(
        Object.entries(params.protectedValues).filter((entry) => {
          const value = entry[1];
          return typeof value === 'string' && value.length > 0;
        })
      ) as Record<string, string>,
      fieldPolicies: params.fieldPolicies,
    });

    return {
      success: true,
      pageRef: params.fillableForm.pageRef,
      url,
      title,
      execution,
    };
  } catch (error) {
    return {
      success: false,
      error: 'page_resolution_failed',
      message: 'Protected fill could not resolve the target page in the browser.',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (browser) {
      await disconnectPlaywright(browser);
    }
  }
}
