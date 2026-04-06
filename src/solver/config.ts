import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SolverConfig } from './types.js';

const AGENTBROWSE_DIR = path.join(os.homedir(), '.agentbrowse');
const CONFIG_FILENAME = 'config.json';
const PROFILES_DIRNAME = 'profiles';

export interface SolverConfigStoreOverride {
  rootDir?: string;
  readConfig?: () => SolverConfig;
  writeConfig?: (config: SolverConfig) => void;
}

let storeOverride: SolverConfigStoreOverride | null = null;

function getPrimaryDir(): string {
  return storeOverride?.rootDir ?? AGENTBROWSE_DIR;
}

function getPrimaryConfigPath(): string {
  return path.join(getPrimaryDir(), CONFIG_FILENAME);
}

function getPrimaryProfilesDir(): string {
  return path.join(getPrimaryDir(), PROFILES_DIRNAME);
}

export function setSolverConfigStoreOverride(
  override: SolverConfigStoreOverride | null | undefined
): void {
  storeOverride = override ?? null;
}

export function getSolverDir(): string {
  return getPrimaryDir();
}

export function getProfilesDir(): string {
  return getPrimaryProfilesDir();
}

export function getConfigPath(): string {
  return getPrimaryConfigPath();
}

export function ensureDirs(): void {
  fs.mkdirSync(getPrimaryProfilesDir(), { recursive: true });
}

export function readConfig(): SolverConfig {
  if (storeOverride?.readConfig) {
    return storeOverride.readConfig();
  }

  try {
    const raw = fs.readFileSync(getPrimaryConfigPath(), 'utf-8');
    return JSON.parse(raw) as SolverConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: SolverConfig): void {
  if (storeOverride?.writeConfig) {
    storeOverride.writeConfig(config);
    return;
  }

  ensureDirs();
  fs.writeFileSync(getPrimaryConfigPath(), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function getProfileDir(profileName: string): string {
  return path.join(getPrimaryProfilesDir(), profileName);
}

export function getExistingProfileDir(profileName: string): string | null {
  const primary = path.join(getPrimaryProfilesDir(), profileName);
  if (fs.existsSync(primary)) {
    return primary;
  }
  return null;
}

export function getUserDataDir(profileName: string): string {
  return path.join(getProfileDir(profileName), 'user-data');
}

export function getFingerprintPath(profileName: string): string {
  return path.join(getProfileDir(profileName), 'fingerprint.json');
}
