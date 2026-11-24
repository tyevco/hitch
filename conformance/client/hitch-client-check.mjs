#!/usr/bin/env node
// hitch-client-check --client ./adapter.mjs [--only ids] [--ceiling decide] [--presence]
// The module's default export is factory(env) -> client adapter (see README).
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runClientChecks } from './checks.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const file = arg('--client');
if (!file) { console.error('usage: hitch-client-check --client ./adapter.mjs [--only ids]'); process.exit(2); }
const factory = (await import(pathToFileURL(resolve(file)).href)).default;
const r = await runClientChecks(factory, { only: arg('--only')?.split(','),
  mockOptions: { ceiling: arg('--ceiling') ?? 'decide', presence: process.argv.includes('--presence') } });
const n = (s) => r.filter((x) => x.status === s).length;
console.log(`\nclient suite: ${n('pass')}✓ ${n('fail')}✗ ${n('skip')}-`);
process.exit(n('fail') ? 1 : 0);
