/**
 * HTTP adapter. Two front doors onto the same tools:
 *
 *   POST /vapi     Vapi "Server URL" — handles `tool-calls` messages.
 *                  Always answers 200: Vapi ignores non-2xx bodies and the agent
 *                  would say "no result" instead of the error we want it to read.
 *   POST /retell   Retell custom function — body {name, args, call}.
 *   GET  /health
 *
 * Auth: Vapi via a shared secret sent as `Authorization: Bearer …` (current
 * credential style) or the legacy X-Vapi-Secret header; Retell via the
 * X-Retell-Signature HMAC over the raw body. Unauthenticated mode is allowed
 * only when the secret isn't configured, and logged loudly at startup.
 */

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_BODY = 1_000_000;
const RETELL_MAX_SKEW_MS = 5 * 60 * 1000;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function verifyRetellSignature({ rawBody, header, apiKey, now = Date.now() }) {
  const m = /^v=(\d+),d=(.+)$/.exec(header ?? '');
  if (!m) return false;
  const [, ts, digest] = m;
  if (Math.abs(now - Number(ts)) > RETELL_MAX_SKEW_MS) return false;
  const expected = createHmac('sha256', apiKey).update(rawBody + ts).digest('hex');
  return safeEqual(expected, digest);
}

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// Vapi has shipped two tool-call shapes: {function:{name,arguments}} and {name,parameters}.
const vapiCall = (tc) => ({
  id: tc.id,
  name: tc.function?.name ?? tc.name,
  args: (() => {
    const a = tc.function?.arguments ?? tc.parameters ?? {};
    return typeof a === 'string' ? JSON.parse(a || '{}') : a;
  })(),
});

async function runTool(tools, name, args) {
  const fn = Object.hasOwn(tools, name) ? tools[name] : null;
  if (!fn) return { ok: false, error: 'UNKNOWN_TOOL', message: `Herramienta desconocida: ${name}` };
  return fn(args ?? {});
}

const vapiAuthorized = (req, secret) => {
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  return safeEqual(bearer ?? req.headers['x-vapi-secret'] ?? '', secret);
};

async function handleVapi({ tools, env, req, raw }) {
  if (env.VAPI_SECRET && !vapiAuthorized(req, env.VAPI_SECRET)) return [401, { error: 'unauthorized' }];
  const msg = JSON.parse(raw).message ?? {};
  if (msg.type !== 'tool-calls') return [200, {}];   // status updates, transcripts… acknowledged, ignored
  const results = await Promise.all((msg.toolCallList ?? []).map(async (tc) => {
    const { id, name, args } = vapiCall(tc);
    try {
      return { name, toolCallId: id, result: JSON.stringify(await runTool(tools, name, args)) };
    } catch (e) {
      console.error(`tool ${name} crashed:`, e);
      return { name, toolCallId: id, error: 'Error interno. Toma recado y que el equipo llame.' };
    }
  }));
  return [200, { results }];
}

async function handleRetell({ tools, env, req, raw }) {
  if (env.RETELL_API_KEY && !verifyRetellSignature({ rawBody: raw, header: req.headers['x-retell-signature'], apiKey: env.RETELL_API_KEY }))
    return [401, { error: 'unauthorized' }];
  const { name, args } = JSON.parse(raw);
  return [200, await runTool(tools, name, args)];
}

const ROUTES = { '/vapi': handleVapi, '/retell': handleRetell };

export function createApp({ tools, env = process.env }) {
  return createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
    const route = req.method === 'POST' && ROUTES[path];
    if (!route) return send(res, 404, { error: 'not found' });
    try {
      const raw = await readBody(req);
      const [status, body] = await route({ tools, env, req, raw });
      return send(res, status, body);
    } catch (e) {
      if (e instanceof SyntaxError) return send(res, 400, { error: 'invalid json' });
      if (e.status) return send(res, e.status, { error: e.message });
      console.error(e);
      return send(res, 500, { error: 'internal error' });
    }
  });
}
