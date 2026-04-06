#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

loadEnv();

import { browseCommand, browseCommandName } from './command-name.js';
import { assertSemanticObserveRuntimeSupport } from './commands/semantic-observe-lexical.js';
import type { BrowseSession } from './session.js';
import { loadSession } from './session.js';
import { outputContractFailure, outputError, outputJSON, fatal, info } from './output.js';

function usageText(): string {
  return `Usage: ${browseCommandName()} <command> [args] [options]

Commands:
  launch [url] [options]          Launch browser, optionally navigate to URL
  attach <cdp-url> [options]      Attach to an existing browser over CDP
  browser-status                  Check live browser/page/runtime state
  navigate <url>                  Navigate current tab to URL
  act <targetRef> <action> [value] Perform action on a previously observed target
  extract '<schema-json>' [scopeRef] Extract structured data from the page or a stored scope
  observe ["<goal>"]              Discover available targets/elements
  screenshot [--path <file>]      Capture a screenshot
  close                           Close browser and clean up

Options:
  --compact                       Launch browser in compact window size (1280x900, default)
  --full                          Launch browser in full-size window
  --profile <name>                Solver profile name for launch (default: "default")
  --proxy [url]                   Launch through configured proxy, or use one-off override URL
  --provider <name>               Optional provider label for attach (for example "browserbase")
  --headful                       Explicit alias for headful browser mode (default)
  --headless                      Launch browser in headless mode
  --path <file>                   Output path for screenshot
  --help                          Show this help message`;
}

const KNOWN_COMMANDS = new Set([
  'launch',
  'attach',
  'browser-status',
  'navigate',
  'act',
  'extract',
  'observe',
  'screenshot',
  'close',
]);

function getCommand(argv: string[] = process.argv): { command: string; args: string[] } | null {
  const rawArgs = argv.slice(2);

  if (rawArgs.length === 0 || rawArgs[0] === '--help') {
    info(usageText());
    process.exit(0);
  }

  const command = rawArgs[0]!;
  const args = rawArgs.slice(1);
  return { command, args };
}

/** Parse --key value or --key 'value' from args array. */
function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Get the first positional argument (not starting with --). */
function getPositional(args: string[], valueFlags: string[] = []): string | undefined {
  const valueFlagSet = new Set(valueFlags);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg.startsWith('--')) {
      if (valueFlagSet.has(arg)) {
        i += 1;
      }
      continue;
    }

    return arg;
  }

  return undefined;
}

function getPositionals(args: string[], valueFlags: string[] = []): string[] {
  const valueFlagSet = new Set(valueFlags);
  const values: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg.startsWith('--')) {
      if (valueFlagSet.has(arg)) {
        i += 1;
      }
      continue;
    }

    values.push(arg);
  }

  return values;
}

function parseLaunchArgs(args: string[]): {
  url?: string;
  compact: boolean;
  profile?: string;
  headless: boolean;
  useProxy: boolean;
  proxy?: string;
} {
  let url: string | undefined;
  let compact = true;
  let profile: string | undefined;
  let headless = false;
  let useProxy = false;
  let proxy: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--headless') {
      headless = true;
      continue;
    }

    if (arg === '--headful') {
      headless = false;
      continue;
    }

    if (arg === '--compact') {
      compact = true;
      continue;
    }

    if (arg === '--full') {
      compact = false;
      continue;
    }

    if (arg === '--profile') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        outputError(
          `Usage: ${browseCommand('launch', '[url]', '[--profile <name>]', '[--proxy [url]]', '[--headful|--headless]')}`
        );
      }
      profile = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--proxy=')) {
      const value = arg.slice('--proxy='.length).trim();
      if (!value) {
        outputError(
          `Usage: ${browseCommand('launch', '[url]', '[--profile <name>]', '[--proxy [url]]', '[--headful|--headless]')}`
        );
      }
      useProxy = true;
      proxy = value;
      continue;
    }

    if (arg === '--proxy') {
      useProxy = true;
      const value = args[i + 1];
      const trailingPositionals = args.slice(i + 1).filter((entry) => !entry.startsWith('--'));
      if (value && !value.startsWith('--') && (url || trailingPositionals.length > 1)) {
        proxy = value;
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('--')) {
      outputError(`Unknown launch option: ${arg}`);
    }

    if (url) {
      outputError(
        `Usage: ${browseCommand('launch', '[url]', '[--profile <name>]', '[--proxy [url]]', '[--headful|--headless]')}`
      );
    }
    url = arg;
  }

  return { url, compact, profile, headless, useProxy, proxy };
}

function parseAttachArgs(args: string[]): {
  cdpUrl: string;
  provider?: string;
} {
  let cdpUrl: string | undefined;
  let provider: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--provider') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        outputError(`Usage: ${browseCommand('attach', '<cdp-url>', '[--provider <name>]')}`);
      }
      provider = value;
      i += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      outputError(`Unknown attach option: ${arg}`);
    }

    if (cdpUrl) {
      outputError(`Usage: ${browseCommand('attach', '<cdp-url>', '[--provider <name>]')}`);
    }

    cdpUrl = arg;
  }

  if (!cdpUrl) {
    outputError(`Usage: ${browseCommand('attach', '<cdp-url>', '[--provider <name>]')}`);
  }

  return {
    cdpUrl: cdpUrl!,
    ...(provider ? { provider } : {}),
  };
}

