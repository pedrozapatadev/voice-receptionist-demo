/**
 * Slot finding. Pure: takes the business config, the busy events already in the
 * calendar, and "now"; returns bookable slots. All rules the prompt promises
 * (opening hours, holidays, real service durations, buffer, who does what) are
 * enforced here, so the LLM can't talk its way past them.
 */

import { zonedToDate, weekdayKey, addMinutes, localDate } from './time.mjs';

export class BookingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const ANY = 'cualquiera';
const tzOf = (cfg) => cfg.negocio?.zona_horaria ?? 'Europe/Madrid';

/** Resolve service ids → services; total duration is the sum of their real durations. */
export function resolveServices(cfg, ids) {
  const all = cfg.citas?.servicios ?? [];
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (list.length === 0) throw new BookingError('NO_SERVICE', 'Falta el servicio.');
  const services = list.map((id) => {
    const s = all.find(x => x.id === id);
    if (!s) throw new BookingError('UNKNOWN_SERVICE', `Servicio desconocido: ${id}. Válidos: ${all.map(x => x.id).join(', ')}`);
    return s;
  });
  return { services, durationMin: services.reduce((n, s) => n + s.duracion_min, 0) };
}

/** Professionals able to do every requested service; honours an explicit request. */
export function eligibleProfessionals(cfg, serviceIds, requested = ANY) {
  const pros = (cfg.citas?.profesionales ?? []).filter(p => serviceIds.every(id => p.hace.includes(id)));
  if (!requested || requested === ANY) return pros;
  const wanted = pros.filter(p => p.nombre.toLowerCase() === requested.toLowerCase());
  if (wanted.length === 0) {
    const exists = (cfg.citas?.profesionales ?? []).some(p => p.nombre.toLowerCase() === requested.toLowerCase());
    throw new BookingError(exists ? 'PRO_CANNOT_DO_SERVICE' : 'UNKNOWN_PRO',
      exists ? `${requested} no hace ese servicio.` : `No hay ningún profesional llamado ${requested}.`);
  }
  return wanted;
}

/** Why a date can't be booked at all, or null if it's open. */
export function closedReason(cfg, ymd, now) {
  const tz = tzOf(cfg);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || Number.isNaN(zonedToDate(ymd, '12:00', tz).getTime()))
    return 'INVALID_DATE';
  const [y, m, d] = ymd.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return 'INVALID_DATE';  // 30 de febrero
  if (ymd < localDate(now, tz)) return 'PAST_DATE';
  const maxDays = cfg.citas?.antelacion_max_dias;
  if (maxDays && zonedToDate(ymd, '00:00', tz) > addMinutes(now, maxDays * 1440)) return 'TOO_FAR_AHEAD';
  if ((cfg.festivos ?? []).includes(ymd)) return 'HOLIDAY';
  if ((cfg.horarios?.[weekdayKey(ymd, tz)] ?? []).length === 0) return 'CLOSED_DAY';
  return null;
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/** Busy for this professional: their own events, plus events not tagged to anyone. */
const isFree = ({ events, pro, start, end, bufferMin }) => !events.some(ev =>
  (!ev.professional || ev.professional === pro) &&
  overlaps(start, end, addMinutes(ev.start, -bufferMin), addMinutes(ev.end, bufferMin)));

/** Every bookable slot on `ymd`, earliest first, each with the professional who'd take it. */
export function findSlots({ cfg, events, ymd, serviceIds, professional = ANY, now }) {
  const reason = closedReason(cfg, ymd, now);
  if (reason) return { slots: [], reason };

  const tz = tzOf(cfg);
  const { durationMin } = resolveServices(cfg, serviceIds);
  const pros = eligibleProfessionals(cfg, serviceIds, professional);
  if (pros.length === 0) return { slots: [], reason: 'NO_PRO_FOR_COMBINATION' };

  const step = cfg.citas?.paso_min ?? 15;
  const bufferMin = cfg.citas?.buffer_min ?? 0;
  const slots = [];
  for (const range of cfg.horarios[weekdayKey(ymd, tz)]) {
    const [open, close] = range.split('-');
    const closeAt = zonedToDate(ymd, close === '00:00' ? '23:59' : close, tz);
    for (let start = zonedToDate(ymd, open, tz); addMinutes(start, durationMin) <= closeAt; start = addMinutes(start, step)) {
      if (start <= now) continue;
      const end = addMinutes(start, durationMin);
      const pro = pros.find(p => isFree({ events, pro: p.nombre, start, end, bufferMin }));
      if (pro) slots.push({ start, end, professional: pro.nombre });
    }
  }
  return { slots, reason: slots.length ? null : 'FULLY_BOOKED' };
}
