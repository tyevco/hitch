// The server suite tests itself: clean toy passes every check; each planted
// bug makes exactly the checks that guard it fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChecks } from '../conformance/server/checks.mjs';
import { toyAdapter } from '../conformance/example/toy-adapter.mjs';

const quiet = { log: () => {} };

test('clean toy node passes every check and may claim core, decisions, pairing', async () => {
  const r = await runChecks(toyAdapter(), quiet);
  const bad = r.results.filter((x) => x.status !== 'pass').map((x) => `${x.id}: ${x.status} ${x.error?.message ?? x.why ?? ''}`);
  assert.deepEqual(bad, []);
  assert.deepEqual(r.claimable.sort(), ['core', 'decisions', 'feeds', 'messaging', 'pairing']);
  assert.deepEqual(r.overclaimed, []);
});

const PLANTED = {
  skipPresence: ['step-up', 'local-step-up', 'agent-bootstrap'],
  skipShown: ['stale'],
  trustBodyFrom: ['from-stamped'],
  modAnswers: ['not-a-client', 'agent-bootstrap'],
  expiryApproves: ['expiry-never-approves'],
  ignoreCeiling: ['tier', 'suite'],
  noNonceCheck: ['answer-replay'],
  revokeOthersFree: ['revoke-other'],
  noEventFilter: ['message-session-scope', 'message-privacy'],
  anyoneAcks: ['message-delivery'],
  sasNoNodeKey: ['pairing-sas', 'pairing-impostor'],
};
for (const [bug, ids] of Object.entries(PLANTED)) {
  test(`planted bug ${bug} is caught by ${ids.join(', ')}`, async () => {
    const r = await runChecks(toyAdapter({ bugs: { [bug]: true } }), { ...quiet, only: ids });
    for (const id of ids) assert.equal(r.results.find((x) => x.id === id)?.status, 'fail', `${id} should fail under ${bug}`);
    assert.ok(r.overclaimed.length > 0, 'a failing node may not claim the profile');
  });
}
