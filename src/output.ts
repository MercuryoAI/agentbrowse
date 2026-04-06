import { browseCommandName } from './command-name.js';

/**
 * Structured output helpers.
 * Machine-readable JSON to stdout.
 */

export interface BrowseResult {
  success: boolean;
  error?: string;
  url?: string;
  title?: string;
  [key: string]: unknown;
}

export interface BrowseContractFailure extends Omit<BrowseResult, 'success'> {
  error: string;
  outcomeType: string;
  message: string;
  reason: string;
}

function serializeResult(result: BrowseResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** Write final structured result to stdout and exit. */
export function outputJSON(result: BrowseResult): never {
  const normalizedResult = result.success
    ? result
    : { ...result, error: result.error ?? 'Unknown error' };
  process.stdout.write(serializeResult(normalizedResult));
  process.exit(result.success ? 0 : 1);
}

/** Write structured failure result to stdout and exit 1. */
export function outputFailure(result: Omit<BrowseResult, 'success'> & { error: string }): never {
  outputJSON({ success: false, ...result });
}

/** Write a normalized contract failure result to stderr and exit 1. */
export function outputContractFailure(result: BrowseContractFailure): never {
  outputFailure(result);
}

/** Write error to stderr and exit 1. */
export function outputError(error: string): never {
  outputFailure({ error });
}

/** Write a progress/info message to stderr. */
export function info(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Fatal crash — unhandled error, exit 1. */
export function fatal(message: string): never {
  process.stderr.write(`[${browseCommandName()}] Fatal: ${message}\n`);
  process.exit(1);
}
