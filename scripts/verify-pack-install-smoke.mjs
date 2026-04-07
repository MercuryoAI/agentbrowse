#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  linkWorkspacePackage,
  materializePackedPackage,
  resolveInstalledPackageDir,
} from './pack-smoke-consumer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(__dirname, '..');
const repoRoot = path.join(__dirname, '..', '..', '..');
const npmCacheDir = path.join(os.tmpdir(), 'agentbrowse-npm-cache');
const pnpmStoreDir = path.join(repoRoot, '.pnpm-store');

function extractPackJson(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Failed to parse npm pack --json output.');
  }

  return JSON.parse(stdout.slice(start, end + 1));
}

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      npm_config_cache: npmCacheDir,
      npm_config_loglevel: 'silent',
      npm_config_store_dir: pnpmStoreDir,
    },
  });
}

function runPnpm(args, cwd) {
  return run('pnpm', args, cwd);
}

function packTarball(sourceDir, destinationDir) {
  const output = runPnpm(['pack', '--pack-destination', destinationDir], sourceDir);
  const tgzPath = output.split('\n').filter(Boolean).at(-1)?.trim();
  if (!tgzPath) {
    throw new Error(`pnpm pack did not return a tarball path for ${sourceDir}.`);
  }
  return tgzPath;
}

function logStep(message) {
  process.stderr.write(`[agentbrowse smoke] ${message}\n`);
}

const workspaceRuntimeDependencies = [
  '@browserbasehq/stagehand',
  'dotenv',
  'playwright-core',
  'puppeteer',
  'puppeteer-extra',
  'puppeteer-extra-plugin-stealth',
  'snowball-stemmers',
  'zod',
];

const requiredExports = [
  'attach',
  'launch',
  'close',
  'status',
  'act',
  'observe',
  'navigate',
  'screenshot',
  'extract',
  'loadBrowserSession',
  'saveBrowserSession',
  'deleteBrowserSession',
  'buildAttachedSession',
  'buildOwnedSession',
  'isAttachedSession',
  'createAgentbrowseClient',
  'configureAgentbrowseAssistiveRuntime',
  'resetAgentbrowseAssistiveRuntime',
  'configureAgentbrowseDiagnostics',
  'resetAgentbrowseDiagnostics',
  'ACT_ERROR_CODES',
  'EXTRACT_ERROR_CODES',
  'OBSERVE_ERROR_CODES',
  'NAVIGATE_ERROR_CODES',
  'SCREENSHOT_ERROR_CODES',
  'LAUNCH_ERROR_CODES',
  'ATTACH_ERROR_CODES',
  'CLOSE_ERROR_CODES',
  'BROWSER_STATUS_OUTCOME_TYPES',
];

const requiredProtectedFillExports = ['fillProtectedForm'];
const requiredTestingExports = [
  'installFetchBackedTestAssistiveRuntime',
  'uninstallTestAssistiveRuntime',
];
const publishedExampleFiles = ['basic.ts', 'attach.ts', 'extract.ts'];

let tgzPath;
let tempDir;
let packDir;

