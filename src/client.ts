import type { BrowserCommandSession, BrowserSessionState } from './browser-session-state.js';
import type { AgentbrowseAssistiveRuntime } from './assistive-runtime.js';
import type { AgentbrowseDiagnosticsHooks } from './diagnostics.js';
import { bindAgentbrowseSession } from './client-bindings.js';
import { actBrowser, type ActResult, type BrowseAction } from './commands/act.js';
import { attach, type AttachOptions, type AttachResult } from './commands/attach.js';
import { browserStatus, type BrowserStatusResult } from './commands/browser-status.js';
import { close, type CloseResult } from './commands/close.js';
import { extractBrowser, type ExtractResult, type ExtractSchemaInput } from './commands/extract.js';
import { launch, type LaunchOptions, type LaunchResult } from './commands/launch.js';
import { navigateBrowser, type NavigateResult } from './commands/navigate.js';
import { observeBrowser, type ObserveResult } from './commands/observe.js';
import { screenshotBrowser, type ScreenshotResult } from './commands/screenshot.js';

/** Client-scoped bindings for assistive runtime and diagnostics hooks. */
export interface AgentbrowseClientOptions {
  assistiveRuntime?: AgentbrowseAssistiveRuntime | null;
  diagnostics?: AgentbrowseDiagnosticsHooks | null;
}

/**
 * Embedded library surface with client-scoped configuration.
 *
 * Use this when your application wants to keep assistive runtime and diagnostics
 * local to one tenant, workflow, or test process instead of relying on
 * process-global helpers.
 */
export interface AgentbrowseClient {
  /** Binds assistive runtime and diagnostics hooks to a session object in-place. */
  bindSession<TSession extends BrowserSessionState>(session: TSession): TSession;
  /** Attaches to an existing browser via a websocket or HTTP CDP endpoint. */
  attach(cdpUrl: string, options?: AttachOptions): Promise<AttachResult>;
  /** Launches a managed browser session. */
  launch(url?: string, options?: LaunchOptions): Promise<LaunchResult>;
  /** Reads the current browser and page status. */
  status(session: BrowserCommandSession): Promise<BrowserStatusResult>;
  /** Navigates the current page to a new URL. */
  navigate(session: BrowserCommandSession, nextUrl: string): Promise<NavigateResult>;
  /** Observes the current page and returns action targets and scopes. */
  observe(session: BrowserCommandSession, instruction?: string): Promise<ObserveResult>;
  /** Runs a deterministic action against a stored observed target. */
  act(
    session: BrowserCommandSession,
    targetRef: string,
    action: BrowseAction,
    value?: string
  ): Promise<ActResult>;
  /** Extracts structured data using a plain schema object or Zod schema. */
  extract(
    session: BrowserCommandSession,
    schema: ExtractSchemaInput,
    scopeRef?: string
  ): Promise<ExtractResult>;
  /** Captures a screenshot of the current page. */
  screenshot(session: BrowserCommandSession, outputPath?: string): Promise<ScreenshotResult>;
  /** Closes the current browser session when AgentBrowse owns it. */
  close(session: BrowserCommandSession): Promise<CloseResult>;
}

/** Creates an AgentBrowse client with client-scoped assistive runtime and diagnostics hooks. */
export function createAgentbrowseClient(options: AgentbrowseClientOptions = {}): AgentbrowseClient {
  const bindings = {
    ...(options.assistiveRuntime ? { assistiveRuntime: options.assistiveRuntime } : {}),
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  };

  const bindSession = <TSession extends BrowserSessionState>(session: TSession): TSession =>
    bindAgentbrowseSession(session, bindings) as TSession;

  return {
    bindSession,
    async attach(cdpUrl: string, attachOptions: AttachOptions = {}): Promise<AttachResult> {
      const result = await attach(cdpUrl, attachOptions);
      if (result.success) {
        bindSession(result.session);
      }
      return result;
    },
    async launch(url?: string, launchOptions: LaunchOptions = {}): Promise<LaunchResult> {
      const result = await launch(url, launchOptions);
      if (result.success) {
        bindSession(result.session);
      }
      return result;
    },
    status(session) {
      bindSession(session);
      return browserStatus(session);
    },
    navigate(session, nextUrl) {
      bindSession(session);
      return navigateBrowser(session, nextUrl);
    },
    observe(session, instruction) {
      bindSession(session);
      return observeBrowser(session, instruction);
    },
    act(session, targetRef, action, value) {
      bindSession(session);
      return actBrowser(session, targetRef, action, value);
    },
    extract(session, schema, scopeRef) {
      bindSession(session);
      return extractBrowser(session, schema, scopeRef);
    },
    screenshot(session, outputPath) {
      bindSession(session);
      return screenshotBrowser(session, outputPath);
    },
    close(session) {
      bindSession(session);
      return close(session);
    },
  };
}
