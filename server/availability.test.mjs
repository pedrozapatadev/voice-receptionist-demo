import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { findSlots, closedReason, BookingError } from './availability.mjs';
import { zonedToDate, toZonedIso } from './time.mjs';

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../agent/config.example.yaml'));
const TZ = 'Europe/Madrid';
const NOW = zonedToDate('2026-10-12', '08:00', TZ);         // Monday morning
const at = (ymd, hm) => zonedToDate(ymd, hm, TZ);
const slots = (opts) => findSlots({ cfg, events: [], now: NOW, ...opts });

test('closed days: Sunday, holiday, past, impossible dates, too far ahead', () => {
  assert.equal(closedReason(cfg, '2026-10-18', NOW), 'CLOSED_DAY');
  assert.equal(closedReason(cfg, '2026-12-08', NOW), 'HOLIDAY');
  assert.equal(closedReason(cfg, '2026-10-09', NOW), 'PAST_DATE');
  assert.equal(closedReason(cfg, '2027-02-30', NOW), 'INVALID_DATE');
  assert.equal(closedReason(cfg, '2027-03-01', NOW), 'TOO_FAR_AHEAD');
  assert.equal(closedReason(cfg, '2026-10-13', NOW), null);
});

test('a combined booking uses the summed duration and fits before closing', () => {
  // limpieza 45 + blanqueamiento 60 = 105 min. Friday closes 15:00 → last start 13:15.
  const { slots: s } = slots({ ymd: '2026-10-16', serviceIds: ['limpieza', 'blanqueamiento'] });
  assert.equal(s[0].end - s[0].start, 105 * 60000);
  assert.equal(toZonedIso(s.at(-1).start, TZ), '2026-10-16T13:15:00+02:00');
});

test('slots never straddle the lunch break', () => {
  const { slots: s } = slots({ ymd: '2026-10-13', serviceIds: ['endodoncia'] });  // 90 min
  assert.ok(s.every(x => x.end <= at('2026-10-13', '14:00') || x.start >= at('2026-10-13', '16:00')));
});

test('only professionals who do the service; explicit request honoured', () => {
  const { slots: s } = slots({ ymd: '2026-10-13', serviceIds: ['ortodoncia'] });
  assert.ok(s.every(x => x.professional === 'Dr. Martín'));
  assert.throws(() => slots({ ymd: '2026-10-13', serviceIds: ['endodoncia'], professional: 'Dr. Martín' }),
    (e) => e instanceof BookingError && e.code === 'PRO_CANNOT_DO_SERVICE');
  assert.throws(() => slots({ ymd: '2026-10-13', serviceIds: ['carillas'] }),
    (e) => e.code === 'UNKNOWN_SERVICE');
});

test('existing events block their professional plus the buffer; others stay free', () => {
  const events = [{ start: at('2026-10-13', '09:00'), end: at('2026-10-13', '10:00'), professional: 'Dra. Ruiz' }];
  const { slots: s } = findSlots({ cfg, events, now: NOW, ymd: '2026-10-13', serviceIds: ['revision'] });
  const nine = s.find(x => toZonedIso(x.start, TZ).endsWith('09:00:00+02:00'));
  assert.equal(nine.professional, 'Dr. Martín');           // Ruiz busy → Martín takes it
  const ruizFirst = s.find(x => x.professional === 'Dra. Ruiz');
  assert.equal(toZonedIso(ruizFirst.start, TZ), '2026-10-13T10:15:00+02:00');  // 10:00 + 10 min buffer → grid
});

test('untagged calendar events (e.g. "closed for training") block everyone', () => {
  const events = [{ start: at('2026-10-13', '09:00'), end: at('2026-10-13', '20:00'), professional: null }];
  const r = findSlots({ cfg, events, now: NOW, ymd: '2026-10-13', serviceIds: ['revision'] });
  assert.equal(r.reason, 'FULLY_BOOKED');
});

test('same-day: never offers a time that has already passed', () => {
  const now = at('2026-10-13', '17:05');
  const { slots: s } = findSlots({ cfg, events: [], now, ymd: '2026-10-13', serviceIds: ['revision'] });
  assert.ok(s.every(x => x.start > now));
});

test('DST: the October clock change is handled in Madrid time', () => {
  // 2026-10-25 is a Sunday (closed); Monday 26 is CET (+01:00).
  const { slots: s } = slots({ ymd: '2026-10-26', serviceIds: ['revision'] });
  assert.equal(toZonedIso(s[0].start, TZ), '2026-10-26T09:00:00+01:00');
});

test('regression: a "00:00" close means midnight tonight, keeping the 23:30 slot', () => {
  const late = { ...cfg, horarios: { ...cfg.horarios, martes: ['20:00-00:00'] } };
  const { slots: s } = findSlots({ cfg: late, events: [], now: NOW, ymd: '2026-10-13', serviceIds: ['revision'] });
  assert.equal(toZonedIso(s.at(-1).start, TZ), '2026-10-13T23:30:00+02:00');
});
