import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSolverDir } from './solver/config.js';

const PACKAGE_NAME = '@mercuryo-ai/agentbrowse';
const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url);
const REGISTRY_METADATA_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}`;
const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 1500;
const DEFAULT_UPDATE_TTL_MS = 12 * 60 * 60 * 1000;

type UpdateState = {
  packageName: string;
  latestVersion: string;
  lastCheckedAt: string;
};

type PackageMetadata = {
  version?: string;
  'dist-tags'?: {
    latest?: string;
  };
};

export type LaunchUpdateNotice = {
  currentVersion: string;
  latestVersion: string;
  message: string;
};

export type LaunchUpdateCheckOptions = {
  fetchImpl?: typeof fetch;
  now?: Date;
  timeoutMs?: number;
  ttlMs?: number;
};

export function compareVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);

  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  }

  for (let i = 0; i < 3; i += 1) {
    const diff = parsedLeft.core[i]! - parsedRight.core[i]!;
    if (diff !== 0) {
      return diff;
    }
  }

  if (!parsedLeft.prerelease && !parsedRight.prerelease) {
    return 0;
  }
  if (!parsedLeft.prerelease) {
    return 1;
  }
  if (!parsedRight.prerelease) {
    return -1;
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const leftPart = parsedLeft.prerelease[i];
    const rightPart = parsedRight.prerelease[i];

    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    if (typeof leftPart === 'number' && typeof rightPart === 'number') {
      const diff = leftPart - rightPart;
      if (diff !== 0) {
        return diff;
      }
      continue;
    }

    if (typeof leftPart === 'number') {
      return -1;
    }
    if (typeof rightPart === 'number') {
      return 1;
    }

    const diff = leftPart.localeCompare(rightPart);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

export async function checkForLaunchUpdate(
  options: LaunchUpdateCheckOptions = {}
): Promise<LaunchUpdateNotice | null> {
  const currentVersion = readCurrentPackageVersion();
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_UPDATE_TTL_MS;
  const cachedState = readUpdateState();
  const cachedNotice = buildLaunchUpdateNotice(currentVersion, cachedState?.latestVersion);

  if (cachedState && !isCacheStale(cachedState.lastCheckedAt, now, ttlMs)) {
    return cachedNotice;
  }

  const latestVersion = await fetchLatestVersion({
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? DEFAULT_UPDATE_CHECK_TIMEOUT_MS,
  }).catch(() => null);

  if (!latestVersion) {
    return cachedNotice;
  }

  writeUpdateState({
    packageName: PACKAGE_NAME,
    latestVersion,
    lastCheckedAt: now.toISOString(),
  });

  return buildLaunchUpdateNotice(currentVersion, latestVersion);
}

function parseVersion(version: string): {
  core: [number, number, number];
  prerelease: Array<number | string> | null;
} | null {
  const match = version
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+.*)?$/);
  if (!match) {
    return null;
  }

  const prerelease = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : null;

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  };
}

function buildLaunchUpdateNotice(
  currentVersion: string,
  latestVersion: string | undefined
): LaunchUpdateNotice | null {
  if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0) {
    return null;
  }

  return {
    currentVersion,
    latestVersion,
    message: `A newer agentbrowse version is available: ${latestVersion} (current: ${currentVersion}). Update with: npm i -g ${PACKAGE_NAME}@latest`,
  };
}

function readCurrentPackageVersion(): string {
  const raw = JSON.parse(readFileSync(PACKAGE_JSON_URL, 'utf-8')) as PackageMetadata;
  if (!raw.version || typeof raw.version !== 'string') {
    throw new Error('Package version is missing from package.json.');
  }
  return raw.version;
}

function readUpdateState(): UpdateState | null {
  const updateStatePath = getUpdateStatePath();

  if (!existsSync(updateStatePath)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(updateStatePath, 'utf-8')) as Partial<UpdateState>;
    if (
      raw.packageName !== PACKAGE_NAME ||
      typeof raw.latestVersion !== 'string' ||
      typeof raw.lastCheckedAt !== 'string'
    ) {
      return null;
    }

    return {
      packageName: raw.packageName,
      latestVersion: raw.latestVersion,
      lastCheckedAt: raw.lastCheckedAt,
    };
  } catch {
    return null;
  }
}

function writeUpdateState(state: UpdateState): void {
  const solverDir = getSolverDir();
  mkdirSync(solverDir, { recursive: true });
  writeFileSync(getUpdateStatePath(), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function isCacheStale(lastCheckedAt: string, now: Date, ttlMs: number): boolean {
  const lastCheckedAtMs = new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(lastCheckedAtMs)) {
    return true;
  }

  return now.getTime() - lastCheckedAtMs >= ttlMs;
}

async function fetchLatestVersion(options: {
  fetchImpl?: typeof fetch;
  timeoutMs: number;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is not available.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetchImpl(REGISTRY_METADATA_URL, {
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Registry responded with ${response.status}.`);
    }

    const metadata = (await response.json()) as PackageMetadata;
    const latestVersion = metadata['dist-tags']?.latest;
    if (!latestVersion || typeof latestVersion !== 'string') {
      throw new Error('Registry metadata does not include dist-tags.latest.');
    }

    return latestVersion;
  } finally {
    clearTimeout(timeout);
  }
}

function getUpdateStatePath(): string {
  return join(getSolverDir(), 'update-state.json');
}
