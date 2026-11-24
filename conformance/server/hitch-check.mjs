#!/usr/bin/env node
// hitch-check --adapter ./my-adapter.mjs [--only id,profile,...] [--json]
// The adapter module's default export is an adapter object or a factory.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runChecks } from './checks.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const file = arg('--adapter');
if (!file) { console.error('usage: hitch-check --adapter ./adapter.mjs [--only ids] [--json]'); process.exit(2); }
const mod = await import(pathToFileURL(resolve(file)).href);
const adapter = typeof mod.default === 'function' ? await mod.default() : mod.default;
const json = process.argv.includes('--json');
const r = await runChecks(adapter, { only: arg('--only')?.split(','), log: json ? () => {} : console.log });
if (json) console.log(JSON.stringify({ profiles: r.profiles, claimable: r.claimable, overclaimed: r.overclaimed,
  results: r.results.map(({ id, profile, status, why, error }) => ({ id, profile, status, why, error: error?.message })) }, null, 2));
else {
  console.log('\nprofiles: ' + Object.entries(r.profiles).map(([k, v]) => `${k} ${v.pass}✓ ${v.fail}✗ ${v.skip}-`).join(' · '));
  console.log('may claim: ' + (r.claimable.join(', ') || 'none'));
  if (r.overclaimed.length) console.log('OVERCLAIMED in /.well-known/hitch: ' + r.overclaimed.join(', '));
}
process.exit(r.results.some((x) => x.status === 'fail') || r.overclaimed.length ? 1 : 0);
