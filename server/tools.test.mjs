import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createMockCalendar } from './calendar/mock.mjs';
import { createTools, spreadSlots } from './tools.mjs';
import { zonedToDate } from './time.mjs';

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../agent/config.example.yaml'));
const NOW = zonedToDate('2026-10-12', '08:00', 'Europe/Madrid');

const setup = ({ notifyFails = false } = {}) => {
  const sent = [];
  const notifier = { send: async (text, event) => {
    sent.push({ text, event });
    return notifyFails ? { delivered: 0, failed: ['webhook: 500'] } : { delivered: 1, failed: [] };
  } };
  const calendar = createMockCalendar();
  return { sent, calendar, tools: createTools({ cfg, calendar, notifier, clock: () => NOW }) };
};

test('check → book → calendar event + owner notification', async () => {
  const { tools, calendar, sent } = setup();
  const avail = await tools.check_availability({ date: '2026-10-13', services: ['limpieza'] });
  assert.equal(avail.available, true);
  const slot = avail.slots[0];
  const r = await tools.book_appointment({ start: slot.start, services: ['limpieza'], professional: slot.professional, name: 'Test', phone: '+34000000000' });
  assert.equal(r.booked, true);
  assert.equal(calendar.all().length, 1);
  assert.match(calendar.all()[0].summary, /Limpieza bucal — Test/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event.type, 'booking');
});

test('the same slot cannot be booked twice', async () => {
  const { tools } = setup();
  const { slots: [slot] } = await tools.check_availability({ date: '2026-10-13', services: ['endodoncia'] });
  const args = { start: slot.start, services: ['endodoncia'], professional: slot.professional, name: 'A', phone: '1' };
  assert.equal((await tools.book_appointment(args)).booked, true);
  const again = await tools.book_appointment({ ...args, name: 'B' });
  assert.deepEqual([again.ok, again.error], [false, 'SLOT_TAKEN']);
});

test('booking a time that was never offered is refused (e.g. Sunday, or off-grid)', async () => {
  const { tools } = setup();
  const sunday = await tools.book_appointment({ start: '2026-10-18T10:00:00+02:00', services: ['revision'], name: 'A', phone: '1' });
  assert.equal(sunday.error, 'SLOT_TAKEN');
  const offGrid = await tools.book_appointment({ start: '2026-10-13T10:07:00+02:00', services: ['revision'], name: 'A', phone: '1' });
  assert.equal(offGrid.error, 'SLOT_TAKEN');
});

test('a failed notification does not undo the booking, and the agent is told', async () => {
  const { tools, calendar } = setup({ notifyFails: true });
  const { slots: [slot] } = await tools.check_availability({ date: '2026-10-13', services: ['revision'] });
  const r = await tools.book_appointment({ start: slot.start, services: ['revision'], name: 'A', phone: '1' });
  assert.deepEqual([r.booked, r.owner_notified, calendar.all().length], [true, false, 1]);
});

test('validation errors come back as data the agent can read, not exceptions', async () => {
  const { tools } = setup();
  assert.equal((await tools.book_appointment({ start: 'mañana', services: ['revision'], name: 'A', phone: '1' })).error, 'INVALID_START');
  assert.equal((await tools.book_appointment({ start: '2026-10-13T10:00:00+02:00', services: ['revision'] })).error, 'MISSING_CONTACT');
  assert.equal((await tools.take_message({ name: 'A' })).error, 'MISSING_FIELDS');
  const closed = await tools.check_availability({ date: '2026-10-18', services: ['revision'] });
  assert.deepEqual([closed.available, closed.reason], [false, 'CLOSED_DAY']);
});

test('offered slots are spread out, not 15 minutes apart', () => {
  const t = (h, m) => ({ start: new Date(Date.UTC(2026, 9, 13, h, m)) });
  const s = [t(7, 0), t(7, 15), t(7, 30), t(8, 0), t(8, 15), t(9, 30)];
  const picked = spreadSlots(s, 3, 60);
  assert.deepEqual(picked.map(x => x.start.getUTCHours() * 60 + x.start.getUTCMinutes()), [420, 480, 570]);
});
