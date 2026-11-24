#!/usr/bin/env node
// hitch-catalog-check: the sdk:check gate. Given what an implementation emits,
// fail if any topic or decision kind lacks a schema, or any decision kind lacks
// a tier. Input: JSON {types:[...], decisionKinds:[...], schemaDirs?:[...],
// tiers?:{kind:tier}} via --emitted FILE. Exit 0 clean, 1 findings, 2 usage.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const catalogue = JSON.parse(readFileSync(join(ROOT, 'catalogue.json'), 'utf8'));
const TIER = new Set(['narrow', 'decide', 'confirm', 'local']);

function patternHit(t) {
  return Object.entries(catalogue.patterns).find(([p]) => new RegExp('^' + p.replace(/\./g, '\\.').replace('*', '[a-z0-9.-]+') + '$').test(t))?.[1];
}

export function check({ types = [], decisionKinds = [], schemaDirs = [], tiers = {} }, base = process.cwd()) {
  const schemas = new Set(readdirSync(join(ROOT, 'types')).filter((f) => f.endsWith('.schema.json')).map((f) => f.slice(0, -12)));
  for (const d of schemaDirs) {
    const p = resolve(base, d);
    if (existsSync(p)) for (const f of readdirSync(p)) if (f.endsWith('.schema.json')) schemas.add(f.slice(0, -12));
  }
  const findings = [];
  for (const t of new Set([...types, ...decisionKinds])) {
    if (!/^[a-z][a-z0-9-]*(\.[a-z][a-zA-Z0-9-]*)+@[1-9][0-9]*$/.test(t)) { findings.push({ type: t, problem: 'bad type name (owner.name@major)' }); continue; }
    if (!schemas.has(t) && !patternHit(t)) findings.push({ type: t, problem: 'no schema' });
  }
  for (const k of new Set(decisionKinds)) {
    const c = catalogue.types[k];
    if (c?.floor === 'inherit') continue; // raised by the node; tier and safety come from the original decision
    const floor = c?.floor === 'vendor' ? 'local' : c?.floor;
    const tier = tiers[k] ?? floor;
    if (!tier || !TIER.has(tier)) findings.push({ type: k, problem: 'decision kind without a tier' });
    else if (floor && TIER.has(floor) && [...TIER].indexOf(tier) < [...TIER].indexOf(floor))
      findings.push({ type: k, problem: `tier ${tier} below the spec floor ${floor}` });
  }
  // vendorPending: an owner outside this project writes the schema. Kept
  // visible as a warning; it fails the gate only under strict.
  for (const f of findings) if (catalogue.types[f.type]?.vendorPending && f.problem === 'no schema') f.warning = 'vendor-pending';
  return findings;
}
export const failing = (findings, { strict = false } = {}) => findings.filter((f) => strict || !f.warning);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--emitted');
  if (i < 0 || !process.argv[i + 1]) { console.error('usage: hitch-catalog-check --emitted emitted.json [--strict]'); process.exit(2); }
  const file = resolve(process.argv[i + 1]);
  const strict = process.argv.includes('--strict');
  const f = check(JSON.parse(readFileSync(file, 'utf8')), resolve(file, '..'));
  const bad = failing(f, { strict });
  for (const x of f) console.log(`${bad.includes(x) ? '✗' : '!'} ${x.type}: ${x.problem}${x.warning ? ` (${x.warning})` : ''}`);
  const warn = f.length - bad.length;
  console.log(bad.length ? `${bad.length} finding(s)` : '✓ every emitted type has a schema and every decision kind a tier');
  if (warn) console.log(`${warn} vendor-pending (not failing; --strict to fail on them)`);
  process.exit(bad.length ? 1 : 0);
}
