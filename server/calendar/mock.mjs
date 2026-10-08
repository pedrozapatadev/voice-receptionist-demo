/**
 * Mock calendar: same interface as the Google adapter, kept in memory and
 * optionally mirrored to a JSON file so you can watch bookings land.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const revive = (ev) => ({ ...ev, start: new Date(ev.start), end: new Date(ev.end) });

export function createMockCalendar({ file = null, seed = [] } = {}) {
  const initial = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).map(revive) : seed.map(revive);
  const events = [...initial];

  const persist = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(events, null, 2));
  };

  return {
    kind: 'mock',
    async listEvents({ from, to }) {
      return events.filter(ev => ev.start < to && ev.end > from);
    },
    async createEvent({ start, end, summary, description, professional }) {
      const ev = { id: `mock-${randomUUID().slice(0, 8)}`, start, end, summary, description, professional };
      events.push(ev);
      persist();
      return { id: ev.id, link: file ? `file://${file}` : null };
    },
    /** Test/demo helper — not part of the adapter contract. */
    all: () => [...events],
  };
}
