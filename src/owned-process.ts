import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { getProfilesDir } from './solver/config.js';

const TERM_WAIT_ATTEMPTS = 10;
const TERM_WAIT_MS = 100;
const KILL_WAIT_ATTEMPTS = 5;
const KILL_WAIT_MS = 20;

export type OwnedPidTerminationResult = 'not_found' | 'terminated' | 'sigkilled' | 'still_alive';
export type ManagedBrowserCleanupResult = {
  terminated: number[];
  blocked: number[];
};

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = getErrorCode(error);
    if (code === 'EPERM') {
      return true;
    }
    return false;
  }
}

export async function terminateOwnedPid(pid: number): Promise<OwnedPidTerminationResult> {
  const processGroupTermination = await terminateSignalTarget(-pid, pid);
  if (processGroupTermination !== 'not_found') {
    return processGroupTermination;
  }

  return terminateSignalTarget(pid, pid);
}

async function terminateSignalTarget(
  target: number,
  pid: number
): Promise<OwnedPidTerminationResult> {
  try {
    process.kill(target, 'SIGTERM');
  } catch (error) {
    const code = getErrorCode(error);
    if (target < 0 && code === 'ESRCH' && isPidAlive(pid)) {
      return 'not_found';
    }
    return isPidAlive(pid) ? 'still_alive' : 'not_found';
  }

  if (await waitForPidExit(pid, TERM_WAIT_ATTEMPTS, TERM_WAIT_MS)) {
    return 'terminated';
  }

  try {
    process.kill(target, 'SIGKILL');
  } catch {
    return isPidAlive(pid) ? 'still_alive' : 'sigkilled';
  }

  if (await waitForPidExit(pid, KILL_WAIT_ATTEMPTS, KILL_WAIT_MS)) {
    return 'sigkilled';
  }

  return 'still_alive';
}

export async function cleanupManagedBrowserPids(
  options: { excludePids?: Iterable<number>; userDataDir?: string } = {}
): Promise<ManagedBrowserCleanupResult> {
  const excludePids = new Set(options.excludePids ?? []);
  const terminated: number[] = [];
  const blocked: number[] = [];

  for (const pid of listManagedBrowserPids({ userDataDir: options.userDataDir })) {
    if (excludePids.has(pid)) {
      continue;
    }

    const result = await terminateOwnedPid(pid);
    if (result === 'still_alive') {
      blocked.push(pid);
      continue;
    }
    if (result !== 'not_found') {
      terminated.push(pid);
    }
  }

  return { terminated, blocked };
}

export function listManagedBrowserPids(
  options: {
    processTable?: string;
    userDataDir?: string;
  } = {}
): number[] {
  const processTable = options.processTable ?? readProcessTable();
  const pids = new Set<number>();
  const scopedUserDataDir = options.userDataDir ? path.resolve(options.userDataDir) : null;

  for (const line of processTable.split(/\r?\n/)) {
    const match = line.trimStart().match(/^(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }

    const pid = Number(match[1]);
    const command = match[2] ?? '';
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) {
      continue;
    }
    if (!isManagedBrowserCommand(command, scopedUserDataDir)) {
      continue;
    }

    pids.add(pid);
  }

  return Array.from(pids);
}

export function isManagedBrowserPid(
  pid: number,
  options: {
    processTable?: string;
  } = {}
): boolean {
  return listManagedBrowserPids(options).includes(pid);
}

async function waitForPidExit(pid: number, attempts: number, intervalMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await sleep(intervalMs);
  }

  return !isPidAlive(pid);
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readProcessTable(): string {
  try {
    return execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

function isManagedBrowserCommand(command: string, scopedUserDataDir: string | null): boolean {
  if (!command.includes('--remote-debugging-address=127.0.0.1')) {
    return false;
  }

  const userDataDir = readCommandFlag(command, '--user-data-dir');
  if (!userDataDir) {
    return false;
  }

  const normalizedUserDataDir = path.resolve(userDataDir);
  if (scopedUserDataDir && normalizedUserDataDir !== scopedUserDataDir) {
    return false;
  }
  return isWithinRoot(normalizedUserDataDir, getProfilesDir());
}

function readCommandFlag(command: string, flag: string): string | null {
  const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = command.match(new RegExp(`${escapedFlag}=(?:"([^"]+)"|'([^']+)'|(\\S+))`));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..';
}
