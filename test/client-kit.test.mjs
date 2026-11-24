// The client suite tests itself: the naive client passes every check; each
// planted client bug is caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClientChecks } from '../conformance/client/checks.mjs';
import { naiveClient } from '../conformance/example/naive-client.mjs';

const quiet = { log: () => {} };

test('naive client passes every client check', async () => {
  const r = await runClientChecks((env) => naiveClient(env), quiet);
  assert.deepEqual(r.filter((x) => x.status !== 'pass').map((x) => `${x.id}: ${x.error?.message ?? x.why}`), []);
});

const PLANTED = {
  autoAnswer: ['never-auto-answers'],
  noVerify: ['verifies-signature'],
  showAll: ['hides-above-ceiling'],
  retryOnStale: ['refetch-on-stale'],
  noRefetch: ['refetch-on-stale', 'already-shows-winner'],
  claimsDone: ['waiting-for-executor'],
  showWithheld: ['withheld'],
  ignorePush: ['push-relists'],
};
for (const [bug, ids] of Object.entries(PLANTED)) {
  test(`planted client bug ${bug} is caught by ${ids.join(', ')}`, async () => {
    const r = await runClientChecks((env) => naiveClient(env, { bugs: { [bug]: true } }), { ...quiet, only: ids });
    for (const id of ids) assert.equal(r.find((x) => x.id === id)?.status, 'fail', `${id} should fail under ${bug}`);
  });
}
