# 0001 — Voice platform: from Vapi and Bland to Retell

**Status:** accepted at the time; superseded by the company winding down.
This repo supports both Vapi and Retell.

## Context

We needed a Castilian Spanish voice, a Spanish (+34) phone number, calendar booking, and
an account per client, all on a pre-revenue budget with no fixed monthly costs.

We built first on **Vapi** and **Bland AI**. Bland is tuned for outbound calling and the
US market, so it was a poor fit for inbound Spanish reception. Vapi was flexible, but you
assemble the speech-to-text, LLM and voice providers yourself, so there was more to build
and more to break.

## Decision

Move to **Retell** for the inbound receptionist.

- **Latency:** low out of the box. On a Spanish call, a pause before the agent answers is
  very noticeable.
- **Built-in calendar booking:** booking was the product, and Retell already did it.
- **One account per client**, with each client able to see their own calls.
- **Pay-per-use** with no platform fee, which suited a company with no revenue yet.

Keep **Vapi as the fallback** for integrations Retell couldn't handle, or for when
assembling our own providers would pay off.

Rejected: ElevenLabs Agents (best voice quality, but LLM and telephony are separate and
there's no booking layer), and white-label resellers (a monthly fee for a dashboard, and
one more vendor).

## Consequences

- **Phone numbers:** neither platform sold Spanish numbers directly at the time. The
  number had to come from a carrier (Twilio or Telnyx) over a SIP trunk. Spanish
  geographic numbers need ID and proof of address in the matching province, and
  validation takes days. Call transfer to a human over that trunk was the step we most
  had to re-test.
- **This repo:** the webhook server speaks both the Vapi and Retell formats, so the
  platform decision is reversible ([`server/http.mjs`](../../server/http.mjs)).
