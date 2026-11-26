// The client suite: runs a client (through its adapter) against hitch-mock and
// checks what it shows and what it sends. See conformance/README.md
// "Client adapter" for the interface.
import assert from 'node:assert/strict';
import { startMock } from './hitch-mock.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = { kind: 'wins.confirm@1', args: { win: 'w1', title: 'Shipped hitch-check' }, title: 'Log win: shipped hitch-check', summary: 'From the Friday sweep' };
const sendKind = { kind: 'outbox.send@1', args: { channel: 'teams', to: 'Alice', body: { content: 'sha256:' + '0'.repeat(64), bytes: 0 }, send: { body: { content: 'sha256:' + '0'.repeat(64), bytes: 0 }, path: '/chats/19:x/messages' } }, title: 'Send reply to Alice', summary: 'Re: Q4 plan' };

export const CLIENT_CHECKS = [
  { id: 'generic-unknown-kind', title: 'an unknown vendor kind renders generically: title, effect, preview and options all visible',
    async run({ mock, client }) {
      const id = mock.request({ kind: 'acme.widget@1', args: { colour: 'teal' }, title: 'Paint the widget', summary: 'acme wants this',
        options: [{ verb: 'approve', label: 'Paint', tier: 'decide' }, { verb: 'decline', label: 'No' }] });
      mock.node.store.decisions.get(id).d.options.forEach((o) => { if (o.verb === 'approve') o.tier = 'decide'; });
      await client.sync();
      const v = await client.view(id);
      assert.ok(v?.shown, 'shown');
      assert.equal(v.generic, true, 'rendered with the generic renderer');
      for (const s of ['Paint the widget', 'acme.widget@1 with 1 bound argument(s)', 'colour', 'teal']) assert.ok(v.text.includes(s), `shows "${s}"`);
      assert.deepEqual(v.options.map((o) => o.verb).sort(), ['approve', 'decline']);
    } },
  { id: 'never-auto-answers', title: 'syncing and viewing decisions never sends an answer',
    async run({ mock, client }) {
      const ids = [mock.request(plain), mock.request(sendKind), mock.request({ kind: 'hitch.question@1', args: { question: 'Which?', choices: ['a', 'b'] }, defaultable: 'a', onExpire: 'fallback', expires: new Date(Date.now() + 3600e3).toISOString() })];
      await client.sync();
      for (const id of ids) await client.view(id);
      await pause(300);
      await client.sync();
      assert.equal(mock.requests('POST', /\/answers$/).length, 0, 'no answers sent without a press');
    } },
  { id: 'hides-above-ceiling', title: 'options above the client ceiling are not offered; narrow decline is',
    async run({ mock, client }) {
      const id = mock.request(sendKind);
      await client.sync();
      const v = await client.view(id);
      const ap = v.options.find((o) => o.verb === 'approve');
      assert.ok(!ap || ap.enabled === false, 'approve (confirm) is hidden or disabled for a decide client');
      assert.equal(v.options.find((o) => o.verb === 'decline')?.enabled, true, 'decline stays available');
    } },
  { id: 'verifies-signature', title: 'a decision body that fails the node signature is not shown as real',
    async run({ mock, client }) {
      const a = mock.request(plain), b = mock.request(plain);
      mock.forgeTitle(a); mock.resign(b);
      await client.sync();
      for (const id of [a, b]) {
        const v = await client.view(id);
        assert.ok(!v?.shown || v.rejected, `${id === a ? 'altered' : 'wrong-key'} body must be rejected`);
        if (v?.text) assert.ok(!v.text.includes('Something harmless'), 'forged text not shown');
      }
      const pressed = await client.answer(a, 'approve').catch(() => ({ ok: false }));
      assert.ok(!pressed.ok, 'a client cannot answer what it rejected');
    } },
  { id: 'answer-accepted', title: 'pressing an allowed option sends one answer the node accepts (shownHash and request signature correct)',
    async run({ mock, client }) {
      const id = mock.request(plain);
      await client.sync(); await client.view(id);
      const r = await client.answer(id, 'approve');
      assert.equal(r.ok, true, `answer refused: ${r.code}`);
      assert.equal(mock.requests('POST', /\/answers$/).length, 1);
      assert.equal(mock.node.store.decisions.get(id).d.state, 'answered');
    } },
  { id: 'refetch-on-stale', title: 'on stale the client re-fetches and shows the new content; it never retries the answer itself',
    async run({ mock, client }) {
      const id = mock.request(plain);
      await client.sync(); await client.view(id);
      mock.edit(id);
      mock.clearLog();
      const r = await client.answer(id, 'approve');
      assert.equal(r.ok, false); assert.equal(r.code, 'stale');
      await pause(100);
      assert.equal(mock.requests('POST', /\/answers$/).length, 1, 'exactly one POST: no silent retry');
      const after = mock.log.findIndex((x) => x.method === 'POST');
      assert.ok(mock.log.slice(after + 1).some((x) => x.method === 'GET' && (x.path.endsWith(id) || x.path.endsWith('/decisions'))), 'GET after stale');
      const v = await client.view(id);
      assert.ok(v.text.includes('edited'), 'shows the edited preview');
    } },
  { id: 'already-shows-winner', title: 'losing the race shows "answered on <device>", not an error or a success',
    async run({ mock, client }) {
      const id = mock.request(plain);
      await client.sync(); await client.view(id);
      mock.answerFromOtherDevice(id);
      const r = await client.answer(id, 'approve');
      assert.equal(r.ok, false); assert.equal(r.code, 'already');
      const v = await client.view(id);
      assert.equal(v.status, 'answered-elsewhere');
      assert.ok(v.text.includes('other-phone'), 'names the winning device');
    } },
  { id: 'resolved-elsewhere', title: 'a decision resolved in a vendor client shows where, not withdrawn',
    async run({ mock, client }) {
      const id = mock.request(plain);
      mock.resolveElsewhere(id, 'herdr');
      await client.sync();
      const v = await client.view(id);
      assert.equal(v.status, 'answered-elsewhere');
      assert.ok(v.text.includes('herdr'));
    } },
  { id: 'waiting-for-executor', title: 'an answered decision whose action is still queued shows "waiting for executor", not done',
    async run({ mock, client }) {
      const id = mock.request(plain);
      await client.sync(); await client.view(id);
      assert.equal((await client.answer(id, 'approve')).ok, true);
      await client.sync();
      assert.equal((await client.view(id)).status, 'waiting-executor');
      mock.runExecutor(id);
      await client.sync();
      assert.equal((await client.view(id)).status, 'applied');
    } },
  { id: 'withheld', title: 'a withheld preview row shows as withheld and its content is never fetched',
    async run({ mock, client }) {
      const c = mock.putContent('TOP SECRET BODY', 'text/plain', 'secret');
      const id = mock.request({ ...plain, preview: [{ label: 'To', value: 'alice@example.com' }, { label: 'Body', withheld: true, digest: c.hash, bytes: c.bytes }] });
      await client.sync();
      const v = await client.view(id);
      assert.ok(v.text.includes('Body'), 'the row label is shown');
      assert.ok(!v.text.includes('TOP SECRET'), 'withheld text is not shown');
      assert.equal(mock.requests('GET', /\/content\//).length, 0, 'withheld content is not fetched');
    } },
  { id: 'push-relists', title: 'a push wake leads to a re-list',
    async run({ mock, client }) {
      if (typeof client.push !== 'function') throw new Skip('client has no push');
      await client.sync();
      mock.clearLog();
      mock.request(plain);
      await client.push({ head: mock.node.store.seq, counts: { decisions: 1 }, kinds: ['wins.confirm@1'] });
      assert.ok(mock.requests('GET', /^\/hitch\/v1\/decisions$/).length >= 1, 'GET /hitch/v1/decisions after the wake');
    } },
  { id: 'kind-input', title: 'an option needing kind-specific input is shown as "open in another client", not answered generically',
    async run({ mock, client }) {
      const id = mock.request({ kind: 'acme.widget@1', args: {}, options: [{ verb: 'configure', label: 'Configure', tier: 'decide', kindInput: true }, { verb: 'decline' }] });
      mock.node.store.decisions.get(id).d.options[0].tier = 'decide';
      await client.sync();
      const v = await client.view(id);
      const o = v.options.find((x) => x.verb === 'configure');
      assert.ok(!o || o.enabled === false || o.openElsewhere === true, 'not a plain button');
    } },
];

export class Skip extends Error {}

// factory(env) -> client adapter. env = {url, aid, nodeKey, credentials}.
export async function runClientChecks(factory, { only, log = console.log, mockOptions = {} } = {}) {
  const results = [];
  for (const c of CLIENT_CHECKS) {
    if (only && !only.includes(c.id)) continue;
    const mock = await startMock(mockOptions);
    let client;
    try {
      client = await factory({ url: mock.url, aid: mock.aid, nodeKey: mock.nodeKey, credentials: mock.credentials });
      await c.run({ mock, client });
      results.push({ id: c.id, status: 'pass' }); log(`✓ ${c.id}: ${c.title}`);
    } catch (e) {
      if (e instanceof Skip) { results.push({ id: c.id, status: 'skip', why: e.message }); log(`- ${c.id}: skipped (${e.message})`); }
      else { results.push({ id: c.id, status: 'fail', error: e }); log(`✗ ${c.id}: ${c.title}\n    ${String(e.message).split('\n')[0]}`); }
    } finally {
      await client?.close?.();
      await mock.close();
    }
  }
  return results;
}
