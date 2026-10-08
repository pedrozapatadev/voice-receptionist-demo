/**
 * End to end over real sockets: boots `server/index.mjs` as a child process
 * (exactly what `npm start` runs), drives it with payloads shaped like the
 * Vapi and Retell docs examples, and catches the owner notification on a local
 * webhook receiver. No voice platform account, no network beyond localhost.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { localDate, weekdayKey, addMinutes } from './time.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(join(HERE, '../agent/config.example.yaml'));
// Fake test-only secrets, not real credentials.
const SECRETS = { VAPI_SECRET: 'e2e-vapi-secret', RETELL_API_KEY: 'e2e-retell-key' };

const fixture = (name, replacements) => Object.entries(replacements).reduce(
  (s, [k, v]) => s.replaceAll(k, v), readFileSync(join(HERE, 'fixtures', name), 'utf8'));

const nextOpenDay = () => {
  for (let d = 2; d < 30; d++) {
    const ymd = localDate(addMinutes(new Date(), d * 1440), 'Europe/Madrid');
    if (!cfg.festivos.includes(ymd) && cfg.horarios[weekdayKey(ymd, 'Europe/Madrid')].length) return ymd;
  }
  throw new Error('no open day');
};

const state = { notifications: [], child: null, receiver: null, base: null, tmp: null };

before(async () => {
  state.receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { state.notifications.push(JSON.parse(body)); res.end('ok'); });
  });
  await new Promise((r) => state.receiver.listen(0, r));
  state.tmp = mkdtempSync(join(tmpdir(), 'vr-e2e-'));

  state.child = spawn(process.execPath, [join(HERE, 'index.mjs')], {
    env: { ...process.env, ...SECRETS, PORT: '0', CALENDAR_BACKEND: 'mock',
      MOCK_CALENDAR_FILE: join(state.tmp, 'calendar.json'),
      NOTIFY_WEBHOOK_URL: `http://localhost:${state.receiver.address().port}/hook` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.base = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 5000);
    state.child.stdout.on('data', (d) => {
      const m = /http:\/\/localhost:(\d+)/.exec(String(d));
      if (m) { clearTimeout(t); resolve(`http://localhost:${m[1]}`); }
    });
  });
});

after(() => {
  state.child?.kill();
  state.receiver?.close();
  if (state.tmp) rmSync(state.tmp, { recursive: true, force: true });
});

test('Vapi docs-shaped tool-calls → real slots from the running server', async () => {
  const day = nextOpenDay();
  const res = await fetch(`${state.base}/vapi`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRETS.VAPI_SECRET}` },
    body: fixture('vapi-tool-calls.json', { __DATE__: day }),
  });
  assert.equal(res.status, 200);
  const { results: [r] } = await res.json();
  assert.equal(r.toolCallId, 'toolu_01DTPAzUm5Gk3zxrpJ969oMF');
  assert.equal(typeof r.result, 'string');   // Vapi requires a flat string
  const out = JSON.parse(r.result);
  assert.equal(out.available, true);
  assert.ok(out.slots[0].start.startsWith(day));
  state.firstSlot = out.slots[0].start;
});

test('Retell docs-shaped, signed custom function → booked + owner notified over HTTP', async () => {
  const raw = fixture('retell-custom-function.json', { __START__: state.firstSlot });
  const ts = Date.now();
  const sig = `v=${ts},d=${createHmac('sha256', SECRETS.RETELL_API_KEY).update(raw + ts).digest('hex')}`;
  const res = await fetch(`${state.base}/retell`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-retell-signature': sig }, body: raw,
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual([out.booked, out.owner_notified], [true, true]);

  const note = state.notifications.find(n => n.event?.type === 'booking');
  assert.ok(note, 'webhook receiver got the booking');
  assert.match(note.text, /Nueva cita/);
  assert.equal(note.event.start, state.firstSlot);
});

test('the same signed request replayed → refused, slot already taken', async () => {
  const raw = fixture('retell-custom-function.json', { __START__: state.firstSlot });
  const ts = Date.now();
  const sig = `v=${ts},d=${createHmac('sha256', SECRETS.RETELL_API_KEY).update(raw + ts).digest('hex')}`;
  const out = await (await fetch(`${state.base}/retell`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-retell-signature': sig }, body: raw,
  })).json();
  assert.equal(out.error, 'SLOT_TAKEN');
});

test('unsigned request to the running server → 401', async () => {
  const res = await fetch(`${state.base}/retell`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: fixture('retell-custom-function.json', { __START__: state.firstSlot }),
  });
  assert.equal(res.status, 401);
});
