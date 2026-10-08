# 0003 — Enforce booking rules in the server, not only in the prompt

**Status:** accepted. Made while writing the public webhook server for this repo.

## Context

The original agent described the scheduling rules in its prompt: opening hours, holidays,
real service durations, buffers between appointments, and which professional does which
service. Retell's built-in calendar handled free/busy checks. Prompt-only rules fail
quietly:
- the model rounds a 105-minute combined treatment down to 45 minutes;
- it gives a professional a service they don't do;
- it accepts "el 30 de febrero".

## Decision

Every rule that can be checked in code is checked in code, in a pure function
([`server/availability.mjs`](../../server/availability.mjs)):

- `check_availability` returns only slots that satisfy every rule. The prompt says never
  to offer anything else.
- `book_appointment` **re-checks the exact slot against the live calendar** just before
  writing. Another caller or the front desk may have taken it after the availability
  check.
- Errors come back as data (`SLOT_TAKEN`, `PRO_CANNOT_DO_SERVICE`, `HOLIDAY`, …), each
  with a Spanish message the agent can read out. They're never HTTP failures, which the
  agent would turn into silence.

## Consequences

- The prompt keeps only what needs judgment: tone, escalation, what never to answer.
- The [QA plan](../qa-plan.md) now marks each check as *server* (proven by `npm test`) or
  *prompt* (proven only by a live call).
- The server needs the full config (durations, staff skills), so the config stays the
  single source of truth for both the prompt and the server.
