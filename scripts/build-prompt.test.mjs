import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.mjs';
import { buildPrompt, firstMessage, NOW_VARIABLE } from './build-prompt.mjs';

const cfg = loadConfig(join(dirname(fileURLToPath(import.meta.url)), '../agent/config.example.yaml'));

for (const platform of ['vapi', 'retell']) {
  test(`${platform}: no unresolved template variables, platform time injected`, () => {
    const p = buildPrompt(cfg, platform);
    assert.deepEqual([...p.matchAll(/\{\{([\w_]+)\}\}/g)].map(m => m[1]), []);
    assert.ok(p.includes(NOW_VARIABLE[platform]));
  });
}

test('AI disclosure is in the first message and the prompt (AI Act Art. 50)', () => {
  assert.match(firstMessage(cfg), /asistente virtual/);
  assert.match(buildPrompt(cfg, 'vapi'), /di que eres un asistente virtual/);
});

test('tú/usted follows the config everywhere', () => {
  const usted = buildPrompt(cfg, 'vapi');
  assert.match(firstMessage(cfg), /le atiende/);
  assert.match(usted, /Trata al cliente de \*\*USTED\*\*/);
  const tu = { ...cfg, voz: { ...cfg.voz, tratamiento: 'tu' } };
  assert.match(firstMessage(tu), /te atiende.*ayudarte/);
  assert.match(buildPrompt(tu, 'vapi'), /Trata al cliente de \*\*TÚ\*\*/);
});

test('escalate-only FAQ entries are never answered', () => {
  assert.match(buildPrompt(cfg, 'vapi'), /\*\*seguros\*\*: ⚠️ NO respondas/);
});
