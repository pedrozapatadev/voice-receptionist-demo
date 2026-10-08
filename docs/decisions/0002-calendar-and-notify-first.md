# 0002 — Write to Google Calendar and message the owner; integrate booking systems later

**Status:** accepted.

## Context

Many Madrid restaurants and clinics already run a booking system. Several popular ones
have no complete public API. Writing into them means either a partner certification
process or automating their back-office screens, which is fragile and breaks whenever
the vendor changes its interface.

## Decision

v1 writes the booking to Google Calendar and messages the owner (WhatsApp or a webhook).
Staff copy it into their own system if they use one, which takes seconds. Direct
integrations get built when several clients ask for the same one, as a paid extra.

## Consequences

- Shippable on day one, and nothing breaks when a vendor changes its back office.
- Writing into the booking system is a small part of the value but most of the delivery
  risk, and this keeps that risk out of v1.
- Cost: double entry for businesses that already use a booking system. That's accepted
  in v1 and stated plainly to clients.
- The notification is designed so it can't undo a booking: if delivery fails, it's
  logged and the agent is told, but the booking stands
  ([`server/notify.mjs`](../../server/notify.mjs)).
