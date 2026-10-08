# Prompt design for a Spanish phone agent

The agent's prompts are in Spanish ([`agent/core-rules.md`](../agent/core-rules.md),
[`agent/appointments.prompt.md`](../agent/appointments.prompt.md)). This page explains
each design choice in English: the rule, why it's there, and the failure it prevents.
Most rules came from a concrete bad call.

## 1. Structure: core + vertical + config

```
core-rules.md            same for every business: disclosure, register, dates, never-invent, escalation, GDPR
appointments.prompt.md   same for every clinic / barber / physio: what to resolve, what never to touch
config.yaml              the only per-business file: hours, services, staff, FAQ, escalation
        └── scripts/build-prompt.mjs ──► dist/prompt.<platform>.md
```

**Why:** when each business got a hand-edited prompt, a fix made for one business never
reached the others. With this split, a bug in agent behaviour gets fixed once, in the core
or the vertical. A bug in one business's facts gets fixed in its config. Nobody edits the
built prompt.

## 2. Disclose in the first sentence, then drop it

> *"Clínica Dental Ejemplo, le atiende un asistente virtual. ¿En qué puedo ayudarle?"*

- EU AI Act Art. 50 requires that people are told they're talking to an AI system. The
  first message is the one place that can't be skipped, because the platform plays it
  verbatim before the LLM speaks. A test enforces it ([`build-prompt.test.mjs`](../scripts/build-prompt.test.mjs)).
- If the caller asks "are you a person?": one honest sentence, then carry on. *Never
  apologise for being an AI or make it the topic.* Agents that dwell on it lose the call.
- **No "buenos días / buenas tardes" in the greeting.** The greeting is static, and a
  wrong time-of-day greeting at 14:05 sounds worse than none.

## 3. Phone register, not chat register

| Rule | Failure it prevents |
|---|---|
| One or two sentences per turn | LLM paragraphs are unbearable when spoken aloud, and callers talk over them |
| No lists, no "en primer lugar…" | The agent reciting bullet points into a phone |
| A banned-phrase list ("no dude en", "estaré encantado de asistirle") | Corporate Spanish that sounds like a robot reading a script |
| Times spoken as people say them ("las nueve y media", not "21:30") | TTS reading "veintiuno treinta" |
| Offer **two concrete slots**, never "when suits you?" | Open questions make callers think, hesitate and hang up |
| tú/usted fixed per business, derived in code | Switching between formal and informal mid-call, which a Spanish speaker notices at once |

The prompt includes ❌/✅ pairs like *"¿En qué franja horaria le vendría bien?"* (❌) versus
*"Tengo el martes a las cinco o el miércoles a las siete y media"* (✅). Models copy
examples far more reliably than they follow adjectives like "natural" or "warm".

## 4. Dates: inject the time, never let the model guess

The platform injects the current Madrid time into every call (Vapi's Liquid `now`,
Retell's `current_time_Europe/Madrid`). The builder writes the right syntax for each
platform. The prompt then fixes the ambiguous cases explicitly:

- "el martes" said on a Tuesday means **next** Tuesday unless they say "hoy".
- A day with no year means the nearest future one.
- If it's unclear: *"¿el jueves de esta semana o el de la que viene?"*

**The broken-variable guard:** if the time variable fails to render and the model sees
raw `{{…}}`, it must **never read it aloud**. It says it can't confirm the calendar right
now and takes a message instead. An agent reading template syntax to a caller ends the
call badly.

## 5. Never invent — the top rule

The agent may only state what's in the business data or what a tool returned.
Everything else gets one fixed exit: *"Eso no te lo puedo confirmar yo"*, plus an offer
to take a message or transfer.

The hard escalations come with no exceptions, *"aunque la carta parezca clara"* (even if
the menu seems clear):

- **Allergies, health, medication.** A wrong "no, it has no gluten" is a health risk and a
  legal one.
- **Clinical questions.** No assessment, not even "that's usually normal". Give the
  nearest slot instead, and mention A&E if it gets worse.
- Insurance coverage, discounts, and prices not in the config.
- Complaints. The agent records the complaint, acknowledges it and passes it on. It never
  argues or justifies.

Config values can be the literal `ESCALAR`. The builder turns that into "⚠️ do NOT
answer", so a business can mark a topic human-only without touching a prompt.

## 6. Prompt rules vs. server rules

Anything that can be checked in code is checked in code. Hours, holidays, durations,
buffers and who does which service are enforced by `check_availability` and
`book_appointment`, so the model can't talk past them. The prompt tells the agent to
*never offer a slot the tool didn't return*. The server makes that true even when the
model forgets. See [decision 0003](decisions/0003-rules-in-server-not-prompt.md) and the
*Enforced by* column in the [QA plan](qa-plan.md).

## 7. Privacy by default (GDPR / LOPDGDD)

- Ask only for what the booking needs: name, phone, service, time.
- Never confirm whether someone else has an appointment.
- Never ask for card details or ID numbers. Prepayment goes to a human.
- Health data (GDPR Art. 9) is never written into notes. If a patient volunteers it, the
  note says only *"el paciente comentará el motivo en consulta"* (the patient will explain
  the reason at the appointment).

## 8. Fix in the config, not the prompt

This rule comes from the [QA plan](qa-plan.md). When a test call fails, fix it in
`config.yaml`. If it can't be fixed there, the business intake is missing a question, so
add it, and the next business won't hit the same bug.
