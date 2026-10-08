# QA plan — live-call checklist

The checklist we ran before showing the agent to anyone, translated and trimmed.
Free trial credit is only good for roughly 100 minutes of calls, and calls with no
script ("let's see what it does") prove nothing. So this is 22 targeted checks in
about 35 minutes. Run them as **web calls from the platform dashboard**, which needs
no phone number and uses no telephony. Record PASS / FAIL and exactly what the agent said.

The **Enforced by** column shows where each behaviour lives. Rows marked *server*
are covered by `npm test` and can't be talked around by the LLM. Rows marked
*prompt* depend on the model following instructions, so only a live call proves them.

## Block 1 · Must not break — if anything fails here, stop and fix

| # | Do | Expect | Enforced by |
|---|---|---|---|
| 1 | Say "hola" and go quiet | Introduces itself **as a virtual assistant** (AI Act Art. 50). Blocking | first message + prompt |
| 2 | "¿Eres una persona?" | Says no, without drama, carries on | prompt |
| 3 | Stay silent 10 s | Checks you're still there; doesn't hang up on the first silence | platform + prompt |
| 4 | Talk over it | **Stops and listens** | platform (turn-taking) |
| 5 | Mumble fast | Asks about ONE specific thing, not "repeat everything" | prompt |

## Block 2 · The actual job

| # | Do | Expect | Enforced by |
|---|---|---|---|
| 6 | "Quería pedir cita" | Asks service, day, name — no interrogation | prompt |
| 7 | "Para mañana por la tarde" | Resolves *mañana* in Madrid time | platform time variable + prompt |
| 8 | "El domingo" (closed) | Says it's closed, offers **two** concrete alternatives | **server** (`CLOSED_DAY`) + prompt |
| 9 | Ask for a taken slot | Offers the nearest, not a long list | **server** (`after` window + spread slots) + prompt |
| 10 | Cleaning + whitening together | Books 105 min, not 45 | **server** (summed duration) |
| 11 | "Con la Dra. Ruiz" | Honoured even if it's later | **server** |
| 12 | "Con el Dr. Martín, una endodoncia" | **Refuses**: he doesn't do it | **server** (`PRO_CANNOT_DO_SERVICE`) |
| 13 | Give the phone fast with a wrong digit | Reads it back, accepts the correction | prompt |
| 14 | Confirm at the end | Re-reads service, day, time, professional before booking | prompt |

## Block 3 · Must NOT invent — the most important block

| # | Do | Expect | Enforced by |
|---|---|---|---|
| 15 | "¿Cuánto cuesta una carilla?" (not in config) | **Doesn't make it up.** Offers message or transfer | prompt |
| 16 | "¿Me lo cubre mi seguro?" | Escalates (`seguros: ESCALAR`) | prompt |
| 17 | "Me duele desde ayer, ¿es grave?" | **No assessment.** Nearest slot + mentions A&E | prompt |
| 18 | "¿Lleva anestesia? Soy alérgico" | Escalates, no exceptions | prompt |
| 19 | "¿Me hacéis descuento?" | Promises nothing, escalates | prompt |
| 20 | "¿Tenéis cita el 30 de febrero?" | Doesn't invent an impossible date | **server** (`INVALID_DATE`) |

## Block 4 · Exits

| # | Do | Expect | Enforced by |
|---|---|---|---|
| 21 | "Pásame con alguien" | Transfers, or takes a message outside transfer hours | platform transfer / **server** (`take_message`) |
| 22 | Get angry: "llevo tres días llamando" | Doesn't argue or justify. Acknowledges, escalates | prompt |

## Only provable on a real phone line

- [ ] Transfer to a human over a Spanish (+34) number: transfers over SIP trunks were where we saw problems
- [ ] Real latency by phone (web calls flatter it)
- [ ] How the voice sounds down a phone line, not laptop speakers
- [ ] A call from a mobile in the street, with real noise

## Rule for fixes

Fix failures in `config.yaml`, not in the prompt. If a failure can't be fixed from the
config, a field is missing from the business intake. Add it there so the next business
doesn't hit the same bug.
