/**
 * The three tools the agent can call. Platform-agnostic: the HTTP layer adapts
 * Vapi / Retell payloads to these. Results are small JSON objects written for an
 * LLM to read aloud — Spanish labels, no internal noise.
 */

import { findSlots, resolveServices, BookingError, ANY } from './availability.mjs';
import { zonedToDate, toZonedIso, spokenEs, addMinutes } from './time.mjs';

const MAX_OFFERED = 4;    // the prompt offers two; give it a little room to pick
const SPREAD_MIN = 60;    // "10:15 or 10:30" is not a real choice on the phone

/** Earliest slot, then later ones at least SPREAD_MIN apart; tops up if the day is tight. */
export function spreadSlots(slots, max = MAX_OFFERED, gapMin = SPREAD_MIN) {
  const picked = [];
  for (const s of slots) {
    if (picked.length === max) break;
    const last = picked.at(-1);
    if (!last || s.start - last.start >= gapMin * 60000) picked.push(s);
  }
  const rest = slots.filter(s => !picked.includes(s)).slice(0, max - picked.length);
  return [...picked, ...rest].sort((a, b) => a.start - b.start);
}
const tzOf = (cfg) => cfg.negocio?.zona_horaria ?? 'Europe/Madrid';

const REASON_ES = {
  INVALID_DATE: 'Esa fecha no existe.',
  PAST_DATE: 'Esa fecha ya ha pasado.',
  TOO_FAR_AHEAD: 'Todavía no hay agenda abierta para esa fecha.',
  HOLIDAY: 'Ese día es festivo y está cerrado.',
  CLOSED_DAY: 'Ese día de la semana está cerrado.',
  FULLY_BOOKED: 'No queda ningún hueco ese día.',
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

export function createTools({ cfg, calendar, notifier, clock = () => new Date() }) {
  const tz = tzOf(cfg);

  async function slotsFor({ date, services, professional }) {
    const events = await calendar.listEvents(dayWindow(cfg, date));
    return findSlots({ cfg, events, ymd: date, serviceIds: services, professional: professional || ANY, now: clock() });
  }

  async function check_availability({ date, services, professional = ANY }) {
    try {
      const { slots, reason } = await slotsFor({ date, services, professional });
      if (!slots.length) return { ok: true, available: false, reason, message: REASON_ES[reason] };
      return {
        ok: true, available: true,
        slots: spreadSlots(slots).map(s => ({
          start: toZonedIso(s.start, tz), spoken: spokenEs(s.start, tz), professional: s.professional,
        })),
        more_available: slots.length > MAX_OFFERED,
      };
    } catch (e) { return asError(e); }
  }

  async function book_appointment({ start, services, professional = ANY, name, phone, new_client = false, notes = '' }) {
    try {
      if (!name || !phone) throw new BookingError('MISSING_CONTACT', 'Faltan el nombre o el teléfono.');
      const startAt = new Date(start);
      if (Number.isNaN(startAt.getTime())) throw new BookingError('INVALID_START', 'Hora de inicio no válida.');
      const { services: svc, durationMin } = resolveServices(cfg, services);

      // Re-check against the live calendar right before writing: the slot may have
      // gone since check_availability ran (another caller, the front desk).
      const { slots } = await slotsFor({ date: toZonedIso(startAt, tz).slice(0, 10), services, professional });
      const slot = slots.find(s => s.start.getTime() === startAt.getTime());
      if (!slot) throw new BookingError('SLOT_TAKEN', 'Ese hueco ya no está libre. Vuelve a consultar disponibilidad.');

      const label = svc.map(s => s.nombre).join(' + ');
      const description = [`Teléfono: ${phone}`, new_client ? 'Cliente nuevo' : 'Cliente habitual',
        notes && `Notas: ${notes}`, 'Reservado por el asistente de voz'].filter(Boolean).join('\n');
      const ev = await calendar.createEvent({
        start: slot.start, end: addMinutes(slot.start, durationMin),
        summary: `${label} — ${name}`, description, professional: slot.professional,
      });

      const when = spokenEs(slot.start, tz);
      const sent = await notifier.send(
        `✅ Nueva cita\n${name} · ${phone}\n${label} con ${slot.professional}\n${when} (${durationMin} min)` +
        `${new_client ? '\nCliente nuevo' : ''}${notes ? `\nNotas: ${notes}` : ''}`,
        { type: 'booking', id: ev.id, start: toZonedIso(slot.start, tz), name, phone, services, professional: slot.professional });

      return { ok: true, booked: true, id: ev.id, spoken: when, professional: slot.professional,
        duration_min: durationMin, owner_notified: sent.delivered > 0 };
    } catch (e) { return asError(e); }
  }

  async function take_message({ name, phone, reason, urgency = 'normal' }) {
    if (!name || !phone || !reason)
      return { ok: false, error: 'MISSING_FIELDS', message: 'Hacen falta nombre, teléfono y motivo.' };
    const sent = await notifier.send(
      `${urgency === 'alta' ? '🔴' : '📝'} Recado (${urgency})\n${name} · ${phone}\n${reason}`,
      { type: 'message', name, phone, reason, urgency, at: toZonedIso(clock(), tz) });
    return { ok: true, saved: true, owner_notified: sent.delivered > 0 };
  }

  return { check_availability, book_appointment, take_message };
}
