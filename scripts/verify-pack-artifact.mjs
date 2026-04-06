#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(__dirname, '..');
const npmCacheDir = path.join(os.tmpdir(), 'agentbrowse-npm-cache');

function extractPackJson(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Failed to parse npm pack --json output.');
  }

  return JSON.parse(stdout.slice(start, end + 1));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const rawOutput = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: packageDir,
  encoding: 'utf8',
  env: {
    ...process.env,
    npm_config_cache: npmCacheDir,
    npm_config_loglevel: 'silent',
  },
});

const packResult = extractPackJson(rawOutput)?.[0];

assert(packResult, 'npm pack did not return pack metadata.');

const files = packResult.files.map((entry) => entry.path);
const unexpectedTestFiles = files.filter(
  (filePath) => filePath.includes('.test.') || filePath.includes('.test-harness.')
);

assert(files.includes('package.json'), 'Packed artifact is missing package.json.');
assert(files.includes('README.md'), 'Packed artifact is missing README.md.');
assert(files.includes('dist/library.js'), 'Packed artifact is missing dist/library.js.');
assert(files.includes('dist/library.d.ts'), 'Packed artifact is missing dist/library.d.ts.');
assert(
  files.includes('dist/protected-fill.js'),
  'Packed artifact is missing dist/protected-fill.js.'
);
assert(
  files.includes('dist/protected-fill.d.ts'),
  'Packed artifact is missing dist/protected-fill.d.ts.'
);
assert(files.includes('dist/index.js'), 'Packed artifact is missing dist/index.js.');
assert(
  unexpectedTestFiles.length === 0,
  `Packed artifact contains test-only files: ${unexpectedTestFiles.join(', ')}`
);

process.stdout.write(
  `Verified ${packResult.filename}: ${files.length} files, no test-only build artifacts.\n`
);
