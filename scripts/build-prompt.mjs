#!/usr/bin/env node
/**
 * Assembles the final system prompt: core rules + vertical prompt + business data.
 *
 *   node scripts/build-prompt.mjs --platform vapi
 *   node scripts/build-prompt.mjs --platform retell --config path/to/config.yaml
 *
 * Writes dist/prompt.<platform>.md and dist/first-message.<platform>.txt.
 * New business = new config.yaml + rerun. The prompts are never edited per business.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../server/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Each platform injects the current time with its own template syntax.
export const NOW_VARIABLE = {
  vapi: '{{"now" | date: "%A %d/%m/%Y %H:%M", "Europe/Madrid"}}',
  retell: '{{current_time_Europe/Madrid}}',
};

const flatten = (obj, out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, out);
    else out[k] = v;
  }
  return out;
};

// Courtesy forms derive from voz.tratamiento — never hardcode tú/usted in a prompt.
const vars = (cfg) => {
  const usted = cfg.voz?.tratamiento === 'usted';
  return {
    ...flatten(cfg),
    te_atiende: usted ? 'le atiende' : 'te atiende',
    en_que_ayudo: usted ? '¿En qué puedo ayudarle?' : '¿En qué puedo ayudarte?',
    puedo_ayudar: usted ? 'puedo ayudarle' : 'puedo ayudarte',
    prefiere: usted ? 'prefiere' : 'prefieres',
    le_paso: usted ? 'le paso' : 'te paso',
    nombre_negocio: cfg.negocio?.nombre,
    horas_aviso: cfg.citas?.horas_aviso,
    politica_cancelacion: cfg.citas?.politica_cancelacion,
  };
};

export const firstMessage = (cfg) => {
  const usted = cfg.voz?.tratamiento === 'usted';
  const rec = cfg.voz?.aviso_grabacion ? ' y la llamada queda grabada' : '';
  return `${cfg.negocio?.nombre}, ${usted ? 'le atiende' : 'te atiende'} un asistente virtual${rec}. ` +
    (usted ? '¿En qué puedo ayudarle?' : '¿En qué puedo ayudarte?');
};

const render = (tpl, v) => tpl
  .replace(/\{\{#si\s+([\w.]+)\}\}([\s\S]*?)\{\{\/si\}\}/g, (_, k, block) => (v[k] ? block : ''))
  .replace(/\{\{([\w_]+)\}\}/g, (m, k) => (k !== 'now' && v[k] != null ? String(v[k]) : m));

const DAYS = [['lunes', 'Lunes'], ['martes', 'Martes'], ['miercoles', 'Miércoles'], ['jueves', 'Jueves'],
  ['viernes', 'Viernes'], ['sabado', 'Sábado'], ['domingo', 'Domingo']];

function businessData(cfg) {
  const n = cfg.negocio ?? {}, c = cfg.citas ?? {}, e = cfg.escalado ?? {};
  const L = ['## Datos del negocio — única fuente de verdad', '',
    'Solo puedes afirmar lo que esté aquí abajo o lo que devuelvan las herramientas. Cualquier otra cosa se escala.', '',
    '### Trato', `- Trata al cliente de **${cfg.voz?.tratamiento === 'usted' ? 'USTED' : 'TÚ'}** durante toda la llamada.`, '',
    '### Local', `- ${n.nombre} — ${n.descripcion_corta}, ${n.barrio}`];
  if (n.direccion) L.push(`- Dirección: ${n.direccion}`);
  if (n.como_llegar) L.push(`- Cómo llegar: ${n.como_llegar}`);
  L.push('', '### Horario');
  for (const [k, label] of DAYS) {
    const r = cfg.horarios?.[k];
    L.push(`- ${label}: ${!r || r.length === 0 ? 'CERRADO' : r.join(' y ')}`);
  }
  if (cfg.festivos?.length) L.push(`- Cerrado además: ${cfg.festivos.join(', ')}`);
  L.push('', '### Servicios (pasa el `id` a las herramientas)');
  for (const s of c.servicios ?? []) L.push(`- \`${s.id}\` **${s.nombre}** · ${s.duracion_min} min · ${s.precio}`);
  L.push('', '### Profesionales');
  for (const p of c.profesionales ?? []) L.push(`- **${p.nombre}** — ${p.hace.join(', ')}`);
  L.push(c.eleccion_profesional
    ? '\nEl cliente puede elegir profesional. Si no lo pide, pasa `cualquiera`.'
    : '\nNo se elige profesional: pasa siempre `cualquiera`.');
  L.push('', '### Preguntas frecuentes');
  for (const [k, v] of Object.entries(cfg.faq ?? {}))
    L.push(String(v).toUpperCase() === 'ESCALAR' ? `- **${k}**: ⚠️ NO respondas. Escala siempre a persona.` : `- **${k}**: ${v}`);
  L.push('- **alergias / salud / medicación**: ⚠️ NUNCA respondas. Escala siempre.', '', '### Escalado',
    e.transferencia_activa
      ? `- Transferencia a persona activa en: ${(e.horas_transferencia ?? []).join(' y ')}.`
      : '- Sin transferencia: siempre se toma recado.',
    `- Fuera de esas horas, recado con \`take_message\` (llega por ${e.destino_recados ?? 'mensaje'}).`);
  return L.join('\n');
}

export function buildPrompt(cfg, platform) {
  if (!NOW_VARIABLE[platform]) throw new Error(`Unknown platform "${platform}" (vapi | retell)`);
  const v = vars(cfg);
  const core = readFileSync(join(ROOT, 'agent/core-rules.md'), 'utf8');
  const vertical = readFileSync(join(ROOT, 'agent/appointments.prompt.md'), 'utf8');
  return [render(core, v).trim(), '\n---\n', render(vertical, v).replace(/^> Antepón.*$/m, '').trim(),
    '\n---\n', businessData(cfg), ''].join('\n').replaceAll('{{now}}', NOW_VARIABLE[platform]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    platform: { type: 'string', default: 'vapi' },
    config: { type: 'string', default: join(ROOT, 'agent/config.example.yaml') },
  } });
  const cfg = loadConfig(values.config);
  const prompt = buildPrompt(cfg, values.platform);
  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  writeFileSync(join(ROOT, `dist/prompt.${values.platform}.md`), prompt);
  writeFileSync(join(ROOT, `dist/first-message.${values.platform}.txt`), `${firstMessage(cfg)}\n`);
  const leftover = [...new Set([...prompt.matchAll(/\{\{([\w_]+)\}\}/g)].map(m => m[1]))];
  console.log(`✓ dist/prompt.${values.platform}.md (${prompt.split('\n').length} lines) · ${cfg.negocio.nombre}`);
  console.log(`✓ dist/first-message.${values.platform}.txt → "${firstMessage(cfg)}"`);
  if (leftover.length) { console.error(`✗ unresolved variables: ${leftover.join(', ')}`); process.exit(1); }
}
