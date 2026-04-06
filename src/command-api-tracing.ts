import { AsyncLocalStorage } from 'node:async_hooks';
import { recordDiagnosticChildSpanBestEffort, type DiagnosticCommand } from './diagnostics.js';

type ApiTraceContext = {
  runId?: string;
  stepId?: string;
  command: DiagnosticCommand;
};

type TracedFetchOptions = {
  spanName: string;
  attributes?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
};

type TracedStepOperationOptions = {
  spanName: string;
  attributes?: Record<string, unknown>;
};

const apiTraceContextStorage = new AsyncLocalStorage<ApiTraceContext>();

function sanitizeTraceUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return value;
  }
}

function resolveMethod(input: RequestInfo | URL, init?: RequestInit): string {
  const initMethod = init?.method?.trim();
  if (initMethod) {
    return initMethod.toUpperCase();
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.method.toUpperCase();
  }
  return 'GET';
}

function resolveUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === 'string') {
    return input;
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return input.url;
  }
  return String(input);
}

function buildTraceAttributes(
  context: ApiTraceContext,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  extraAttributes: Record<string, unknown> | undefined
): Record<string, unknown> {
  const url = resolveUrl(input);
  const method = resolveMethod(input, init);
  let hostname: string | undefined;
  let pathname: string | undefined;

  try {
    const parsed = new URL(url);
    hostname = parsed.host;
    pathname = parsed.pathname;
  } catch {}

  return {
    'agentbrowse.api.command': context.command,
    'http.request.method': method,
    'url.full': sanitizeTraceUrl(url),
    ...(hostname ? { 'server.address': hostname } : {}),
    ...(pathname ? { 'url.path': pathname } : {}),
    ...(extraAttributes ?? {}),
  };
}

export async function withApiTraceContext<T>(
  context: ApiTraceContext,
  run: () => Promise<T>
): Promise<T> {
  return apiTraceContextStorage.run(context, run);
}

export async function tracedStepOperation<T>(
  run: () => Promise<T> | T,
  options?: TracedStepOperationOptions
): Promise<T> {
  const context = apiTraceContextStorage.getStore();
  if (!context?.runId || !context.stepId || !options?.spanName) {
    return run();
  }

  const startedAt = new Date().toISOString();
  const attributes = {
    'agentbrowse.api.command': context.command,
    ...(options.attributes ?? {}),
  };

  try {
    const result = await run();
    recordDiagnosticChildSpanBestEffort({
      step: {
        runId: context.runId,
        stepId: context.stepId,
        command: context.command,
      },
      name: options.spanName,
      startedAt,
      endedAt: new Date().toISOString(),
      statusCode: 'ok',
      attributes,
    });
    return result;
  } catch (error) {
    recordDiagnosticChildSpanBestEffort({
      step: {
        runId: context.runId,
        stepId: context.stepId,
        command: context.command,
      },
      name: options.spanName,
      startedAt,
      endedAt: new Date().toISOString(),
      statusCode: 'error',
      statusMessage: error instanceof Error ? error.message : String(error),
      attributes,
    });
    throw error;
  }
}

export async function tracedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: TracedFetchOptions
): Promise<Response> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const context = apiTraceContextStorage.getStore();
  if (!context?.runId || !context.stepId || !options?.spanName) {
    return fetchImpl(input, init);
  }

  const startedAt = new Date().toISOString();
  const attributes = buildTraceAttributes(context, input, init, options.attributes);

  try {
    const response = await fetchImpl(input, init);
    recordDiagnosticChildSpanBestEffort({
      step: {
        runId: context.runId,
        stepId: context.stepId,
        command: context.command,
      },
      name: options.spanName,
      startedAt,
      endedAt: new Date().toISOString(),
      statusCode: response.ok ? 'ok' : 'error',
      ...(response.ok ? {} : { statusMessage: `http_${response.status}` }),
      attributes: {
        ...attributes,
        'http.response.status_code': response.status,
      },
    });
    return response;
  } catch (error) {
    recordDiagnosticChildSpanBestEffort({
      step: {
        runId: context.runId,
        stepId: context.stepId,
        command: context.command,
      },
      name: options.spanName,
      startedAt,
      endedAt: new Date().toISOString(),
      statusCode: 'error',
      statusMessage: error instanceof Error ? error.message : String(error),
      attributes,
    });
    throw error;
  }
}
