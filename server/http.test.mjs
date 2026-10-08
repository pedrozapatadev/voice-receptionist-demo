import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp, verifyRetellSignature } from './http.mjs';

// Fake test-only secrets, not real credentials.
const ENV = { VAPI_SECRET: 'test-vapi-secret', RETELL_API_KEY: 'test-retell-key' };
const tools = {
  check_availability: async (args) => ({ ok: true, echo: args }),
  take_message: async () => { throw new Error('boom'); },
};

let server, base;
before(() => new Promise((r) => { server = createApp({ tools, env: ENV }).listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
after(() => server.close());

const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const vapiBody = (calls) => ({ message: { type: 'tool-calls', toolCallList: calls } });

test('vapi: both tool-call shapes, results keyed by toolCallId, result is a string', async () => {
  const res = await post('/vapi', vapiBody([
    { id: 'a', type: 'function', function: { name: 'check_availability', arguments: { date: '2026-10-13' } } },
    { id: 'b', name: 'check_availability', parameters: { date: '2026-10-14' } },
    { id: 'c', type: 'function', function: { name: 'check_availability', arguments: '{"date":"2026-10-15"}' } },
  ]), { 'x-vapi-secret': ENV.VAPI_SECRET });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.deepEqual(results.map(r => r.toolCallId), ['a', 'b', 'c']);
  assert.deepEqual(results.map(r => JSON.parse(r.result).echo.date), ['2026-10-13', '2026-10-14', '2026-10-15']);
});

test('vapi: a crashing tool still returns 200 with an error string', async () => {
  const res = await post('/vapi', vapiBody([{ id: 'x', name: 'take_message', parameters: {} }]), { 'x-vapi-secret': ENV.VAPI_SECRET });
  assert.equal(res.status, 200);
  const [r] = (await res.json()).results;
  assert.equal(r.toolCallId, 'x');
  assert.ok(r.error && !r.result);
});

test('vapi: unknown tools and non-tool events are handled', async () => {
  const unknown = await (await post('/vapi', vapiBody([{ id: 'u', name: 'constructor', parameters: {} }]), { 'x-vapi-secret': ENV.VAPI_SECRET })).json();
  assert.equal(JSON.parse(unknown.results[0].result).error, 'UNKNOWN_TOOL');
  const status = await post('/vapi', { message: { type: 'status-update' } }, { 'x-vapi-secret': ENV.VAPI_SECRET });
  assert.equal(status.status, 200);
});

test('vapi: Bearer credential accepted', async () => {
  assert.equal((await post('/vapi', vapiBody([]), { authorization: `Bearer ${ENV.VAPI_SECRET}` })).status, 200);
});

test('vapi: wrong or missing secret → 401', async () => {
  assert.equal((await post('/vapi', vapiBody([]), { authorization: 'Bearer nope' })).status, 401);
  assert.equal((await post('/vapi', vapiBody([]), { 'x-vapi-secret': 'nope' })).status, 401);
  assert.equal((await post('/vapi', vapiBody([]))).status, 401);
});

test('retell: valid signature accepted, tampered body / stale timestamp rejected', async () => {
  const raw = JSON.stringify({ name: 'check_availability', args: { date: '2026-10-13' }, call: { call_id: 't' } });
  const sign = (body, ts) => `v=${ts},d=${createHmac('sha256', ENV.RETELL_API_KEY).update(body + ts).digest('hex')}`;
  const ok = await post('/retell', raw, { 'x-retell-signature': sign(raw, Date.now()) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).echo.date, '2026-10-13');

  const tampered = raw.replace('13', '14');
  assert.equal((await post('/retell', tampered, { 'x-retell-signature': sign(raw, Date.now()) })).status, 401);
  assert.equal(verifyRetellSignature({ rawBody: raw, header: sign(raw, Date.now() - 10 * 60000), apiKey: ENV.RETELL_API_KEY }), false);
});

test('bad json → 400, unknown route → 404, health → 200', async () => {
  assert.equal((await post('/vapi', '{nope', { 'x-vapi-secret': ENV.VAPI_SECRET })).status, 400);
  assert.equal((await post('/nope', {})).status, 404);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('regression: one malformed tool call fails alone, not the whole batch', async () => {
  const res = await post('/vapi', vapiBody([
    { id: 'bad', type: 'function', function: { name: 'check_availability', arguments: '{not json' } },
    { id: 'good', name: 'check_availability', parameters: { date: '2026-10-13' } },
  ]), { 'x-vapi-secret': ENV.VAPI_SECRET });
  assert.equal(res.status, 200);
  const { results } = await res.json();
  assert.ok(results.find(r => r.toolCallId === 'bad').error);
  assert.equal(JSON.parse(results.find(r => r.toolCallId === 'good').result).echo.date, '2026-10-13');
});

test('regression: more than 10 tool calls in one message → 400', async () => {
  const calls = Array.from({ length: 11 }, (_, i) => ({ id: `c${i}`, name: 'check_availability', parameters: {} }));
  assert.equal((await post('/vapi', vapiBody(calls), { 'x-vapi-secret': ENV.VAPI_SECRET })).status, 400);
});

test('regression: retell tool crash → 200 with an error the agent can read', async () => {
  const raw = JSON.stringify({ name: 'take_message', args: {} });
  const ts = Date.now();
  const sig = `v=${ts},d=${createHmac('sha256', ENV.RETELL_API_KEY).update(raw + ts).digest('hex')}`;
  const res = await post('/retell', raw, { 'x-retell-signature': sig });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).error, 'INTERNAL');
});

test('requireAuth: a route with no secret is switched off on a non-loopback bind', async () => {
  const open = createApp({ tools, env: {}, requireAuth: true }).listen(0);
  await new Promise((r) => open.once('listening', r));
  const url = `http://localhost:${open.address().port}`;
  const res = await fetch(`${url}/vapi`, { method: 'POST', body: JSON.stringify(vapiBody([])) });
  open.close();
  assert.equal(res.status, 503);
});
