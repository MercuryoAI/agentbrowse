import type { TargetDescriptor } from '../runtime-state.js';
import type { BrowseAction } from './browse-actions.js';

export type ClickActivationStrategy = 'pointer' | 'dom';

export function clickActivationStrategyForTarget(
  target: Pick<TargetDescriptor, 'kind' | 'framePath' | 'semantics'>,
  action: BrowseAction
): ClickActivationStrategy {
  if (action !== 'click') {
    return 'pointer';
  }

  const withinIframe = Boolean(target.framePath?.length);
  if (!withinIframe) {
    return 'pointer';
  }

  const kind = target.kind?.trim().toLowerCase();
  const role = target.semantics?.role?.trim().toLowerCase();
  const isTab = kind === 'tab' || role === 'tab';

  return isTab ? 'dom' : 'pointer';
}
