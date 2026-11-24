import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeValidator, loadPack } from '../conformance/lib/schema.mjs';
import { check, catalogue, failing, audit } from '../conformance/catalog-check.mjs';

const V = makeValidator();
const codes = JSON.parse(readFileSync(new URL('../codes.json', import.meta.url)));
const ulid = '01JD7Y3Q8K2M4N5P6R7S8T9V0W', H = 'sha256:' + 'a'.repeat(64), T = '2026-11-24T14:03:11.402Z';

test('every pack schema uses only keywords the validator supports, and every $ref resolves', () => {
  for (const [f] of loadPack()) V.validate(f, {}); // throws on an unsupported keyword or a dangling $ref reached
});

test('every schema file is named for its $id', () => {
  for (const [f, s] of loadPack()) assert.ok(s.$id.endsWith('/' + f), f);
});

const decision = { spec: 'hitch/1', id: 'dec_' + ulid, kind: 'outbox.send@1', rev: 7, state: 'open', owner: 'outbox',
  requester: { principal: 'mod:outbox', session: 's-1' }, title: 'Reply to Dana', summary: '', effect: 'Sends a Teams message to Dana as you',
  preview: [{ label: 'To', value: 'Dana' }, { label: 'Body', digest: H, ref: H, bytes: 812 }], bind: { alg: 'sha256/v1', hash: H }, safety: 'send',
  audience: 'person', options: [{ verb: 'approve', label: 'Send', tier: 'confirm', allowedForYou: false }, { verb: 'sendBack', tier: 'decide', needsText: true, maxText: 2000 }, { verb: 'decline', tier: 'narrow' }],
  remoteApprove: false, urgency: 'normal', expires: null, onExpire: 'withdraw', created: T, updated: T };

test('the SPEC examples validate', () => {
  assert.deepEqual(V.validate('hitch.decision@1', decision), []);
  assert.deepEqual(V.validate('hitch.decision@1', { ...decision, audience: { member: 'm-lead' } }), []);
  assert.deepEqual(V.validateEnvelope({ spec: 'hitch/1', id: ulid, seq: 48213, time: T, type: 'hitch.changed@1', subject: 'decision/dec_' + ulid,
    from: { aid: 'k3v9q2m7x1ab', principal: 'client:c_7fk2' }, to: { session: 's-1' }, privacy: 'public',
    data: { resource: 'decisions', id: 'dec_' + ulid, rev: 7, op: 'update', state: 'open' } }), []);
  assert.deepEqual(V.validate('hitch.answer@1', { decisionId: 'dec_' + ulid, aid: 'k3v9q2m7x1ab', verb: 'approve', rev: 7, bindHash: H, shownHash: H,
    iat: 1, exp: 121, nonce: 'abcdefghijklmnop', presence: { suite: 'webauthn', kid: 'cred', v: 'sig', ad: 'ad', cd: 'cd' } }), []);
});

test('every keyword in the pack is exercised: a report.send@1 with the v2 bridge validates, and maxProperties bites', () => {
  const H = 'sha256:' + 'b'.repeat(64);
  const args = { week: '2026-11-16', to: ['sam@example.com'], subject: 'Weekly status', body: { content: H, bytes: 10 },
    v2: { item: 'report:2026-11-16', actions: { approve: { mod: 'report', kind: 'send', args: { week: '2026-11-16' } } } } };
  assert.deepEqual(V.validate('report.send@1', args), []);
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`v${i}`, { mod: 'm', kind: 'k', args: {} }]));
  assert.match(V.validate('report.send@1', { ...args, v2: { ...args.v2, actions: many } }).join('|'), /more than 8 properties/);
});

