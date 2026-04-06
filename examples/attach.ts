import { attach, observe } from '../src/library.ts';

const cdpUrl = process.env.AGENTBROWSE_CDP_URL;

if (!cdpUrl) {
  throw new Error('Set AGENTBROWSE_CDP_URL to a live Chrome CDP websocket URL.');
}

const attached = await attach(cdpUrl);
if (!attached.success) {
  throw new Error(attached.reason ?? attached.message);
}

const observeResult = await observe(attached.session);
if (!observeResult.success) {
  throw new Error(observeResult.reason ?? observeResult.message);
}

console.info('Attached page:', observeResult.title ?? attached.title ?? 'unknown');
console.info(
  'Top targets:',
  observeResult.targets.slice(0, 10).map((target) => ({
    ref: target.ref,
    label: target.label,
    kind: target.kind,
  }))
);
