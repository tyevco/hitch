import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jcs, hashOf, genKey, signObject, verifyObject, signRequest, requestString, verifyBytes, buildAnswer, presenceBytes, shownHash } from '../conformance/lib/wire.mjs';

test('JCS: sorted keys, no whitespace, ES numbers, undefined dropped', () => {
  assert.equal(jcs({ b: 1, a: [true, null, 'x'], c: { z: 1e21, y: 0.1, x: undefined } }), '{"a":[true,null,"x"],"b":1,"c":{"y":0.1,"z":1e+21}}');
  assert.equal(jcs({ '€': 1, a: 2, B: 3 }), '{"B":3,"a":2,"€":1}');
  assert.throws(() => jcs({ n: NaN }));
});

test('hash vector is stable (pinned for other-language implementations)', () => {
  assert.equal(hashOf({ hello: 'hitch' }), 'sha256:6e6e30c468dcdf67bd88eff129922cc7ce0c431689009d8f6c12daad0958f1a8');
  assert.equal(hashOf({}), 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
});

for (const suite of ['ed25519', 'p256', 'hmac-sha256']) {
  test(`${suite}: object and request signatures verify, and fail when altered`, () => {
    const k = genKey(suite);
    const ver = suite === 'hmac-sha256' ? { suite, secret: k.secret } : { suite, pub: k.pub };
    const h = signRequest({ cid: 'c_1', key: k, aid: 'node01', method: 'post', path: '/hitch/v1/x?a=1', body: '{}', nonce: 'n', iat: 1 });
    const s = requestString({ aid: 'node01', method: 'POST', path: '/hitch/v1/x?a=1', body: '{}', nonce: 'n', iat: 1 });
    assert.equal(s, 'hitch/1\nnode01\nPOST\n/hitch/v1/x?a=1\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\nn\n1');
    assert.ok(verifyBytes(ver, s, h['hitch-sig']));
    assert.ok(!verifyBytes(ver, s + 'x', h['hitch-sig']));
    if (suite !== 'hmac-sha256') {
      const o = signObject({ a: 1 }, k, 'kid');
      assert.ok(verifyObject(o, ver)); assert.ok(!verifyObject({ ...o, a: 2 }, ver));
      assert.equal(Buffer.from(o.sig.v, 'base64url').length, 64, 'raw 64-byte signature (r||s for p256)');
    }
  });
}

test('answer: presence signs JCS(answer minus presence); shownHash covers id, rev, title, summary, effect, preview', () => {
  const d = { id: 'dec_01JD7Y3Q8K2M4N5P6R7S8T9V0W', rev: 3, title: 't', summary: '', effect: 'e', preview: [], bind: { hash: 'sha256:' + '1'.repeat(64) } };
  const pk = genKey('p256');
  const a = buildAnswer(d, { aid: 'node01', verb: 'approve', presenceKey: pk, presenceKid: 'k' });
  assert.ok(verifyBytes({ suite: 'p256', pub: pk.pub }, presenceBytes(a), a.presence.v));
  assert.equal(a.shownHash, hashOf({ id: d.id, rev: 3, title: 't', summary: '', effect: 'e', preview: [] }));
  assert.notEqual(shownHash({ ...d, summary: 'x' }), a.shownHash);
  assert.equal(a.exp - a.iat, 120);
});
