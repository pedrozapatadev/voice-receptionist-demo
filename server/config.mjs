/**
 * Business config loader. Zero dependencies: parses the exact YAML subset the
 * configs use (nested maps, block lists, inline [..] / {..} flow values, comments).
 */

import { readFileSync } from 'node:fs';

// Quote-aware tokenizer: a single regex over the whole string confuses the
// colon in "09:00-14:00" with a key:value separator.
const flowToJson = (raw) => {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      let j = i + 1, s = '';
      while (j < raw.length) {
        if (raw[j] === '\\') { s += raw[j] + raw[j + 1]; j += 2; continue; }
        if (raw[j] === q) { j++; break; }
        s += raw[j]; j++;
      }
      out.push(JSON.stringify(s));
      i = j; continue;
    }
    if ('[]{},:'.includes(ch)) { out.push(ch); i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    let j = i;
    while (j < raw.length && !'[]{},:'.includes(raw[j])) j++;
    const t = raw.slice(i, j).trim();
    out.push(/^-?\d+(\.\d+)?$/.test(t) || ['true', 'false', 'null'].includes(t) ? t : JSON.stringify(t));
    i = j;
  }
  const json = out.join('');
  try { return JSON.parse(json); }
  catch (e) { throw new Error(`Cannot parse:\n  ${raw}\n  → ${json}\n  → ${e.message}`); }
};

const scalar = (v) => {
  const t = v.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('[') || t.startsWith('{')) return flowToJson(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1);
  return t;
};

export function parseYaml(text) {
  const lines = text.split('\n').filter(l => l.trim() !== '' && !/^\s*#/.test(l));
  const root = {};
  const stack = [{ indent: -1, node: root }];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\t/g, '  ');
    const indent = line.match(/^ */)[0].length;
    const body = line.trim().replace(/\s+#\s.*$/, '');

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];

    if (body.startsWith('- ')) {
      if (!Array.isArray(top.node)) throw new Error(`List item without a list: ${body}`);
      top.node.push(scalar(body.slice(2).trim()));
      continue;
    }

    const m = body.match(/^([^:]+):\s*(.*)$/);
    if (!m) throw new Error(`Unrecognised line: ${body}`);
    const key = m[1].trim();
    const rest = m[2].trim();

    if (rest !== '') { top.node[key] = scalar(rest); continue; }

    // Peek at the next line to decide whether this key opens a list or a map.
    const next = lines.slice(i + 1).find(l => l.trim() !== '');
    const isList = next && next.trim().startsWith('- ') && next.match(/^ */)[0].length > indent;
    const child = isList ? [] : {};
    top.node[key] = child;
    stack.push({ indent, node: child });
  }
  return root;
}

export const loadConfig = (path) => parseYaml(readFileSync(path, 'utf8'));
