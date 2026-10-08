#!/usr/bin/env node
/**
 * Offline walkthrough of a booking call — no voice platform, no account, no network.
 * Plays the tool calls an agent makes during a typical call against the mock
 * calendar, through the same Vapi webhook handler a real call hits.
 *
 *   npm run simulate
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.mjs';
import { createMockCalendar } from '../server/calendar/mock.mjs';
import { createNotifier } from '../server/notify.mjs';
import { createTools } from '../server/tools.mjs';
import { createApp } from '../server/http.mjs';
import { zonedToDate, localDate, weekdayKey, addMinutes, spokenEs } from '../server/time.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(join(ROOT, 'agent/config.example.yaml'));
const TZ = 'Europe/Madrid';

// Next weekday that's open and not a holiday, so the demo works on any date.
const nextOpenDay = (from) => {
  for (let d = 1; d < 30; d++) {
    const ymd = localDate(addMinutes(from, d * 1440), TZ);
    if (!cfg.festivos.includes(ymd) && cfg.horarios[weekdayKey(ymd, TZ)].length) return ymd;
  }
  throw new Error('no open day in the next 30 days');
};

const day = nextOpenDay(new Date());
// Someone already booked the first hour with Dra. Ruiz.
const calendar = createMockCalendar({ seed: [{
  id: 'seed-1', start: zonedToDate(day, '09:00', TZ), end: zonedToDate(day, '10:00', TZ),
  summary: 'Blanqueamiento — (cita existente)', professional: 'Dra. Ruiz',
}] });
const tools = createTools({ cfg, calendar, notifier: createNotifier({ env: {} }) });
const server = createApp({ tools, env: {} }).listen(0);
const url = `http://localhost:${server.address().port}/vapi`;

let n = 0;
async function toolCall(name, args) {
  const body = { message: { type: 'tool-calls', toolCallList: [{ id: `call_${++n}`, type: 'function', function: { name, arguments: args } }] } };
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = JSON.parse((await res.json()).results[0].result);
  console.log(`\n→ ${name} ${JSON.stringify(args)}\n← ${JSON.stringify(result, null, 2)}`);
  return result;
}

const say = (who, text) => console.log(`\n${who === 'A' ? '🤖 Agente ' : '👤 Cliente'}  ${text}`);

say('A', 'Clínica Dental Ejemplo, le atiende un asistente virtual. ¿En qué puedo ayudarle?');
say('C', `Quería una limpieza para el ${spokenEs(zonedToDate(day, '12:00', TZ), TZ).split(',')[0]}, por la mañana si puede ser.`);
say('A', 'Un segundo, que lo miro.');
const avail = await toolCall('check_availability', { date: day, services: ['limpieza'], professional: 'cualquiera' });
const [a, b] = avail.slots;
// The LLM turns tool output into speech ("a las diez y cuarto"); the simulator just quotes it.
say('A', `Tengo ${a.spoken.split(', ')[1]} o ${b.spoken.split(', ')[1]}, con ${a.professional}. ¿Cuál le viene mejor?`);
say('C', 'La primera. Me llamo Marta, mi teléfono es el seis, cero, cero…');
say('A', 'Le repito el teléfono para confirmar… Perfecto. ¿Es la primera vez que viene?');
say('C', 'Sí.');
const booked = await toolCall('book_appointment', {
  start: a.start, services: ['limpieza'], professional: a.professional,
  name: 'Marta (demo)', phone: '+34 000 000 000', new_client: true,
});
say('A', `Listo, Marta: limpieza el ${booked.spoken} con ${booked.professional}. ¡Hasta entonces!`);

console.log('\n--- y si otro cliente intenta el mismo hueco ---');
await toolCall('book_appointment', { start: a.start, services: ['limpieza'], professional: a.professional, name: 'Otro', phone: '+34 000 000 001' });

console.log('\n--- endodoncia con el Dr. Martín (no la hace) ---');
await toolCall('check_availability', { date: day, services: ['endodoncia'], professional: 'Dr. Martín' });

console.log(`\nCalendario (mock): ${calendar.all().length} eventos`);
server.close();
