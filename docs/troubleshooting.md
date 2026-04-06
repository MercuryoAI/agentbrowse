# AgentBrowse Troubleshooting

## Browser Does Not Launch Headful

If `launch(...)` fails in a local GUI flow:

- confirm that Chrome or Chromium can start outside AgentBrowse
- try `headless: true` to separate browser-launch problems from page problems
- verify that the host has a usable display server if you expect a visible window

## Why The Package Uses Both Puppeteer And Playwright

`launch(...)` uses Puppeteer for the managed browser connection layer with
stealth evasions enabled.

After the browser is up, normal page interaction runs through Playwright CDP.

That split exists to reduce unnecessary anti-bot friction during managed launch
while keeping the live runtime on the Playwright side.

## `observe(...)` Returned Zero Targets

This usually means one of three things:

- the page has not reached the state you expect yet
- the goal was too narrow for the current page state
- the page is mostly blocked by a gate, overlay, or challenge

What to do:

- run `observe(session)` without a goal first
- inspect `signals`
- inspect `fillableForms`
- check `status(session)` and current `url`

## `act(...)` Fails With A Stale Or Missing Target

Target refs are durable within the observed page state, not forever.

If the page rerendered, navigated, or replaced a surface, re-run `observe(...)`
and use the new `ref` values.

## Scoped `extract(...)` Fails With A Stale Scope

`scopeRef` is tied to the observed scope binding that produced it.

If the page changed enough that the scope no longer resolves cleanly, run
`observe(...)` again and use the current `scopeRef`.

## `extract(...)` Fails Immediately

Two common causes:

- no assistive runtime is configured
- the schema input is invalid

Valid schema inputs are:

- a plain schema object
- a Zod schema

## You Keep Hitting Captcha Or Anti-Bot Pages

Managed `launch(...)` enables a stealth-oriented Puppeteer connection layer, but
that only reduces unnecessary friction. It does not guarantee bypass.

If a site still gates the session:

- retry with a normal local browser profile if your flow permits it
- confirm that the site is reachable outside automation
- treat the page as a site policy or anti-abuse boundary until proven otherwise
