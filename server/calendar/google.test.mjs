import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createGoogleCalendar, toBusy } from './google.mjs';
import { toZonedIso } from '../time.mjs';

const TZ = 'Europe/Madrid';

test('all-day events block the whole local day even when Google marks them "free"', () => {
  const busy = toBusy([
    { id: 'a', summary: 'Formación', start: { date: '2026-10-13' }, end: { date: '2026-10-14' }, transparency: 'transparent' },
    { id: 'b', summary: 'Recordatorio', start: { dateTime: '2026-10-13T10:00:00+02:00' }, end: { dateTime: '2026-10-13T10:30:00+02:00' }, transparency: 'transparent' },
    { id: 'c', summary: 'Cancelada', status: 'cancelled', start: { dateTime: '2026-10-13T11:00:00+02:00' }, end: { dateTime: '2026-10-13T11:30:00+02:00' } },
  ], TZ);
  assert.deepEqual(busy.map(b => b.id), ['a']);
  assert.equal(toZonedIso(busy[0].start, TZ), '2026-10-13T00:00:00+02:00');
  assert.equal(toZonedIso(busy[0].end, TZ), '2026-10-14T00:00:00+02:00');
  assert.equal(busy[0].professional, null);   // untagged → blocks everyone
});

test('listEvents follows nextPageToken and signs a service-account JWT', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { client_email: 'test@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const seen = [];
  const ev = (id) => ({ id, start: { dateTime: '2026-10-13T09:00:00+02:00' }, end: { dateTime: '2026-10-13T09:30:00+02:00' } });
  const fetchImpl = async (url, init) => {
    seen.push(String(url));
    const json = String(url).includes('oauth2')
      ? (assert.match(String(init.body), /assertion=[\w-]+\.[\w-]+\.[\w-]+/), { access_token: 't', expires_in: 3600 })
      : String(url).includes('pageToken=p2') ? { items: [ev('2')] } : { items: [ev('1')], nextPageToken: 'p2' };
    return { ok: true, json: async () => json };
  };
  const cal = createGoogleCalendar({ calendarId: 'cal@example.com', key, fetchImpl });
  const busy = await cal.listEvents({ from: new Date('2026-10-12T22:00:00Z'), to: new Date('2026-10-13T22:00:00Z') });
  assert.deepEqual(busy.map(b => b.id), ['1', '2']);
  assert.equal(seen.filter(u => u.includes('/events?')).length, 2);
  assert.equal(seen.filter(u => u.includes('oauth2')).length, 1);   // token cached across pages
});
