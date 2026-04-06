export const BROWSE_ACTIONS = ['click', 'fill', 'type', 'select', 'press'] as const;

export type BrowseAction = (typeof BROWSE_ACTIONS)[number];

export function isBrowseAction(value: string): value is BrowseAction {
  return BROWSE_ACTIONS.includes(value as BrowseAction);
}
