/**
 * Google Calendar adapter over the REST API with a service account. No SDK:
 * a signed JWT is exchanged for an access token (cached until it expires).
 *
 * Setup: create a service account, download its JSON key (never commit it),
 * and share the target calendar with the service account's email
 * ("Make changes to events").
 */

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { zonedToDate } from '../time.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const TIMEOUT_MS = 5000;   // a hung Google call must not outlive the voice platform's tool timeout
const API = 'https://www.googleapis.com/calendar/v3';

const b64url = (s) => Buffer.from(s).toString('base64url');

function signedAssertion({ client_email, private_key }, nowSec) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600,
  }));
  const sig = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(private_key, 'base64url');
  return `${header}.${claims}.${sig}`;
}

/**
 * Busy events for a window. All-day events (holidays, "closed for training") block the
 * whole local day even though Google creates them as "free" by default; timed events
 * marked "free" don't block.
 */
export const toBusy = (items, tz) => items
  .filter(ev => ev.status !== 'cancelled' && (ev.start?.date || ev.transparency !== 'transparent'))
  .map(ev => ({
    id: ev.id,
    start: ev.start.dateTime ? new Date(ev.start.dateTime) : zonedToDate(ev.start.date, '00:00', tz),
    end: ev.end.dateTime ? new Date(ev.end.dateTime) : zonedToDate(ev.end.date, '00:00', tz),
    summary: ev.summary,
    professional: ev.extendedProperties?.private?.professional ?? null,
  }));

export function createGoogleCalendar({ calendarId, keyFile, tz = 'Europe/Madrid', fetchImpl = fetch, key: keyObj }) {
  if (!calendarId || !(keyFile || keyObj)) throw new Error('GOOGLE_CALENDAR_ID and GOOGLE_SERVICE_ACCOUNT_KEY_FILE are required for CALENDAR_BACKEND=google');
  const key = keyObj ?? JSON.parse(readFileSync(keyFile, 'utf8'));
  const cache = { token: null, exp: 0 };

  async function token() {
    const nowSec = Math.floor(Date.now() / 1000);
    if (cache.token && nowSec < cache.exp - 60) return cache.token;
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedAssertion(key, nowSec),
      }),
    });
    if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`);
    const json = await res.json();
    Object.assign(cache, { token: json.access_token, exp: nowSec + json.expires_in });
    return cache.token;
  }

  async function call(path, init = {}) {
    const res = await fetchImpl(`${API}/calendars/${encodeURIComponent(calendarId)}${path}`, {
      ...init, signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', ...init.headers },
    });
    if (!res.ok) throw new Error(`Google Calendar ${init.method ?? 'GET'} ${path.split('?')[0]} failed: ${res.status}`);
    return res.json();
  }

  return {
    kind: 'google',
    async listEvents({ from, to }) {
      const items = [];
      const page = { token: undefined };
      do {   // follow nextPageToken: a page can come back short even below maxResults
        const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(),
          singleEvents: 'true', maxResults: '250', ...(page.token && { pageToken: page.token }) });
        const json = await call(`/events?${q}`);
        items.push(...(json.items ?? []));
        page.token = json.nextPageToken;
      } while (page.token);
      return toBusy(items, tz);
    },
    async createEvent({ start, end, summary, description, professional }) {
      const ev = await call('/events', {
        method: 'POST',
        body: JSON.stringify({
          summary, description,
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
          extendedProperties: { private: { professional, source: 'voice-receptionist' } },
        }),
      });
      return { id: ev.id, link: ev.htmlLink ?? null };
    },
  };
}
