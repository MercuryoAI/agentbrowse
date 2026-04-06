import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDirs,
  getExistingProfileDir,
  getFingerprintPath,
  getProfileDir,
  getProfilesDir,
  getUserDataDir,
} from './config.js';
import { type FingerprintOptions, generateFingerprint } from './fingerprint.js';
import type { BrowserFingerprint, ProfileInfo } from './types.js';

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

function validateName(name: string): void {
  if (!name || name.length > 64) {
    throw new Error(`Profile name must be 1-64 characters, got ${name.length}`);
  }
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `Profile name must match ${PROFILE_NAME_RE} (lowercase alphanumeric, dots, hyphens, underscores)`
    );
  }
}

function readFingerprint(fpPath: string): BrowserFingerprint {
  return JSON.parse(fs.readFileSync(fpPath, 'utf-8')) as BrowserFingerprint;
}

export function createProfile(name: string, opts?: FingerprintOptions): ProfileInfo {
  validateName(name);
  ensureDirs();

  const profileDir = getProfileDir(name);
  if (fs.existsSync(profileDir)) {
    throw new Error(`Profile "${name}" already exists`);
  }

  const userDataDir = getUserDataDir(name);
  const fingerprintPath = getFingerprintPath(name);
  fs.mkdirSync(userDataDir, { recursive: true });

  const fingerprint = generateFingerprint(opts);
  fs.writeFileSync(fingerprintPath, JSON.stringify(fingerprint, null, 2) + '\n', 'utf-8');

  return { name, fingerprint, userDataDir, fingerprintPath };
}

export function getProfile(name: string): ProfileInfo | null {
  const profileDir = getExistingProfileDir(name);
  if (!profileDir) {
    return null;
  }
  const fingerprintPath = fs.existsSync(path.join(profileDir, 'fingerprint.json'))
    ? path.join(profileDir, 'fingerprint.json')
    : getFingerprintPath(name);

  return {
    name,
    fingerprint: readFingerprint(fingerprintPath),
    userDataDir: path.join(profileDir, 'user-data'),
    fingerprintPath,
  };
}

export function ensureProfile(name: string, opts?: FingerprintOptions): ProfileInfo {
  const existing = getProfile(name);
  if (existing) return existing;
  return createProfile(name, opts);
}

export function listProfiles(): ProfileInfo[] {
  const profilesDir = getProfilesDir();
  if (!fs.existsSync(profilesDir)) {
    return [];
  }

  const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  const profiles: ProfileInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profile = getProfile(entry.name);
    if (profile) profiles.push(profile);
  }

  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteProfile(name: string): void {
  const profileDir = getExistingProfileDir(name) ?? getProfileDir(name);
  if (!fs.existsSync(profileDir)) {
    throw new Error(`Profile "${name}" does not exist`);
  }
  fs.rmSync(profileDir, { recursive: true, force: true });
}
