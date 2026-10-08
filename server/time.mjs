/**
 * Wall-clock ↔ instant conversion for a named IANA zone, without dependencies.
 * Callers speak in Madrid local time; calendars store instants.
 */

const parts = (date, tz) => {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'long',
  });
  const o = Object.fromEntries(f.formatToParts(date).map(p => [p.type, p.value]));
  return o;
};

/** Offset of `tz` from UTC at instant `date`, in minutes (Madrid summer = +120). */
export function offsetMinutes(date, tz) {
  const p = parts(date, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** "2026-10-13" + "10:30" in `tz` → Date. */
export function zonedToDate(ymd, hm, tz) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = offsetMinutes(new Date(guess), tz);
  const first = guess - off * 60000;
  const off2 = offsetMinutes(new Date(first), tz);  // re-check across a DST boundary
  return new Date(off2 === off ? first : guess - off2 * 60000);
}

/** Local calendar date "YYYY-MM-DD" of an instant in `tz`. */
export function localDate(date, tz) {
  const p = parts(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** ISO-8601 with the zone's offset: 2026-10-13T10:30:00+02:00. */
export function toZonedIso(date, tz) {
  const p = parts(date, tz);
  const off = offsetMinutes(date, tz);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  const hh = String(Math.floor(a / 60)).padStart(2, '0');
  const mm = String(a % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

const WEEKDAY_ES = {
  Monday: 'lunes', Tuesday: 'martes', Wednesday: 'miercoles', Thursday: 'jueves',
  Friday: 'viernes', Saturday: 'sabado', Sunday: 'domingo',
};

/** Config key of the weekday ("miercoles", no accent) for a local date. */
export function weekdayKey(ymd, tz) {
  return WEEKDAY_ES[parts(zonedToDate(ymd, '12:00', tz), tz).weekday];
}

/** Human Spanish label for the agent to read naturally: "martes 13 de octubre, 10:30". */
export function spokenEs(date, tz) {
  const d = new Intl.DateTimeFormat('es-ES', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long',
  }).format(date).replace(',', '');
  const t = new Intl.DateTimeFormat('es-ES', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
  return `${d}, ${t}`;
}

export const addMinutes = (date, min) => new Date(date.getTime() + min * 60000);
