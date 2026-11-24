// hitch-check: the server suite. Black-box over HTTP, plus an adapter the
// implementation supplies for things the wire cannot do (mint credentials,
// request decisions as a mod, move the clock, restart). See conformance/README.md.
import assert from 'node:assert/strict';
import { connect, verifiedBy } from '../lib/client.mjs';
import { makeValidator } from '../lib/schema.mjs';
import { shownHash } from '../lib/wire.mjs';
import codes from '../../codes.json' with { type: 'json' };

const V = makeValidator();
const ok = (name, v) => { const e = V.validate(name, v); assert.deepEqual(e, [], `${name}: ${e.join('; ')}`); };
function refused(r, code, why = '') {
  assert.equal(r.body?.code, code, `${why} expected refusal ${code}, got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  assert.equal(r.status, codes.codes[code].status, `${code} must be HTTP ${codes.codes[code].status}`);
  ok('hitch.refusal', r.body);
}
const plain = { kind: 'wins.confirm@1', args: { win: 'w1', title: 'Shipped hitch-check' } };       // decide, safety none
const send = { kind: 'outbox.send@1', args: { channel: 'teams', to: 'Dana', body: { content: 'sha256:' + '0'.repeat(64), bytes: 0 }, send: { body: { content: 'sha256:' + '0'.repeat(64), bytes: 0 }, path: '/chats/19:x/messages' } } };          // confirm, safety send
const local = { kind: 'kernel.settings.confirm@1', args: { key: 'x', value: true } }; // local

// Each check: {id, profile, title, needs?: [adapter hooks], run(ctx)}
export const CHECKS = [
  // ---- core ---------------------------------------------------------------------
  { id: 'discovery', profile: 'core', title: 'GET /.well-known/hitch is schema-valid, no auth, claims hitch/1',
    async run({ url }) {
      const r = await fetch(url + '/.well-known/hitch');
      assert.equal(r.status, 200);
      const d = await r.json();
      ok('hitch.discovery', d);
      assert.ok(d.specs.includes('hitch/1'));
      assert.ok(d.profiles.includes('core'));
      const { nodeKid } = await import('../lib/wire.mjs');
      assert.equal(d.nodeKey.kid, nodeKid(d.aid, d.nodeKey.x), 'kid = node:<aid>:<first 8 hex of sha256(raw x)>');
    } },
  { id: 'sockhello', profile: 'core', title: 'sockhello: the node signs the client challenge with its key, unauthenticated',
    async run({ url, aid, discovery }) {
      const { b64u, verifyObject } = await import('../lib/wire.mjs');
      const challenge = b64u((await import('node:crypto')).randomBytes(32));
      const r = await fetch(url + '/hitch/v1/sockhello', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: 'hitch/1', challenge }) });
      assert.equal(r.status, 200);
      const b = await r.json();
      assert.equal(b.challenge, challenge); assert.equal(b.aid, aid);
      const signed = { purpose: 'hitch-sockhello', spec: 'hitch/1', aid, challenge, sig: b.sig };
      assert.ok(verifyObject(signed, { suite: 'ed25519', pub: discovery.nodeKey.x }), 'sig over JCS({purpose, spec, aid, challenge}) with the node key');
    } },
  { id: 'hello', profile: 'core', title: 'hello names the principal from the credential, and the ceiling for clients',
    async run({ as }) {
      const m = await as('mod').hello();
      assert.equal(m.status, 200); ok('hitch.hello.response', m.body);
      assert.match(m.body.principal, /^mod:/);
      const c = await as('clientDecide').hello();
      assert.equal(c.status, 200); ok('hitch.hello.response', c.body);
      assert.match(c.body.principal, /^client:/);
      assert.equal(c.body.ceiling, 'decide');
    } },
  { id: 'unauthenticated', profile: 'core', title: 'no credential, bad signature, and stale iat give unauthenticated',
    async run({ url, aid, P }) {
      refused(await connect(url, aid, null).list('decisions'), 'unauthenticated', 'no credential:');
      refused(await connect(url, aid, { token: 'nope' }).list('decisions'), 'unauthenticated', 'bad token:');
      const forged = { ...P.clientDecide, key: P.clientConfirm.key };
      refused(await connect(url, aid, forged).list('decisions'), 'unauthenticated', 'wrong key:');
      refused(await connect(url, 'zzzzzz', P.clientDecide).list('decisions'), 'unauthenticated', 'signed for another aid:');
    } },
  { id: 'request-replay', profile: 'core', title: 'a signed request replayed with the same nonce is refused',
    async run({ url, aid, P }) {
      const { signRequest } = await import('../lib/wire.mjs');
      const h = signRequest({ cid: P.clientDecide.cid, key: P.clientDecide.key, aid, method: 'GET', path: '/hitch/v1/decisions' });
      const a = await fetch(url + '/hitch/v1/decisions', { headers: h });
      assert.equal(a.status, 200);
      const b = await fetch(url + '/hitch/v1/decisions', { headers: h });
      refused({ status: b.status, body: await b.json() }, 'replay');
    } },
  { id: 'lists', profile: 'core', title: 'every list is schema-valid with a cursor',
    async run({ as }) {
      for (const r of ['decisions', 'items', 'sessions', 'messages', 'clients']) {
        const x = await as('clientDecide').list(r);
        assert.equal(x.status, 200, r); ok('hitch.list', x.body); assert.equal(x.body.resource, r);
        for (const d of r === 'decisions' ? x.body.list : []) ok('hitch.decision@1', d);
      }
    } },
  { id: 'envelopes', profile: 'core', title: 'stream events are schema-valid, node-signed envelopes with rising seq',
    async run(ctx) {
      const { adapter, as, verify } = ctx;
      const c = as('clientDecide');
      const start = (await c.list('decisions')).body.cursor;
      await adapter.requestDecision(plain);
      const r = await c.poll(start);
      assert.equal(r.status, 200); ok('hitch.events', r.body);
      assert.ok(r.body.events.length >= 1, 'a new decision must emit at least hitch.changed@1');
      let last = start;
      for (const e of r.body.events) {
        assert.deepEqual(V.validateEnvelope(e), []);
        assert.ok(e.seq > last, 'seq strictly rising'); last = e.seq;
        assert.ok(verify(e), `node signature on ${e.type} must verify against /.well-known nodeKey`);
        assert.equal(e.sig.kid, ctx.discovery.nodeKey.kid, 'sig.kid names the current node key');
      }
      assert.ok(r.body.events.some((e) => e.type === 'hitch.changed@1' && e.data.resource === 'decisions'));
    } },
  { id: 'sse-equals-longpoll', profile: 'core', title: 'SSE and long-poll deliver the same events from the same cursor',
    async run({ adapter, as }) {
      const c = as('clientDecide');
      const start = (await c.list('decisions')).body.cursor;
      await adapter.requestDecision(plain); await adapter.requestDecision(plain);
      const lp = (await c.poll(start)).body.events.map((e) => e.id);
      const s = await c.sse({ after: start, until: (e) => e.length >= lp.length });
      assert.deepEqual(s.events.map((e) => e.id), lp);
      for (const e of s.events) assert.equal(String(e.seq), e._sseId, 'SSE id: must be the seq');
    } },
  { id: 'resume', profile: 'core', title: 'Last-Event-ID resumes exactly after that seq',
    async run({ adapter, as }) {
      const c = as('clientDecide');
      const start = (await c.list('decisions')).body.cursor;
      await adapter.requestDecision(plain); await adapter.requestDecision(plain);
      const all = (await c.poll(start)).body.events;
      const s = await c.sse({ lastEventId: all[0].seq, until: (e) => e.length >= all.length - 1 });
      assert.deepEqual(s.events.map((e) => e.seq), all.slice(1).map((e) => e.seq));
    } },
  { id: 'longpoll-waits', profile: 'core', title: 'long-poll with wait returns as soon as an event arrives',
    async run({ adapter, as }) {
      const c = as('clientDecide');
      const start = (await c.list('decisions')).body.cursor;
      const t0 = Date.now();
      const p = c.poll(start, 10);
      setTimeout(() => adapter.requestDecision(plain), 150);
      const r = await p;
      assert.ok(r.body.events.length >= 1);
      assert.ok(Date.now() - t0 < 5000, 'returned promptly');
    } },
  { id: 'gap', profile: 'core', title: 'a cursor older than retention gives 410 gap with resync; re-list loses no rev', needs: ['trimEvents'],
    async run({ adapter, as }) {
      const c = as('clientDecide');
      const start = (await c.list('decisions')).body.cursor;
      const id = await adapter.requestDecision(plain);
      await adapter.editDecision(id);
      await adapter.trimEvents(1000000);
      const r = await c.poll(start);
      refused(r, 'gap');
      assert.ok(r.body.resync?.includes('decisions'));
      const s = await c.sse({ after: start });
      assert.equal(s.status, 410, 'SSE connect past retention is 410 too');
      const l = (await c.list('decisions')).body;
      const d = l.list.find((x) => x.id === id);
      assert.equal(d.rev, 2, 're-list carries the latest rev');
      assert.equal((await c.poll(l.cursor)).status, 200, 'resume from the list cursor works');
    } },
  { id: 'from-stamped', profile: 'core', title: 'a body-supplied from is overwritten with the credential', needs: ['publishType'],
    async run({ adapter, as }) {
      const m = as('mod');
      const { type, data } = await adapter.publishType();
      const r = await m.post('/hitch/v1/publish', { type, data, from: { aid: 'evil01', principal: 'client:c_evil' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.match(r.body.from.principal, /^mod:/);
      assert.notEqual(r.body.from.aid, 'evil01');
    } },
  { id: 'publish-owner-only', profile: 'core', title: 'a mod cannot publish another owner\'s type', needs: ['publishType'],
    async run({ as }) {
      refused(await as('mod').post('/hitch/v1/publish', { type: 'hitch.question@1', data: {} }), 'scope');
      refused(await as('clientDecide').post('/hitch/v1/publish', { type: 'hitch.question@1', data: {} }), 'scope');
    } },

  // ---- decisions ------------------------------------------------------------------------
  { id: 'decision-signed', profile: 'decisions', title: 'GET decision is schema-valid and node-signed; allowedForYou is per client',
    async run({ adapter, as, verify }) {
      const id = await adapter.requestDecision(send);
      const r = await as('clientDecide').decision(id);
      assert.equal(r.status, 200); ok('hitch.decision@1', r.body);
      assert.ok(verify(r.body), 'decision body signature');
      assert.equal(r.body.safety, 'send');
      const ap = r.body.options.find((o) => o.verb === 'approve');
      assert.ok(['confirm', 'local'].includes(ap.tier), 'outbox.send@1 approve floor is confirm');
      assert.equal(ap.allowedForYou, false, 'a decide-ceiling client is not allowed a confirm option');
    } },
  { id: 'not-a-client', profile: 'decisions', title: 'mod, app and session credentials get not_a_client',
    async run({ adapter, as, P }) {
      const id = await adapter.requestDecision(plain);
      const d = (await as('clientDecide').decision(id)).body;
      for (const who of ['mod', 'app', 'session']) {
        if (!P[who]) continue;
        refused(await as(who).answer(id, 'approve', { decision: d }), 'not_a_client', `${who}:`);
      }
      assert.equal((await as('clientDecide').decision(id)).body.state, 'open');
    } },
  { id: 'decide-answer', profile: 'decisions', title: 'a decide client answers a decide option; the outcome is recorded with audit',
    async run({ adapter, as }) {
      const id = await adapter.requestDecision(plain);
      const r = await as('clientDecide').answer(id, 'approve');
      assert.equal(r.status, 200, JSON.stringify(r.body)); ok('hitch.decision@1', r.body);
      assert.notEqual(r.body.state, 'open');
      const a = await as('clientDecide').get(`/hitch/v1/decisions/${id}/audit`);
      assert.equal(a.status, 200);
      assert.ok(a.body.audit.some((x) => x.event === 'answered'), 'audit has the answer');
    } },
  { id: 'tier', profile: 'decisions', title: 'an option above the client ceiling gives tier',
    async run({ adapter, as }) {
      const id = await adapter.requestDecision(send);
      refused(await as('clientDecide').answer(id, 'approve'), 'tier');
    } },
  { id: 'narrow-decline', profile: 'decisions', title: 'decline is narrow: a decide client may decline a send',
    async run({ adapter, as }) {
      const id = await adapter.requestDecision(send);
      const r = await as('clientDecide').answer(id, 'decline');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.outcome, 'declined');
      assert.equal(await adapter.executorCalls?.(id) ?? 0, 0, 'a decline never runs the executor');
    } },
  { id: 'send-back-below-floor', profile: 'decisions', title: 'sendBack on a send is decide (it reaches nobody else) and runs nothing; approve stays confirm', needs: ['executorCalls'],
    async run({ adapter, as }) {
      const id = await adapter.requestDecision({ ...send, options: [{ verb: 'approve', label: 'Send' }, { verb: 'sendBack', label: 'Send back', needsText: true, maxText: 2000 }, { verb: 'decline' }] });
      const d = (await as('clientDecide').decision(id)).body;
      assert.equal(d.options.find((o) => o.verb === 'approve').tier, 'confirm');
      assert.equal(d.options.find((o) => o.verb === 'sendBack').tier, 'decide', 'catalogue verbFloors {sendBack: decide}');
      const r = await as('clientDecide').answer(id, 'sendBack', { text: 'Shorter, please' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.outcome, 'sent-back');
      assert.equal(await adapter.executorCalls(id), 0, 'a send-back never runs the executor');
    } },
  { id: 'step-up', profile: 'decisions', title: 'confirm without a presence proof gives step_up_required; with one it is accepted',
    async run({ adapter, as }) {
      const id = await adapter.requestDecision(send);
      refused(await as('clientConfirm').answer(id, 'approve', { noPresence: true }), 'step_up_required');
      const bad = await as('clientConfirm').answer(id, 'approve', { mutate: (a) => ({ ...a, presence: { ...a.presence, v: a.presence.v.slice(0, -4) + 'AAAA' } }) });
      refused(bad, 'step_up_required', 'forged presence:');
      const r = await as('clientConfirm').answer(id, 'approve');
      assert.equal(r.status, 200, JSON.stringify(r.body));
    } },
  { id: 'local-step-up', profile: 'decisions', title: 'local without presence gives step_up_required, even from a local-ceiling client',
    async run({ adapter, as, P }) {
      if (!P.clientLocal) throw new Skip('adapter has no clientLocal');
      const id = await adapter.requestDecision(local);
      refused(await as('clientLocal').answer(id, 'approve', { noPresence: true }), 'step_up_required');
    } },
  { id: 'suite', profile: 'decisions', title: 'an hmac-sha256 client is refused on confirm with suite',
    async run({ adapter, as, P }) {
      if (!P.clientHmac) throw new Skip('adapter has no clientHmac');
      const id = await adapter.requestDecision(send);
      refused(await as('clientHmac').answer(id, 'approve'), 'suite');
      const h = await as('clientHmac').hello();
      assert.ok(['narrow', 'decide'].includes(h.body.ceiling), 'hmac ceiling is at most decide');
    } },
  { id: 'stale', profile: 'decisions', title: 'stale rev, bind or shown hash gives stale with the current rev',
    async run({ adapter, as }) {
      const c = as('clientDecide');
      const id = await adapter.requestDecision(plain);
      const old = (await c.decision(id)).body;
      await adapter.editDecision(id);
      const r = await c.answer(id, 'approve', { decision: old });
      refused(r, 'stale', 'old rev:'); assert.equal(r.body.current?.rev, old.rev + 1);
      refused(await c.answer(id, 'approve', { mutate: (a) => ({ ...a, bindHash: 'sha256:' + '0'.repeat(64) }) }), 'stale', 'bad bind:');
      const relabel = (await c.decision(id)).body;
      refused(await c.answer(id, 'approve', { decision: relabel, mutate: (a) => ({ ...a, shownHash: shownHash({ ...relabel, title: 'Something harmless' }) }) }), 'stale', 'relabelled:');
      assert.equal((await c.decision(id)).body.state, 'open');
    } },
  { id: 'one-winner', profile: 'decisions', title: 'two clients answering at once: exactly one wins, the other gets already + winner',
    async run({ adapter, as, P }) {
      const id = await adapter.requestDecision(plain);
      const second = P.clientDecide2 ? 'clientDecide2' : 'clientConfirm';
      const [d1, d2] = [(await as('clientDecide').decision(id)).body, (await as(second).decision(id)).body];
      const rs = await Promise.all([as('clientDecide').answer(id, 'approve', { decision: d1 }), as(second).answer(id, 'approve', { decision: d2 })]);
      const wins = rs.filter((r) => r.status === 200);
      assert.equal(wins.length, 1, `exactly one winner, got ${rs.map((r) => r.status)}`);
      const loser = rs.find((r) => r.status !== 200);
      refused(loser, 'already');
      assert.ok(loser.body.winner?.by?.startsWith('client:'), 'already names the winner');
    } },
  { id: 'answer-replay', profile: 'decisions', title: 'replaying an answer nonce, or naming another node\'s aid, gives replay',
    async run({ adapter, as }) {
      const c = as('clientDecide');
      const id = await adapter.requestDecision(plain);
      refused(await c.answer(id, 'approve', { aid: 'othernode1' }), 'replay', 'cross-aid:');
      const id2 = await adapter.requestDecision(plain);
      const d = (await c.decision(id2)).body;
      const { buildAnswer } = await import('../lib/wire.mjs');
      const a = buildAnswer(d, { aid: (await c.hello()).body.aid, verb: 'approve' });
      assert.equal((await c.answerRaw(id2, a)).status, 200);
      const id3 = await adapter.requestDecision(plain);
      const d3 = (await c.decision(id3)).body;
      const a3 = buildAnswer(d3, { aid: a.aid, verb: 'approve', nonce: a.nonce });
      refused(await c.answerRaw(id3, a3), 'replay', 'reused nonce:');
    } },
  { id: 'answer-window', profile: 'decisions', title: 'an answer with exp more than 120 s after iat, or already past, is refused',
    async run({ adapter, as }) {
      const c = as('clientDecide');
      const id = await adapter.requestDecision(plain);
      refused(await c.answer(id, 'approve', { answer: { ttl: 600 } }), 'replay', 'exp-iat > 120:');
      refused(await c.answer(id, 'approve', { answer: { iat: Math.floor(Date.now() / 1000) - 1000 } }), 'replay', 'expired answer:');
    } },
  { id: 'verb-offered', profile: 'decisions', title: 'a verb the decision does not offer gives invalid',
    async run({ adapter, as }) {
      const id = await adapter.requestDecision(plain);
      refused(await as('clientDecide').answer(id, 'nuke'), 'invalid');
    } },
  { id: 'revoked', profile: 'decisions', title: 'a revoked client gives revoked', needs: ['revokeClient'],
    async run({ adapter, as, P }) {
      const id = await adapter.requestDecision(plain);
      await adapter.revokeClient(P.revoked.cid);
      refused(await as('revoked').list('decisions'), 'revoked');
      refused(await as('revoked').answer(id, 'approve', { decision: { id, rev: 1, bind: { hash: 'sha256:' + '0'.repeat(64) }, title: '', summary: '', effect: '', preview: [] } }), 'revoked');
    } },
  { id: 'waits-forever', profile: 'decisions', title: 'with no client, an hour later the decision is unchanged', needs: ['advanceClock'],
    async run({ adapter, as }) {
      const id = await adapter.requestDecision(send);
      const before = (await as('clientDecide').decision(id)).body;
      await adapter.advanceClock(60 * 60 * 1000);
      const after = (await as('clientDecide').decision(id)).body;
      assert.equal(after.state, 'open'); assert.equal(after.rev, before.rev);
      assert.equal(await adapter.executorCalls?.(id) ?? 0, 0);
    } },
  { id: 'expiry-never-approves', profile: 'decisions', title: 'restart past expiry resolves expired/withdrawn and never calls the executor', needs: ['advanceClock', 'restart', 'executorCalls'],
    async run(ctx) {
      const { adapter } = ctx;
      const exp = new Date(Date.now() + 60_000).toISOString();
      const id = await adapter.requestDecision({ ...send, expires: exp, onExpire: 'expire' });
      await adapter.advanceClock(5 * 60_000);
      await ctx.restart();
      const d = (await ctx.as('clientDecide').decision(id)).body;
      assert.equal(d.state, 'resolved'); assert.ok(['expired', 'withdrawn'].includes(d.outcome), `outcome ${d.outcome}`);
      assert.equal(await adapter.executorCalls(id), 0, 'executor never called');
      refused(await ctx.as('clientConfirm').answer(id, 'approve', { decision: d }), d.outcome);
    } },
  { id: 'no-safety-default', profile: 'decisions', title: 'a safety kind cannot be requested with a fallback default',
    async run({ adapter }) {
      await assert.rejects(adapter.requestDecision({ ...send, onExpire: 'fallback', defaultable: 'approve', expires: new Date(Date.now() + 60_000).toISOString() }),
        (e) => e.code === 'invalid', 'requestDecision must refuse with code invalid');
    } },
  { id: 'grant-safety', profile: 'decisions', title: 'a grant over a safety kind is refused; a grant cannot answer a safety decision', needs: ['issueGrant'],
    async run({ adapter, url, aid }) {
      await assert.rejects(adapter.issueGrant({ kinds: ['outbox.send@1'] }), (e) => e.code === 'invalid');
      await assert.rejects(adapter.requestDecision({ kind: 'hitch.grant.issue@1', args: { kinds: ['watch.merge@1'], scope: {}, ttl: 3600, caps: { perHour: 1, perDay: 1 } } }),
        (e) => e.code === 'invalid', 'a hitch.grant.issue@1 naming a safety kind is refused at request');
      const g = connect(url, aid, await adapter.issueGrant({ kinds: ['wins.confirm@1'] }));
      const sid = await adapter.requestDecision(send);
      const d = (await g.decision(sid)).body;
      refused(await g.answer(sid, 'approve', { decision: d }), 'scope');
      const pid = await adapter.requestDecision(plain);
      const r = await g.answer(pid, 'approve', { decision: (await g.decision(pid)).body });
      assert.equal(r.status, 200, 'a grant answers its non-safety kind');
      assert.match(r.body.answered.by, /^grant:/);
    } },
  { id: 'uncertain-never-reruns', profile: 'decisions', title: 'invoked with no done: after the lease the outcome is uncertain, a hitch.retry@1 asks the person, and nothing re-runs on its own', needs: ['advanceClock', 'executorCalls', 'crashNextExecution'],
    async run(ctx) {
      const { adapter, as } = ctx;
      const id = await adapter.requestDecision(send);
      await adapter.crashNextExecution();
      assert.equal((await as('clientConfirm').answer(id, 'approve')).status, 200);
      assert.equal(await adapter.executorCalls(id), 1, 'invoked once');
      await adapter.advanceClock(11 * 60_000);
      const d = (await as('clientDecide').decision(id)).body;
      assert.equal(d.state, 'resolved'); assert.equal(d.outcome, 'uncertain', `outcome ${d.outcome}`);
      assert.ok(d.followUp, 'names its hitch.retry@1 decision');
      await adapter.advanceClock(60 * 60_000);
      await as('clientDecide').list('decisions');
      assert.equal(await adapter.executorCalls(id), 1, 'never re-run automatically');
      const r = (await as('clientDecide').decision(d.followUp)).body;
      ok('hitch.decision@1', r);
      assert.equal(r.kind, 'hitch.retry@1'); assert.equal(r.state, 'open'); assert.equal(r.followUpOf, id);
      assert.equal(r.safety, 'send', 'inherits the original safety, so no grant can answer it');
      assert.equal(r.options.find((o) => o.verb === 'retry').tier, 'confirm', 'retry needs the tier of the option first chosen');
      assert.ok(r.preview.some((x) => x.label === 'Invoked'), 'shows the evidence');
      refused(await as('clientDecide').answer(d.followUp, 'retry'), 'tier', 'decide client:');
      refused(await as('clientConfirm').answer(id, 'approve', { decision: d }), 'already', 'the original is never answered again:');
      const ok2 = await as('clientConfirm').answer(d.followUp, 'retry');
      assert.equal(ok2.status, 200, JSON.stringify(ok2.body));
      assert.equal(await adapter.executorCalls(id), 2, 'retry runs the original once more, only because the person said so');
      assert.equal((await as('clientDecide').decision(id)).body.outcome, 'uncertain', 'the original stays uncertain');
      assert.equal((await as('clientDecide').decision(d.followUp)).body.outcome, 'applied');
    } },
  { id: 'uncertain-leave-it', profile: 'decisions', title: 'declining the retry runs nothing', needs: ['advanceClock', 'executorCalls', 'crashNextExecution'],
    async run(ctx) {
      const { adapter, as } = ctx;
      const id = await adapter.requestDecision(plain);
      await adapter.crashNextExecution();
      assert.equal((await as('clientDecide').answer(id, 'approve')).status, 200);
      await adapter.advanceClock(11 * 60_000);
      const d = (await as('clientDecide').decision(id)).body;
      assert.equal(d.outcome, 'uncertain');
      assert.equal((await as('clientDecide').answer(d.followUp, 'decline')).status, 200);
      assert.equal(await adapter.executorCalls(id), 1);
    } },
  { id: 'reaches-out-is-a-send', profile: 'decisions', title: 'a parley send that leaves the machine is a safety send at confirm, and a grant covers only the local ones', needs: ['issueGrant'],
    async run({ adapter, url, aid, as }) {
      const g = connect(url, aid, await adapter.issueGrant({ kinds: ['parley.send@1'] }));
      const here = await adapter.requestDecision({ kind: 'parley.send@1', args: { to: 's-other', text: { content: 'sha256:' + '0'.repeat(64), bytes: 0 } } });
      const away = await adapter.requestDecision({ kind: 'parley.send@1', args: { to: 'aid:remote1', text: { content: 'sha256:' + '0'.repeat(64), bytes: 0 } }, reachesOut: true });
      const dh = (await g.decision(here)).body, da = (await g.decision(away)).body;
      assert.equal(dh.safety, 'none'); assert.equal(dh.options.find((o) => o.verb === 'approve').tier, 'decide');
      assert.equal(da.safety, 'send', 'reachesOut raises safety to send');
      assert.equal(da.options.find((o) => o.verb === 'approve').tier, 'confirm', 'and the floor to confirm');
      assert.equal((await g.answer(here, 'approve', { decision: dh })).status, 200, 'always-allow still covers a send on this machine');
      refused(await g.answer(away, 'approve', { decision: da }), 'scope', 'a grant on a send that leaves the machine:');
      refused(await as('clientDecide').answer(away, 'approve'), 'tier');
      const quiet = await adapter.requestDecision({ kind: 'parley.send@1', args: { to: 'aid:remote1', text: { content: 'sha256:' + '0'.repeat(64), bytes: 0 } } });
      const dq = (await g.decision(quiet)).body;
      assert.equal(dq.safety, 'send', 'the node derives reaching out from the recipient: a requester that omits the flag cannot lower it');
      refused(await g.answer(quiet, 'approve', { decision: dq }), 'scope', 'grant on an unflagged remote send:');
      const offered = await adapter.requestDecision({ kind: 'parley.send@1', args: { to: 'aid:remote1', text: { content: 'sha256:' + '0'.repeat(64), bytes: 0 } },
        options: [{ verb: 'approve', label: 'Send' }, { verb: 'approveAllow', label: 'Send and always allow', tier: 'local' }, { verb: 'decline' }] });
      assert.ok(!(await g.decision(offered)).body.options.some((o) => o.verb === 'approveAllow'), 'the node strips "always allow" from a send that leaves the machine');
    } },

  // ---- pairing ------------------------------------------------------------------------
  { id: 'pairing-sas', profile: 'pairing', title: 'commit-reveal yields the same 6-digit SAS on both sides and a local hitch.client.pair@1 decision',
    async run(ctx) {
      const r = await pairUpTo(ctx);
      assert.equal(r.reveal.sas, r.expectSas, 'SAS = sasOf({commit, clientNonce, serverNonce, pub, nodeKey})');
      assert.notEqual(r.impostorSas, r.expectSas, 'a client handed another node key computes a different SAS');
      const d = (await ctx.as('clientDecide').decision(r.reveal.decision)).body;
      ok('hitch.decision@1', d);
      assert.equal(d.kind, 'hitch.client.pair@1');
      assert.equal(d.options.find((o) => o.verb === 'approve').tier, 'local');
      assert.equal(d.safety, 'grant');
    } },
  { id: 'pairing-impostor', profile: 'pairing', title: 'an impostor relaying the pairing with its own node key yields a different SAS; the person declines and no credential works',
    async run(ctx) {
      if (!ctx.P.clientLocal) throw new Skip('adapter has no clientLocal');
      const { genKey } = await import('../lib/wire.mjs');
      const fake = genKey('ed25519');
      const proxy = await relay(ctx.url, (path, body) => (path === '/.well-known/hitch' ? { ...body, nodeKey: { ...body.nodeKey, x: fake.pub } } : body));
      try {
        const disc = await (await fetch(proxy.url + '/.well-known/hitch')).json();
        assert.equal(disc.nodeKey.x, fake.pub, 'the relay hands the client its own key');
        const r = await pairUpTo({ ...ctx, url: proxy.url, discovery: disc });
        assert.notEqual(r.reveal.sas, r.expectSas, 'the code the node shows differs from the code the client computed');
        const d = (await ctx.as('clientLocal').decision(r.reveal.decision)).body;
        const shown = d.preview.find((x) => x.label === 'Code')?.value;
        assert.equal(shown, r.reveal.sas, 'the pair decision shows the node-side code in a "Code" row');
        assert.notEqual(shown, r.expectSas);
        const { sasOf } = await import('./sas.mjs');
        assert.equal(shown, sasOf({ commit: r.commit, clientNonce: r.nonce, serverNonce: r.start.serverNonce, pub: r.key.pub, nodeKey: ctx.discovery.nodeKey.x }),
          'the node computes its code over its own real key');
        // the person compares the codes, sees a mismatch, and declines
        assert.equal((await ctx.as('clientLocal').answer(r.reveal.decision, 'decline')).status, 200);
        const st = await fetch(ctx.url + `/hitch/v1/clients/pairings/${r.start.pairing}`).then((x) => x.json());
        assert.equal(st.state, 'declined');
        assert.equal(st.client, undefined, 'no client id for a declined pairing');
        refused(await connect(ctx.url, ctx.aid, { cid: 'c_none', key: r.key }).hello(), 'unauthenticated');
      } finally { await proxy.close(); }
    } },
  { id: 'pairing-commit', profile: 'pairing', title: 'a reveal that does not match the commit is refused',
    async run(ctx) {
      const r = await pairUpTo(ctx, { reveal: false });
      const x = await fetch(ctx.url + `/hitch/v1/clients/pairings/${r.start.pairing}/reveal`, { method: 'POST', body: JSON.stringify({ nonce: 'AAAAAAAAAAAAAAAAAAAAAA' }) });
      refused({ status: x.status, body: await x.json() }, 'invalid');
    } },
  { id: 'agent-bootstrap', profile: 'pairing', title: 'an agent cannot approve its own pairing: mod, confirm client and presence-less local client all refused',
    async run(ctx) {
      const r = await pairUpTo(ctx);
      const id = r.reveal.decision;
      const d = (await ctx.as('clientDecide').decision(id)).body;
      refused(await ctx.as('mod').answer(id, 'approve', { decision: d }), 'not_a_client', 'mod:');
      refused(await ctx.as('clientConfirm').answer(id, 'approve', { decision: d }), 'tier', 'confirm client:');
      if (ctx.P.clientLocal) refused(await ctx.as('clientLocal').answer(id, 'approve', { decision: d, noPresence: true }), 'step_up_required', 'local, no presence:');
      const st = await fetch(ctx.url + `/hitch/v1/clients/pairings/${r.start.pairing}`).then((x) => x.json());
      assert.notEqual(st.state, 'paired');
      refused(await connect(ctx.url, ctx.aid, { cid: 'c_unpaired', key: r.key }).list('decisions'), 'unauthenticated', 'unpaired key:');
    } },
  { id: 'pairing-approve', profile: 'pairing', title: 'a local client with presence approves; the new client can then say hello',
    async run(ctx) {
      if (!ctx.P.clientLocal) throw new Skip('adapter has no clientLocal');
      const r = await pairUpTo(ctx);
      const a = await ctx.as('clientLocal').answer(r.reveal.decision, 'approve');
      assert.equal(a.status, 200, JSON.stringify(a.body));
      const st = await waitPaired(ctx, r.start.pairing);
      const h = await connect(ctx.url, ctx.aid, { cid: st.client, key: r.key }).hello();
      assert.equal(h.status, 200);
      assert.equal(h.body.principal, `client:${st.client}`);
      assert.equal(h.body.ceiling, 'decide', 'every client after the first starts at decide');
    } },
  { id: 'pairing-hmac-seal', profile: 'pairing', title: 'an hmac pairing delivers its secret sealed to the client X25519 key, until the first signed request; it opens to a working decide-capped credential',
    async run(ctx) {
      if (!ctx.P.clientLocal) throw new Skip('adapter has no clientLocal');
      const w = await import('../lib/wire.mjs');
      const r = await pairUpTo(ctx, { suite: 'hmac-sha256' });
      assert.equal((await ctx.as('clientLocal').answer(r.reveal.decision, 'approve')).status, 200);
      const st = await waitPaired(ctx, r.start.pairing);
      assert.ok(st.sealed, 'status carries sealed once paired');
      assert.equal(st.sealed.alg, 'x25519-hkdf-sha256-hmac/1');
      const bind = { commit: r.commit, serverNonce: r.start.serverNonce, pairing: r.start.pairing, client: st.client, aid: ctx.aid };
      assert.throws(() => w.openSeal({ privateKey: r.key.privateKey, sealed: { ...st.sealed, tag: st.sealed.tag.slice(0, -4) + 'AAAA' }, ...bind }), /bad tag/, 'tag checked');
      assert.throws(() => w.openSeal({ privateKey: r.key.privateKey, sealed: st.sealed, ...bind, pairing: 'pr_other' }), /bad tag/, 'bound to this pairing');
      const secret = w.openSeal({ privateKey: r.key.privateKey, sealed: st.sealed, ...bind });
      assert.equal(secret.length, 32);
      const again = await fetch(ctx.url + `/hitch/v1/clients/pairings/${r.start.pairing}`).then((x) => x.json());
      assert.ok(again.sealed, 'still delivered before the first signed request');
      const h = await connect(ctx.url, ctx.aid, { cid: st.client, key: { suite: 'hmac-sha256', secret } }).hello();
      assert.equal(h.status, 200, JSON.stringify(h.body)); assert.equal(h.body.ceiling, 'decide');
      const after = await fetch(ctx.url + `/hitch/v1/clients/pairings/${r.start.pairing}`).then((x) => x.json());
      assert.equal(after.sealed, undefined, 'no longer delivered once the client has used it');
    } },
  { id: 'pairing-presence', profile: 'pairing', title: 'presence keys sent at pairing are shown, recorded, and reach confirm once a local answer raises the ceiling',
    async run(ctx) {
      if (!ctx.P.clientLocal) throw new Skip('adapter has no clientLocal');
      const { genKey } = await import('../lib/wire.mjs');
      const pk = genKey('p256');
      const r = await pairUpTo(ctx, { presence: [{ kid: 'pk-new', suite: 'p256', pub: pk.pub }] });
      const pd = (await ctx.as('clientLocal').decision(r.reveal.decision)).body;
      assert.ok(pd.preview.some((x) => (x.value ?? '').includes('pk-new')), 'the pair decision shows the presence key to the approver');
      assert.equal((await ctx.as('clientLocal').answer(r.reveal.decision, 'approve')).status, 200);
      const st = await waitPaired(ctx, r.start.pairing);
      const me = { cid: st.client, key: r.key, presence: { kid: 'pk-new', key: pk } };
      const listed = (await ctx.as('clientDecide').list('clients')).body.list.find((c) => c.id === st.client);
      assert.deepEqual(listed?.presence?.map((x) => x.kid), ['pk-new'], 'presence key recorded on the client');
      const sid = await ctx.adapter.requestDecision(send);
      refused(await connect(ctx.url, ctx.aid, me).answer(sid, 'approve'), 'tier', 'decide ceiling before the raise:');
      const up = await ctx.adapter.requestDecision({ kind: 'hitch.client.scope@1', args: { client: st.client, ceiling: 'confirm' } });
      refused(await ctx.as('clientConfirm').answer(up, 'approve'), 'tier', 'a scope raise is local:');
      assert.equal((await ctx.as('clientLocal').answer(up, 'approve')).status, 200);
      const r2 = await connect(ctx.url, ctx.aid, me).answer(sid, 'approve');
      assert.equal(r2.status, 200, `the raised client answers confirm with its paired presence key: ${JSON.stringify(r2.body)}`);
    } },

  // ---- revoke (pairing profile: the client lifecycle) ------------------------------------
  { id: 'revoke-self', profile: 'pairing', title: 'a client may revoke itself with no presence; it is then refused as revoked', needs: ['mintClient'],
    async run(ctx) {
      const c = await ctx.adapter.mintClient({ ceiling: 'decide' });
      const api = connect(ctx.url, ctx.aid, c);
      const r = await revoke(api, c.cid, c, { presence: false });
      assert.equal(r.status, 200, JSON.stringify(r.body)); ok('hitch.client@1', r.body);
      assert.equal(r.body.state, 'revoked');
      refused(await api.hello(), 'revoked');
    } },
  { id: 'revoke-other', profile: 'pairing', title: 'revoking another client needs confirm + presence: decide gets tier, no presence gets step_up_required', needs: ['mintClient'],
    async run(ctx) {
      const a = await ctx.adapter.mintClient({ ceiling: 'decide' });
      const b = await ctx.adapter.mintClient({ ceiling: 'decide' });
      refused(await revoke(connect(ctx.url, ctx.aid, a), b.cid, a, { presence: false }), 'tier', 'a decide client (an agent with a request key):');
      refused(await revoke(ctx.as('mod'), b.cid, {}), 'not_a_client', 'mod:');
      refused(await revoke(ctx.as('clientConfirm'), b.cid, ctx.P.clientConfirm, { presence: false }), 'step_up_required');
      const r = await revoke(ctx.as('clientConfirm'), b.cid, ctx.P.clientConfirm);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      refused(await connect(ctx.url, ctx.aid, b).hello(), 'revoked');
      refused(await revoke(ctx.as('clientConfirm'), b.cid, ctx.P.clientConfirm), 'gone', 'already revoked:');
      const replay = (await import('../lib/wire.mjs')).commandBody({ presenceKey: ctx.P.clientConfirm.presence.key, presenceKid: ctx.P.clientConfirm.presence.kid, ttl: 600 });
      const c = await ctx.adapter.mintClient({ ceiling: 'decide' });
      refused(await ctx.as('clientConfirm').post(`/hitch/v1/clients/${c.cid}/revoke`, replay), 'replay', 'exp - iat > 120:');
    } },
  { id: 'revoke-all', profile: 'pairing', last: true, title: 'revoke-all needs local + presence and revokes every client, the caller too', needs: ['mintClient'],
    async run(ctx) {
      if (!ctx.P.clientLocal) throw new Skip('adapter has no clientLocal');
      refused(await revoke(ctx.as('clientConfirm'), null, ctx.P.clientConfirm), 'tier', 'confirm client:');
      refused(await revoke(ctx.as('clientLocal'), null, ctx.P.clientLocal, { presence: false }), 'step_up_required');
      const r = await revoke(ctx.as('clientLocal'), null, ctx.P.clientLocal);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      refused(await ctx.as('clientDecide').hello(), 'revoked');
      refused(await ctx.as('clientLocal').hello(), 'revoked');
    } },

  // ---- feeds ---------------------------------------------------------------------------------
  { id: 'feed-read', profile: 'feeds', title: 'a feed is a signed, schema-valid read model whose data matches its type', needs: ['setFeed'],
    async run(ctx) {
      await ctx.adapter.setFeed('kernel.connectors@1', { connectors: [{ id: 'm365', name: 'Microsoft 365', state: 'signed-in', account: 'me' }] });
      const r = await ctx.as('clientDecide').get('/hitch/v1/feeds/kernel.connectors@1');
      assert.equal(r.status, 200, JSON.stringify(r.body)); ok('hitch.feed', r.body);
      assert.ok(ctx.verify(r.body), 'feed signature');
      ok('kernel.connectors@1', r.body.data);
      assert.equal(r.body.feed, 'kernel.connectors@1');
    } },
  { id: 'feed-changed', profile: 'feeds', title: 'a feed change emits hitch.changed@1 {resource:"feeds", id, rev}, and GET shows that rev', needs: ['setFeed'],
    async run(ctx) {
      const c = ctx.as('clientDecide');
      await ctx.adapter.setFeed('kernel.connectors@1', { connectors: [] });
      const before = (await c.get('/hitch/v1/feeds/kernel.connectors@1')).body.rev;
      const start = (await c.list('decisions')).body.cursor;
      await ctx.adapter.setFeed('kernel.connectors@1', { connectors: [{ id: 'gh', name: 'GitHub', state: 'expired' }] });
      const ev = (await c.poll(start)).body.events.find((e) => e.type === 'hitch.changed@1' && e.data.resource === 'feeds' && e.data.id === 'kernel.connectors@1');
      assert.ok(ev, 'change notice for the feed');
      assert.equal(ev.data.rev, before + 1);
      assert.equal((await c.get('/hitch/v1/feeds/kernel.connectors@1')).body.rev, before + 1);
    } },
  { id: 'feed-guards', profile: 'feeds', title: 'an unknown feed gives gone; a client below the feed privacy class gives privacy', needs: ['setFeed', 'mintClient'],
    async run(ctx) {
      refused(await ctx.as('clientDecide').get('/hitch/v1/feeds/acme.nothing@1'), 'gone');
      await ctx.adapter.setFeed('wins.weekly@1', { week: '2026-11-16', wins: [] });
      const low = await ctx.adapter.mintClient({ ceiling: 'decide', privacy: 'meta' });
      refused(await connect(ctx.url, ctx.aid, low).get('/hitch/v1/feeds/wins.weekly@1'), 'privacy', 'meta client, text feed:');
      refused(await connect(ctx.url, ctx.aid, null).get('/hitch/v1/feeds/kernel.connectors@1'), 'unauthenticated');
    } },

  // ---- messaging -----------------------------------------------------------------------------
  { id: 'message-post', profile: 'messaging', title: 'a person-client posts a message to a session: from is stamped, it is listed, and the session receives message.received@1',
    async run(ctx) {
      const c = ctx.as('clientDecide');
      const start = (await c.list('messages')).body.cursor;
      const r = await c.post('/hitch/v1/messages', { to: { session: ctx.P.session.sid }, intent: 'task', text: 'Please rebase on main', from: { aid: 'evil01', principal: 'node' } });
      assert.equal(r.status, 200, JSON.stringify(r.body)); ok('hitch.message@1', r.body);
      assert.match(r.body.from.principal, /^client:/, 'from stamped from the credential');
      assert.equal(r.body.state, 'queued');
      assert.ok((await c.list('messages')).body.list.some((m) => m.id === r.body.id), 'listed');
      const ev = (await ctx.as('session').poll(start)).body.events.find((e) => e.type === 'message.received@1' && e.data.message === r.body.id);
      assert.ok(ev, 'the addressed session sees message.received@1');
      assert.deepEqual(V.validateEnvelope(ev), []);
      assert.equal(ev.data.text, 'Please rebase on main');
      assert.equal(ev.to.session, ctx.P.session.sid);
    } },
  { id: 'message-idem', profile: 'messaging', title: 'posting twice with the same idem gives the same message, not a duplicate',
    async run(ctx) {
      const c = ctx.as('clientDecide');
      const body = { to: { session: ctx.P.session.sid }, text: 'once', idem: 'hitch-check:' + Date.now() };
      const a = await c.post('/hitch/v1/messages', body), b = await c.post('/hitch/v1/messages', body);
      assert.equal(a.status, 200); assert.equal(b.body.id, a.body.id);
      assert.equal((await c.list('messages')).body.list.filter((m) => m.idem === body.idem).length, 1);
    } },
  { id: 'message-person-only', profile: 'messaging', title: 'mods and sessions cannot post person-authored messages',
    async run(ctx) {
      for (const who of ['mod', 'session']) refused(await ctx.as(who).post('/hitch/v1/messages', { to: { session: ctx.P.session.sid }, text: 'x' }), 'not_a_client', `${who}:`);
    } },
  { id: 'message-session-scope', profile: 'messaging', title: 'another session neither lists nor receives a message to someone else',
    async run(ctx) {
      if (!ctx.P.session2) throw new Skip('adapter has no session2 principal');
      const start = (await ctx.as('clientDecide').list('messages')).body.cursor;
      const r = await ctx.as('clientDecide').post('/hitch/v1/messages', { to: { session: ctx.P.session.sid }, text: 'for s-test only' });
      const other = ctx.as('session2');
      assert.ok(!(await other.list('messages')).body.list.some((m) => m.id === r.body.id), 'not listed for another session');
      const evs = (await other.poll(start)).body.events;
      assert.ok(!evs.some((e) => e.data?.message === r.body.id && e.type === 'message.received@1'), 'not streamed to another session');
      assert.ok(!JSON.stringify(evs).includes('for s-test only'), 'text never reaches another session');
    } },
  { id: 'message-delivery', profile: 'messaging', title: 'only the addressee moves delivery forward; the person sees message.delivery@1',
    async run(ctx) {
      const c = ctx.as('clientDecide');
      const m = (await c.post('/hitch/v1/messages', { to: { session: ctx.P.session.sid }, text: 'ack me' })).body;
      const start = (await c.list('messages')).body.cursor;
      refused(await c.post(`/hitch/v1/messages/${m.id}/state`, { state: 'acked' }), 'scope', 'a client:');
      if (ctx.P.session2) refused(await ctx.as('session2').post(`/hitch/v1/messages/${m.id}/state`, { state: 'acked' }), 'scope', 'another session:');
      const s = ctx.as('session');
      assert.equal((await s.post(`/hitch/v1/messages/${m.id}/state`, { state: 'seen' })).status, 200);
      refused(await s.post(`/hitch/v1/messages/${m.id}/state`, { state: 'sent' }), 'invalid', 'backwards:');
      const r = await s.post(`/hitch/v1/messages/${m.id}/state`, { state: 'acked' });
      assert.equal(r.body.state, 'acked');
      const evs = (await c.poll(start)).body.events.filter((e) => e.type === 'message.delivery@1' && e.data.message === m.id);
      assert.deepEqual(evs.map((e) => e.data.state), ['seen', 'acked']);
      assert.equal((await c.list('messages')).body.list.find((x) => x.id === m.id).state, 'acked');
    } },
  { id: 'message-privacy', profile: 'messaging', title: 'a client below the text class sees messages and events with the text withheld', needs: ['mintClient'],
    async run(ctx) {
      const low = connect(ctx.url, ctx.aid, await ctx.adapter.mintClient({ ceiling: 'decide', privacy: 'meta' }));
      const start = (await low.list('messages')).body.cursor;
      const m = (await ctx.as('clientDecide').post('/hitch/v1/messages', { to: { session: ctx.P.session.sid }, text: 'PRIVATE TEXT' })).body;
      const l = (await low.list('messages')).body.list.find((x) => x.id === m.id);
      assert.ok(l, 'listed'); assert.equal(l.text, undefined); assert.equal(l.withheld, true);
      const evs = (await low.poll(start)).body.events;
      assert.ok(!JSON.stringify(evs).includes('PRIVATE TEXT'), 'no text in the stream');
      const ev = evs.find((e) => e.type === 'message.received@1');
      assert.deepEqual(ev?.data, { withheld: true });
      assert.ok(ctx.verify(ev), 'redacted events are re-signed');
    } },

  // ---- tasks (items with verbs) --------------------------------------------------------------
  { id: 'item-verbs', profile: 'tasks', title: 'a client uses an offered item verb (no presence); the item changes state and a change notice follows', needs: ['putItem'],
    async run(ctx) {
      const c = ctx.as('clientDecide');
      const id = await ctx.adapter.putItem({ kind: 'kernel.inbox@1', owner: 'tasks', title: 'Chase Dana for the Q4 numbers', offers: [{ verb: 'done', label: 'Mark it done' }, { verb: 'snooze', label: 'Tomorrow' }], data: { v2kind: 'todo', v2id: 'tasks:12' } });
      const l = (await c.list('items')).body;
      const it = l.list.find((x) => x.id === id);
      ok('hitch.item@1', it); assert.equal(it.state, 'open');
      const until = new Date(Date.now() + 86400e3).toISOString();
      const s1 = await c.post(`/hitch/v1/items/${id}/state`, { verb: 'snooze', until });
      assert.equal(s1.status, 200, JSON.stringify(s1.body)); assert.equal(s1.body.state, 'snoozed'); assert.equal(s1.body.until, until);
      assert.ok(ctx.verify(s1.body), 'node-signed');
      const ev = (await c.poll(l.cursor)).body.events.find((e) => e.type === 'hitch.changed@1' && e.data.resource === 'items' && e.data.id === id);
      assert.ok(ev, 'the owner mod learns of it from hitch.changed@1');
      assert.equal((await c.post(`/hitch/v1/items/${id}/state`, { verb: 'done' })).body.state, 'done');
    } },
  { id: 'item-verbs-guarded', profile: 'tasks', title: 'item verbs: only person-clients, only offered verbs; snooze needs until', needs: ['putItem'],
    async run(ctx) {
      const id = await ctx.adapter.putItem({ title: 'A review asked of you', offers: [{ verb: 'dismiss', label: 'Got it' }] });
      for (const who of ['mod', 'session']) refused(await ctx.as(who).post(`/hitch/v1/items/${id}/state`, { verb: 'dismiss' }), 'not_a_client', `${who}:`);
      refused(await ctx.as('clientDecide').post(`/hitch/v1/items/${id}/state`, { verb: 'done' }), 'invalid', 'not offered:');
      const id2 = await ctx.adapter.putItem({ offers: [{ verb: 'snooze' }] });
      refused(await ctx.as('clientDecide').post(`/hitch/v1/items/${id2}/state`, { verb: 'snooze' }), 'invalid', 'snooze without until:');
      assert.equal((await ctx.as('clientDecide').post(`/hitch/v1/items/${id}/state`, { verb: 'dismiss' })).body.state, 'dismissed');
    } },
];

// A relaying impostor: forwards every request to the real node, rewriting JSON responses.
async function relay(target, rewrite) {
  const http = await import('node:http');
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
    const up = await fetch(target + req.url, { method: req.method, headers, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) });
    let text = await up.text();
    try { text = JSON.stringify(rewrite(new URL(req.url, 'http://x').pathname, JSON.parse(text))); } catch {}
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
    res.end(text);
  });
  await new Promise((ok2) => server.listen(0, '127.0.0.1', ok2));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok2) => { server.closeAllConnections(); server.close(ok2); }) };
}

const revoke = async (api, cid, cred, { presence = true } = {}) => {
  const { commandBody } = await import('../lib/wire.mjs');
  const p = presence ? cred.presence : undefined;
  return api.post(cid ? `/hitch/v1/clients/${cid}/revoke` : '/hitch/v1/clients/revoke-all', commandBody({ presenceKey: p?.key, presenceKid: p?.kid }));
};

async function waitPaired(ctx, pairing) {
  let st;
  for (let i = 0; i < 20; i++) {
    st = await fetch(ctx.url + `/hitch/v1/clients/pairings/${pairing}`).then((x) => x.json());
    if (st.state === 'paired') break;
    await new Promise((ok2) => setTimeout(ok2, 100));
  }
  assert.equal(st.state, 'paired');
  return st;
}

async function pairUpTo(ctx, { reveal = true, presence, suite = 'ed25519' } = {}) {
  const { genKey, genX25519, hashOf, b64u } = await import('../lib/wire.mjs');
  const { sasOf } = await import('./sas.mjs');
  const key = suite === 'hmac-sha256' ? genX25519() : genKey(suite);
  const nonce = b64u((await import('node:crypto')).randomBytes(16));
  const commit = hashOf({ pub: key.pub, nonce });
  const s = await fetch(ctx.url + '/hitch/v1/clients/pairings', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'hitch-check', suite, pub: key.pub, commit, ...(presence ? { presence } : {}) }) });
  assert.equal(s.status, 202);
  const start = await s.json();
  if (!reveal) return { start, key };
  const rv = await fetch(ctx.url + `/hitch/v1/clients/pairings/${start.pairing}/reveal`, { method: 'POST', body: JSON.stringify({ nonce }) });
  assert.equal(rv.status, 200);
  return { start, key, commit, nonce, reveal: await rv.json(), expectSas: sasOf({ commit, clientNonce: nonce, serverNonce: start.serverNonce, pub: key.pub, nodeKey: ctx.discovery.nodeKey.x }),
    impostorSas: sasOf({ commit, clientNonce: nonce, serverNonce: start.serverNonce, pub: key.pub, nodeKey: (await import('../lib/wire.mjs')).genKey('ed25519').pub }) };
}

export class Skip extends Error {}

// ---- runner --------------------------------------------------------------------------
export async function runChecks(adapter, { only, log = console.log } = {}) {
  let env = await adapter.setup();
  const ctx = { adapter };
  async function bind() {
    const disc = await (await fetch(env.url + '/.well-known/hitch')).json();
    ctx.url = env.url; ctx.aid = disc.aid; ctx.discovery = disc;
    ctx.P = await adapter.principals();
    ctx.verify = verifiedBy(disc.nodeKey);
    ctx.as = (who) => { if (!ctx.P[who]) throw new Skip(`adapter has no ${who} principal`); return connect(ctx.url, ctx.aid, ctx.P[who]); };
  }
  ctx.restart = async () => { env = (await adapter.restart()) ?? env; await bind(); };
  await bind();
  const results = [];
  for (const c of [...CHECKS.filter((x) => !x.last), ...CHECKS.filter((x) => x.last)]) {
    if (only && !only.includes(c.id) && !only.includes(c.profile)) continue;
    const missing = (c.needs ?? []).filter((n) => typeof adapter[n] !== 'function');
    if (missing.length) { results.push({ ...c, status: 'skip', why: `adapter lacks ${missing.join(', ')}` }); log(`- ${c.id}: skipped (adapter lacks ${missing.join(', ')})`); continue; }
    try {
      await adapter.beforeEach?.();
      await c.run(ctx);
      results.push({ ...c, status: 'pass' }); log(`✓ ${c.id}: ${c.title}`);
    } catch (e) {
      if (e instanceof Skip) { results.push({ ...c, status: 'skip', why: e.message }); log(`- ${c.id}: skipped (${e.message})`); continue; }
      results.push({ ...c, status: 'fail', error: e }); log(`✗ ${c.id}: ${c.title}\n    ${String(e.message).split('\n')[0]}`);
    }
  }
  await adapter.teardown?.();
  const profiles = {};
  for (const r of results) {
    const p = (profiles[r.profile] ??= { pass: 0, fail: 0, skip: 0 });
    p[r.status]++;
  }
  const claimable = Object.entries(profiles).filter(([, v]) => v.fail === 0 && v.skip === 0).map(([k]) => k);
  const claimed = ctx.discovery.profiles;
  const overclaimed = claimed.filter((p) => profiles[p] && !claimable.includes(p));
  return { results, profiles, claimable, overclaimed };
}
