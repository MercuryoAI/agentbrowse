import { close, launch, observe, screenshot } from '@mercuryo-ai/agentbrowse';

const launchResult = await launch('https://example.com', {
  headless: false,
});

if (!launchResult.success) {
  throw new Error(launchResult.reason ?? launchResult.message);
}

const { session } = launchResult;

try {
  const observeResult = await observe(session);
  if (!observeResult.success) {
    throw new Error(observeResult.reason ?? observeResult.message);
  }

  console.info('Opened:', observeResult.title ?? launchResult.title ?? 'unknown');
  console.info('URL:', observeResult.url ?? launchResult.url ?? 'unknown');
  console.info(
    'Targets:',
    observeResult.targets.slice(0, 5).map((target) => ({
      ref: target.ref,
      kind: target.kind,
      label: target.label,
    }))
  );

  const screenshotResult = await screenshot(session, '/tmp/agentbrowse-basic.png');
  if (screenshotResult.success) {
    console.info('Screenshot:', screenshotResult.path);
  }
} finally {
  await close(session);
}