/** Require an active browser session. */
function requireLaunchedBrowserSessionRecord(command: string): BrowseSession {
  const session = loadSession();
  if (session) {
    return session;
  }

  return outputContractFailure({
    error: 'browser_session_required',
    outcomeType: 'blocked',
    message: `The \`${command}\` command requires an active browser session.`,
    reason: `No persisted browser session was found. Run \`${browseCommandName()} launch [url]\` or \`${browseCommandName()} attach <cdp-url>\` first.`,
  });
}

async function main(argv: string[] = process.argv): Promise<void> {
  const parsed = getCommand(argv);
  if (!parsed) process.exit(1);

  const { command, args } = parsed;

  if (!KNOWN_COMMANDS.has(command)) {
    outputError(`Unknown command: ${command}\n\n${usageText()}`);
  }

  try {
    assertSemanticObserveRuntimeSupport();
  } catch (err) {
    outputError(err instanceof Error ? err.message : String(err));
  }

  switch (command) {
    case 'launch': {
      const { launch } = await import('./commands/launch.js');
      const { close } = await import('./commands/close.js');
      const { saveBrowserSession } = await import('./browser-session-state.js');
      const { deleteWorkflowContext } = await import('./session.js');
      const { checkForLaunchUpdate } = await import('./update-check.js');
      const launchArgs = parseLaunchArgs(args);
      const updateNoticePromise = checkForLaunchUpdate().catch(() => null);
      const existingSession = loadSession();
      await Promise.resolve(close(existingSession)).catch(() => undefined);
      deleteWorkflowContext();
      const launchResult = await launch(launchArgs.url, {
        compact: launchArgs.compact,
        profile: launchArgs.profile,
        headless: launchArgs.headless,
        useProxy: launchArgs.useProxy,
        proxy: launchArgs.proxy,
      });
      if (launchResult.success) {
        saveBrowserSession(launchResult.session);
      }
      const updateNotice = await Promise.race([
        updateNoticePromise,
        new Promise<null>((resolve) => {
          queueMicrotask(() => resolve(null));
        }),
      ]);
      if (updateNotice) {
        info(updateNotice.message);
      }
      outputJSON(launchResult);
      break;
    }

    case 'attach': {
      const { attach } = await import('./commands/attach.js');
      const { close } = await import('./commands/close.js');
      const { saveBrowserSession } = await import('./browser-session-state.js');
      const { deleteWorkflowContext } = await import('./session.js');
      const attachArgs = parseAttachArgs(args);
      const existingSession = loadSession();
      await Promise.resolve(close(existingSession)).catch(() => undefined);
      deleteWorkflowContext();
      const attachResult = await attach(attachArgs.cdpUrl, {
        ...(attachArgs.provider ? { provider: attachArgs.provider } : {}),
      });
      if (attachResult.success) {
        saveBrowserSession(attachResult.session);
      }
      outputJSON(attachResult);
      break;
    }

    case 'navigate': {
      const url = getPositional(args);
      if (!url) outputError(`Usage: ${browseCommand('navigate', '<url>')}`);
      const { navigate } = await import('./commands/navigate.js');
      await navigate(requireLaunchedBrowserSessionRecord(command), url!);
      break;
    }

    case 'act': {
      const positionals = getPositionals(args);
      const [targetRef, action, ...valueParts] = positionals;
      if (!targetRef || !action) {
        outputError(`Usage: ${browseCommand('act', '<targetRef>', '<action>', '[value]')}`);
      }

      const { act, isBrowseAction } = await import('./commands/act.js');
      if (!isBrowseAction(action)) {
        outputError(
          `Unsupported act action: ${action}. Expected one of: click, fill, type, select, press.`
        );
      }

      await act(
        requireLaunchedBrowserSessionRecord(command),
        targetRef!,
        action,
        valueParts.length > 0 ? valueParts.join(' ') : undefined
      );
      break;
    }

    case 'extract': {
      const positionals = getPositionals(args);
      const [schemaJson, scopeRef] = positionals;
      if (!schemaJson) {
        outputError(`Usage: ${browseCommand('extract', "'<schema-json>'", '[scopeRef]')}`);
      }

      const { extract } = await import('./commands/extract.js');
      await extract(requireLaunchedBrowserSessionRecord(command), schemaJson!, scopeRef);
      break;
    }

    case 'observe': {
      const instruction = getPositional(args);
      const { observe } = await import('./commands/observe.js');
      await observe(requireLaunchedBrowserSessionRecord(command), instruction);
      break;
    }

    case 'screenshot': {
      if (hasFlag(args, '--help')) {
        info(`Usage: ${browseCommand('screenshot', '[--path <file>]')}`);
        process.exit(0);
      }
      const filePath = getFlag(args, '--path');
      const { screenshot } = await import('./commands/screenshot.js');
      await screenshot(requireLaunchedBrowserSessionRecord(command), filePath);
      break;
    }

    case 'browser-status': {
      const { browserStatus } = await import('./commands/browser-status.js');
      outputJSON(await browserStatus(requireLaunchedBrowserSessionRecord(command)));
      break;
    }

    case 'close': {
      const session = loadSession();
      const { close } = await import('./commands/close.js');
      const { deleteSession } = await import('./session.js');
      const result = await close(session);
      if (result.success) {
        deleteSession();
      }
      outputJSON(result);
      break;
    }
  }
}

export { main };

export function isDirectExecution(metaUrl: string, argv: string[] = process.argv): boolean {
  const entry = argv[1];
  if (!entry) {
    return false;
  }

  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((err) => {
    fatal(err instanceof Error ? err.message : String(err));
  });
}
