import type { BrowserSessionState } from './browser-session-state.js';
import type { AgentbrowseAssistiveRuntime } from './assistive-runtime.js';
import type { AgentbrowseDiagnosticsHooks } from './diagnostics.js';

export interface AgentbrowseSessionBindings {
  assistiveRuntime?: AgentbrowseAssistiveRuntime | null;
  diagnostics?: AgentbrowseDiagnosticsHooks | null;
}

const bindingsBySession = new WeakMap<BrowserSessionState, AgentbrowseSessionBindings>();

export function bindAgentbrowseSession(
  session: BrowserSessionState,
  bindings: AgentbrowseSessionBindings
): BrowserSessionState {
  if (!bindings.assistiveRuntime && !bindings.diagnostics) {
    bindingsBySession.delete(session);
    return session;
  }

  bindingsBySession.set(session, {
    ...(bindings.assistiveRuntime ? { assistiveRuntime: bindings.assistiveRuntime } : {}),
    ...(bindings.diagnostics ? { diagnostics: bindings.diagnostics } : {}),
  });
  return session;
}

export function getAgentbrowseSessionBindings(
  session: BrowserSessionState | null | undefined
): AgentbrowseSessionBindings | null {
  if (!session) {
    return null;
  }

  return bindingsBySession.get(session) ?? null;
}
