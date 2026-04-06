const DEFAULT_BROWSE_COMMAND = 'agentbrowse';

function normalizeCommandName(value: string | undefined, fallback: string): string {
  const normalized = value?.trim().replace(/\s+/g, ' ');
  return normalized && normalized.length > 0 ? normalized : fallback;
}

export function browseCommandName(): string {
  return normalizeCommandName(process.env.AGENTBROWSE_COMMAND, DEFAULT_BROWSE_COMMAND);
}

export function browseCommand(...args: string[]): string {
  return [browseCommandName(), ...args].join(' ');
}
