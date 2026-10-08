/**
 * The three tools the agent can call. Platform-agnostic: the HTTP layer adapts
 * Vapi / Retell payloads to these. Results are small JSON objects written for an
 * LLM to read aloud — Spanish labels, no internal noise.
 */

import { findSlots, resolveServices, BookingError, ANY } from './availability.mjs';
import { zonedToDate, toZonedIso, spokenEs, addMinutes } from './time.mjs';

const MAX_OFFERED = 4;    // the prompt offers two; give it a little room to pick
const SPREAD_MIN = 60;    // "10:15 or 10:30" is not a real choice on the phone
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;   // "10:00" with no zone means the server's zone — refuse it
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Earliest slot, then later ones at least SPREAD_MIN apart; tight days top up at the end. */
export function spreadSlots(slots, max = MAX_OFFERED, gapMin = SPREAD_MIN) {
  const picked = [];
  for (const s of slots) {
    if (picked.length === max) break;
    const last = picked.at(-1);
    if (!last || s.start - last.start >= gapMin * 60000) picked.push(s);
  }
  return [...picked, ...slots.filter(s => !picked.includes(s)).slice(0, max - picked.length)];
}

/** Caller-supplied text goes to a calendar, a chat webhook and WhatsApp: one line, bounded, no markup. */
export const clean = (v, max) =>
  String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const tzOf = (cfg) => cfg.negocio?.zona_horaria ?? 'Europe/Madrid';
const asIds = (services) => [].concat(services ?? []).map(String);

const REASON_ES = {
  INVALID_DATE: 'Esa fecha no existe.',
  PAST_DATE: 'Esa fecha ya ha pasado.',
  TOO_FAR_AHEAD: 'Todavía no hay agenda abierta para esa fecha.',
  HOLIDAY: 'Ese día es festivo y está cerrado.',
  CLOSED_DAY: 'Ese día de la semana está cerrado.',
  FULLY_BOOKED: 'No queda ningún hueco ese día.',
  NONE_AFTER: 'Ese día no queda nada a partir de esa hora.',
  NO_PRO_FOR_COMBINATION: 'Ningún profesional hace esa combinación de servicios en la misma cita.',
};

const dayWindow = (cfg, ymd) => ({
  from: zonedToDate(ymd, '00:00', tzOf(cfg)),
  to: addMinutes(zonedToDate(ymd, '23:59', tzOf(cfg)), 1),
});

const asError = (e) => {
  if (e instanceof BookingError) return { ok: false, error: e.code, message: e.message };
  throw e;
};

/** Runs async jobs one at a time, so check-then-write can't interleave across requests. */
const createLock = () => {
  const state = { tail: Promise.resolve() };
  return (job) => {
    const run = state.tail.then(job, job);
    state.tail = run.catch(() => {});
    return run;
  };
};

export function createTools({ cfg, calendar, notifier, clock = () => new Date() }) {
  const tz = tzOf(cfg);
  const exclusive = createLock();

  async function slotsFor({ date, services, professional }) {
    const events = await calendar.listEvents(dayWindow(cfg, String(date)));
    return findSlots({ cfg, events, ymd: String(date), serviceIds: asIds(services),
      professional: professional ? String(professional) : ANY, now: clock() });
  }

  async function check_availability({ date, services, professional = ANY, after }) {
    try {
      if (after != null && !HH_MM.test(String(after)))
        throw new BookingError('INVALID_AFTER', 'La hora "after" va en formato HH:MM.');
      const { slots: all, reason } = await slotsFor({ date, services, professional });
      const from = after ? zonedToDate(String(date), String(after), tz) : null;
      const slots = from ? all.filter(s => s.start >= from) : all;
      if (!slots.length) {
        const why = all.length ? 'NONE_AFTER' : reason;
        return { ok: true, available: false, reason: why, message: REASON_ES[why] };
      }
      return {
        ok: true, available: true,
        slots: spreadSlots(slots).map(s => ({
          start: toZonedIso(s.start, tz), spoken: spokenEs(s.start, tz), professional: s.professional,
        })),
        more_available: slots.length > MAX_OFFERED,
      };
    } catch (e) { return asError(e); }
  }

  /** Re-check + write under the lock: the slot may have gone since check_availability ran. */
  async function reserve({ startAt, services, professional, durationMin, summary, description }) {
    return exclusive(async () => {
      const { slots } = await slotsFor({ date: toZonedIso(startAt, tz).slice(0, 10), services, professional });
      const slot = slots.find(s => s.start.getTime() === startAt.getTime());
      if (!slot) throw new BookingError('SLOT_TAKEN', 'Ese hueco ya no está libre. Vuelve a consultar disponibilidad.');
      const ev = await calendar.createEvent({
        start: slot.start, end: addMinutes(slot.start, durationMin),
        summary: summary(slot), description, professional: slot.professional,
      });
      return { slot, ev };
    });
  }

  async function book_appointment(args) {
    try {
      const name = clean(args.name, 80), phone = clean(args.phone, 40), notes = clean(args.notes, 300);
      if (!name || !phone) throw new BookingError('MISSING_CONTACT', 'Faltan el nombre o el teléfono.');
      const startAt = new Date(String(args.start));
      if (!HAS_OFFSET.test(String(args.start)) || Number.isNaN(startAt.getTime()))
        throw new BookingError('INVALID_START', 'Usa el campo start exacto que devolvió check_availability.');
      const services = asIds(args.services);
      const { services: svc, durationMin } = resolveServices(cfg, services);
      const label = svc.map(s => s.nombre).join(' + ');
      const description = [`Teléfono: ${phone}`, args.new_client ? 'Cliente nuevo' : 'Cliente habitual',
        notes && `Notas: ${notes}`, 'Reservado por el asistente de voz'].filter(Boolean).join('\n');

      const { slot, ev } = await reserve({ startAt, services, professional: args.professional, durationMin,
        summary: () => `${label} — ${name}`, description });

      const when = spokenEs(slot.start, tz);
      const sent = await notifier.send(
        `✅ Nueva cita\n${name} · ${phone}\n${label} con ${slot.professional}\n${when} (${durationMin} min)` +
        `${args.new_client ? '\nCliente nuevo' : ''}${notes ? `\nNotas: ${notes}` : ''}`,
        { type: 'booking', id: ev.id, start: toZonedIso(slot.start, tz), name, phone, services, professional: slot.professional });

      return { ok: true, booked: true, id: ev.id, spoken: when, professional: slot.professional,
        duration_min: durationMin, owner_notified: sent.delivered > 0 };
    } catch (e) { return asError(e); }
  }

  async function take_message(args) {
    const name = clean(args.name, 80), phone = clean(args.phone, 40), reason = clean(args.reason, 300);
    const urgency = args.urgency === 'alta' ? 'alta' : 'normal';
    if (!name || !phone || !reason)
      return { ok: false, error: 'MISSING_FIELDS', message: 'Hacen falta nombre, teléfono y motivo.' };
    const sent = await notifier.send(
      `${urgency === 'alta' ? '🔴' : '📝'} Recado (${urgency})\n${name} · ${phone}\n${reason}`,
      { type: 'message', name, phone, reason, urgency, at: toZonedIso(clock(), tz) });
    return { ok: true, saved: true, owner_notified: sent.delivered > 0 };
  }

  return { check_availability, book_appointment, take_message };
}
