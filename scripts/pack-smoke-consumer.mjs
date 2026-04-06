import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export function resolveInstalledPackageDir(consumerDir, packageName) {
  return path.join(consumerDir, 'node_modules', ...packageName.split('/'));
}

export function materializePackedPackage({ consumerDir, packageName, tgzPath }) {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-smoke-materialize-'));

  try {
    execFileSync('tar', ['-xzf', tgzPath, '-C', stagingDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const extractedDir = path.join(stagingDir, 'package');
    if (!fs.existsSync(extractedDir)) {
      throw new Error(`Packed tarball did not contain package/: ${tgzPath}`);
    }

    const targetDir = resolveInstalledPackageDir(consumerDir, packageName);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.renameSync(extractedDir, targetDir);

    return targetDir;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function findPackageRoot(entryPath) {
  let currentDir = path.dirname(entryPath);

  while (true) {
    if (fs.existsSync(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to find package root for resolved entry ${entryPath}`);
    }

    currentDir = parentDir;
  }
}

export function linkWorkspacePackage({ consumerDir, packageName, importerDir, repoRoot }) {
  let sourceDir = null;

  if (importerDir) {
    try {
      const importerRequire = createRequire(path.join(importerDir, 'package.json'));
      sourceDir = findPackageRoot(importerRequire.resolve(packageName));
    } catch {
      sourceDir = null;
    }
  }

  if (!sourceDir && repoRoot) {
    const fallbackDir = path.join(repoRoot, 'node_modules', ...packageName.split('/'));
    if (fs.existsSync(fallbackDir)) {
      sourceDir = fallbackDir;
    }
  }

  if (!sourceDir) {
    throw new Error(`Workspace dependency not found for ${packageName}`);
  }

  const targetDir = resolveInstalledPackageDir(consumerDir, packageName);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.symlinkSync(sourceDir, targetDir, 'dir');

  return targetDir;
}

export function resolvePackageBin(packageDir, binName) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));

  if (typeof manifest.bin === 'string') {
    return path.join(packageDir, manifest.bin);
  }

  if (manifest.bin && typeof manifest.bin === 'object') {
    if (binName && typeof manifest.bin[binName] === 'string') {
      return path.join(packageDir, manifest.bin[binName]);
    }

    const firstEntry = Object.values(manifest.bin).find((value) => typeof value === 'string');
    if (typeof firstEntry === 'string') {
      return path.join(packageDir, firstEntry);
    }
  }

  throw new Error(`Unable to resolve bin entry${binName ? ` ${binName}` : ''} in ${packageDir}`);
}