try {
  logStep('Building package.');
  runPnpm(['run', 'build'], packageDir);
  packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbrowse-pack-install-'));
  logStep('Packing tarball.');
  tgzPath = packTarball(packageDir, packDir);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbrowse-pack-install-'));
  const consumerDir = path.join(tempDir, 'consumer');
  fs.mkdirSync(consumerDir, { recursive: true });

  fs.writeFileSync(
    path.join(consumerDir, 'package.json'),
    JSON.stringify(
      {
        name: 'agentbrowse-pack-install-smoke',
        private: true,
        type: 'module',
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  fs.writeFileSync(
    path.join(consumerDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['consumer-contract.ts'],
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  fs.writeFileSync(
    path.join(consumerDir, 'smoke.mjs'),
    `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as library from '@mercuryo-ai/agentbrowse';
import * as protectedFill from '@mercuryo-ai/agentbrowse/protected-fill';
import * as testing from '@mercuryo-ai/agentbrowse/testing';

const required = ${JSON.stringify(requiredExports)};
for (const key of required) {
  if (!(key in library)) {
    throw new Error('missing export: ' + key);
  }
}
const protectedFillRequired = ${JSON.stringify(requiredProtectedFillExports)};
for (const key of protectedFillRequired) {
  if (typeof protectedFill[key] !== 'function') {
    throw new Error('missing protected-fill export: ' + key);
  }
}
const testingRequired = ${JSON.stringify(requiredTestingExports)};
for (const key of testingRequired) {
  if (typeof testing[key] !== 'function') {
    throw new Error('missing testing export: ' + key);
  }
}
for (const legacyKey of ['browserStatus', 'actBrowser', 'observeBrowser', 'navigateBrowser', 'screenshotBrowser', 'extractBrowser']) {
  if (legacyKey in library) {
    throw new Error('unexpected legacy export: ' + legacyKey);
  }
}
for (const rootLeak of ['fillProtectedFormBrowser', 'fillProtectedForm', 'PersistedFillableForm', 'StoredSecretKind', 'StoredSecretFieldKey']) {
  if (rootLeak in library) {
    throw new Error('unexpected root export: ' + rootLeak);
  }
}

const defaultHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbrowse-default-home-'));
const previousHome = process.env.HOME;
process.env.HOME = defaultHome;

try {
  library.saveBrowserSession({
    cdpUrl: 'ws://127.0.0.1:9333/devtools/browser/default-home',
    pid: 9333,
    launchedAt: '2026-04-04T12:00:00.000Z',
    profile: 'default',
  });

  const defaultSessionPath = path.join(defaultHome, '.agentbrowse', 'browse-session.json');
  if (!fs.existsSync(defaultSessionPath)) {
    throw new Error('default session store did not write ~/.agentbrowse/browse-session.json');
  }

  const restored = library.loadBrowserSession();
  if (!restored || restored.cdpUrl !== 'ws://127.0.0.1:9333/devtools/browser/default-home') {
    throw new Error('default session store did not reload the persisted session');
  }

  library.deleteBrowserSession();
  if (fs.existsSync(defaultSessionPath)) {
    throw new Error('default session store did not remove ~/.agentbrowse/browse-session.json');
  }
} finally {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  fs.rmSync(defaultHome, { recursive: true, force: true });
}
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(consumerDir, 'consumer-contract.ts'),
    `import {
  ACT_ERROR_CODES,
  createAgentbrowseClient,
  type ObserveExecutionMode,
} from '@mercuryo-ai/agentbrowse';
import {
  fillProtectedForm,
  type ProtectedFillForm,
} from '@mercuryo-ai/agentbrowse/protected-fill';
import {
  installFetchBackedTestAssistiveRuntime,
  uninstallTestAssistiveRuntime,
} from '@mercuryo-ai/agentbrowse/testing';

const client = createAgentbrowseClient({
  assistiveRuntime: {
    createLlmClient: () => ({
      async createChatCompletion() {
        return { data: {} as never };
      },
    }),
  },
});

async function documentedContractSmoke(): Promise<void> {
  const actErrorCode = ACT_ERROR_CODES[0];
  void actErrorCode;
  installFetchBackedTestAssistiveRuntime();
  uninstallTestAssistiveRuntime();

  const attached = await client.attach('ws://127.0.0.1:9222/devtools/browser/existing-browser');
  if (attached.success) {
    await client.status(attached.session);
  }

  const launchResult = await client.launch('https://example.com');
  if (!launchResult.success) {
    return;
  }

  const session = launchResult.session;
  const observeResult = await client.observe(session, 'find the checkout button');
  if (observeResult.success) {
    const mode: ObserveExecutionMode = observeResult.observationMode;
    void mode;
  }

  await client.navigate(session, 'https://example.com/checkout');
  await client.screenshot(session, '/tmp/checkout.png');
  await client.status(session);
  await client.extract(session, { checkout_total: 'number' });

  const fillableForm: ProtectedFillForm = {
    fillRef: 'f1',
    pageRef: 'p0',
    purpose: 'payment_card',
    fields: [],
    observedAt: new Date(0).toISOString(),
  };

  await fillProtectedForm({
    session,
    fillableForm,
    protectedValues: {},
  });

  await client.close(session);
}

void documentedContractSmoke();
`,
    'utf8'
  );

  logStep(`Materializing ${path.basename(tgzPath)} into external consumer.`);
  materializePackedPackage({
    consumerDir,
    packageName: '@mercuryo-ai/agentbrowse',
    tgzPath,
  });
  const installedPackageDir = resolveInstalledPackageDir(consumerDir, '@mercuryo-ai/agentbrowse');
  for (const exampleFile of publishedExampleFiles) {
    const examplePath = path.join(installedPackageDir, 'examples', exampleFile);
    if (!fs.existsSync(examplePath)) {
      throw new Error(`packed artifact missing published example ${exampleFile}`);
    }

    const exampleSource = fs.readFileSync(examplePath, 'utf8');
    if (!exampleSource.includes("from '@mercuryo-ai/agentbrowse'")) {
      throw new Error(`published example ${exampleFile} does not import the public package entrypoint`);
    }

    if (exampleSource.includes('../src/library.ts')) {
      throw new Error(`published example ${exampleFile} still imports ../src/library.ts`);
    }
  }
  for (const dependency of workspaceRuntimeDependencies) {
    logStep(`Linking workspace dependency ${dependency}.`);
    linkWorkspacePackage({
      consumerDir,
      packageName: dependency,
      importerDir: packageDir,
      repoRoot,
    });
  }
  logStep('Running runtime smoke import.');
  run('node', ['smoke.mjs'], consumerDir);
  logStep('Running consumer typecheck.');
  runPnpm(['exec', 'tsc', '--noEmit', '-p', path.join(consumerDir, 'tsconfig.json')], packageDir);

  process.stdout.write(`Verified install/import smoke for ${path.basename(tgzPath)}.\n`);
} finally {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  if (packDir && fs.existsSync(packDir)) {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
}
