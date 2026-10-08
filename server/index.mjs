#!/usr/bin/env node
/** Entry point: wires config + calendar backend + notifier into the HTTP server. */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createMockCalendar } from './calendar/mock.mjs';
import { createGoogleCalendar } from './calendar/google.mjs';
import { createNotifier } from './notify.mjs';
import { createTools } from './tools.mjs';
import { createApp } from './http.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

const cfg = loadConfig(env.BUSINESS_CONFIG ?? join(ROOT, 'agent/config.example.yaml'));
const calendar = env.CALENDAR_BACKEND === 'google'
  ? createGoogleCalendar({ calendarId: env.GOOGLE_CALENDAR_ID, keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, tz: cfg.negocio.zona_horaria })
  : createMockCalendar({ file: env.MOCK_CALENDAR_FILE ?? join(ROOT, 'data/mock-calendar.json') });
const notifier = createNotifier({ env });
const tools = createTools({ cfg, calendar, notifier });

const port = Number(env.PORT ?? 3000);
// Loopback by default: a tunnel (cloudflared/ngrok) reaches it fine. Bind wider with HOST=0.0.0.0,
// and then any route whose secret is missing is switched off rather than left open.
const host = env.HOST ?? '127.0.0.1';
const requireAuth = !['127.0.0.1', '::1', 'localhost'].includes(host);
const server = createApp({ tools, env, requireAuth }).listen(port, host, () => {
  console.log(`voice-receptionist · ${cfg.negocio.nombre} · http://localhost:${server.address().port}`);
  console.log(`  calendar: ${calendar.kind} · notify: ${notifier.channels.join(', ')}`);
  const open = requireAuth ? 'disabled (non-loopback bind)' : 'unauthenticated — local dev only';
  if (!env.VAPI_SECRET) console.warn(`  ⚠️  VAPI_SECRET not set — /vapi ${open}`);
  if (!env.RETELL_API_KEY) console.warn(`  ⚠️  RETELL_API_KEY not set — /retell ${open}`);
});
