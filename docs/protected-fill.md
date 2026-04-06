# AgentBrowse Protected Fill Guide

Protected fill solves a specific problem:

You already have sensitive values from your own approval or secret-management
flow, and you want AgentBrowse to apply those values to a previously observed
form in a guarded way.

Normal fill and protected fill solve different problems.

## When To Use Protected Fill

Use protected fill when all of these are true:

- you already observed the page and have a form description
- you already have the sensitive values in your own application
- you want AgentBrowse to apply them through a typed execution path

Examples:

- card number, expiry, CVV
- password or one-time code
- any field set that should not be treated like ordinary page text input

## When A Normal `act(..., 'fill', value)` Is Enough

Use ordinary `act(..., 'fill', value)` when:

- the value is not sensitive
- you are filling one simple field directly
- you do not need form-level guarded execution

## What Protected Fill Adds

Compared with a normal fill action, protected fill works with:

- a previously observed `fillableForm`
- structured `protectedValues` keyed by field meaning
- optional `fieldPolicies`
- typed execution outcomes

It also validates that the previously observed form bindings still make sense
before applying values.

## Import

```ts
import { fillProtectedForm } from '@mercuryo-ai/agentbrowse/protected-fill';
```

## Example

```ts
import { observe } from '@mercuryo-ai/agentbrowse';
import { fillProtectedForm } from '@mercuryo-ai/agentbrowse/protected-fill';

const observeResult = await observe(session);
if (!observeResult.success) {
  throw new Error(observeResult.reason ?? observeResult.message);
}

const fillableForm = observeResult.fillableForms.find((form) => form.purpose === 'payment_card');
if (!fillableForm) {
  throw new Error('Could not find a payment_card form.');
}

const result = await fillProtectedForm({
  session,
  fillableForm,
  protectedValues: {
    card_number: '4111111111111111',
    exp_month: '12',
    exp_year: '2030',
    cvv: '123',
  },
});

if (!result.success) {
  throw new Error(result.reason ?? result.message);
}
```

## Where It Fits

Protected fill handles the browser execution step.

Applications usually pair it with their own:

- secret storage
- approval flow
- policy decisions
- claims or grants

## What You Need Before Calling It

Before protected fill, you usually need:

1. a launched browser `session`
2. a `fillableForm` produced by `observe(...)`
3. the sensitive values from your own trusted source

## Result Shape

Protected fill returns a typed result that tells you whether the fill:

- succeeded
- failed because bindings became stale
- failed validation
- failed for another execution reason

That makes it safer than treating every sensitive field as a raw one-off
string fill.