test('the validator rejects what it should', () => {
  const bad = (n, v, re) => assert.match(V.validate(n, v).join('|'), re);
  { const { summary, ...noSummary } = decision; bad('hitch.decision@1', noSummary, /missing "summary"/); }
  bad('hitch.decision@1', { ...decision, options: [{ verb: 'approve', tier: 'root' }] }, /must be one of/);
  bad('hitch.answer@1', { decisionId: 'dec_' + ulid }, /missing "verb"/);
  bad('hitch.answer@1', { decisionId: 'dec_' + ulid, aid: 'k3v9q2m7x1ab', verb: 'approve', rev: 1, bindHash: H, shownHash: H, iat: 1, exp: 2, nonce: 'abcdefghijklmnop', args: {} }, /unexpected "args"/);
  bad('hitch.envelope', { spec: 'hitch/1', id: ulid, seq: 1, time: T, type: 'nope', from: { aid: 'k3v9q2m7x1ab', principal: 'node' }, privacy: 'meta' }, /type: does not match/);
  assert.match(V.validateEnvelope({ spec: 'hitch/1', id: ulid, seq: 1, time: T, type: 'hitch.changed@1', from: { aid: 'k3v9q2m7x1ab', principal: 'node' }, privacy: 'public', data: { resource: 'x' } }).join('|'), /\$\.data/);
  bad('hitch.envelope', { spec: 'hitch/1', id: ulid, seq: 1, time: T, type: 'a.b@1', from: { aid: 'k3v9q2m7x1ab', principal: 'node' }, privacy: 'meta', to: { session: 's', aid: 'k3v9q2m7x1ab' } }, /oneOf/);
});

test('refusal codes: the schema enum and codes.json agree', () => {
  const pack = loadPack();
  assert.deepEqual([...pack.get('hitch.refusal.schema.json').properties.code.enum].sort(), Object.keys(codes.codes).sort());
});

test('catalogue: every hitch-owned type has a schema; decision kinds have floors; safety kinds are never below confirm', () => {
  for (const [t, c] of Object.entries(catalogue.types)) {
    if (c.owner === 'hitch') assert.ok(V.has(t), `${t} needs a schema`);
    if (c.decision) assert.ok(['decide', 'confirm', 'local', 'vendor', 'inherit'].includes(c.floor), t);
    if (c.floor === 'inherit') { assert.equal(c.safety, 'inherit', `${t}: an inherited floor inherits safety too`); continue; }
    if (c.decision && c.safety !== 'none') assert.ok(['confirm', 'local'].includes(c.floor), `${t} is a safety kind`);
    const R = ['narrow', 'decide', 'confirm', 'local'];
    for (const [verb, f] of Object.entries(c.verbFloors ?? {})) {
      assert.ok(['decline', 'deny', 'sendBack', 'discard'].includes(verb), `${t}: verbFloors names ${verb}, which may run a side effect`);
      assert.ok(R.includes(f) && R.indexOf(f) <= R.indexOf(c.floor === 'vendor' ? 'local' : c.floor), `${t}: verbFloors.${verb} above the floor`);
    }
  }
});

test('vendor-pending kinds warn without failing the gate, unless strict', () => {
  const f = check({ decisionKinds: ['herdr-teams.hire@1', 'pairview.rule@1'] });
  assert.equal(f.length, 2); assert.ok(f.every((x) => x.warning === 'vendor-pending'));
  assert.deepEqual(failing(f), []);
  assert.equal(failing(f, { strict: true }).length, 2);
  for (const [t, c] of Object.entries(catalogue.types)) if (c.vendorPending) assert.match(t, /^(herdr-teams|pairview)\./, `${t}: only vendor-owned kinds may be vendorPending`);
});

test('the whole-catalogue audit has no failing gaps: every first-party kind has a schema or is declared-only', () => {
  const f = audit();
  assert.deepEqual(failing(f).map((x) => `${x.type}: ${x.problem}`), []);
  assert.ok(f.some((x) => x.warning?.startsWith('declared, not emitted')), 'declared-only kinds still show');
  assert.equal(failing(check({ decisionKinds: ['queue.plan@1'] })).length, 1, 'emitting a declared-only kind without a schema fails the gate');
});

test('catalog-check (sdk:check) flags missing schemas, missing tiers and tiers below floor', () => {
  assert.deepEqual(check({ types: ['hitch.changed@1', 'work.started@1'], decisionKinds: ['wins.confirm@1'] }), []);
  const f = check({ types: ['acme.thing@1', 'Bad'], decisionKinds: ['acme.ask@1', 'outbox.send@1'], tiers: { 'outbox.send@1': 'decide' } });
  assert.deepEqual(f.map((x) => `${x.type}:${x.problem.split(' ')[0]}`).sort(),
    ['Bad:bad', 'acme.ask@1:decision', 'acme.ask@1:no', 'acme.thing@1:no', 'outbox.send@1:tier'].sort());
});
