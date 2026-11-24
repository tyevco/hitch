// hitch/1 wire primitives: canonical JSON, hashes, node signatures, request
// signing, shown hash and presence. Normative: SPEC.md "Wire details".
// Node stdlib only.
import { createHash, createHmac, createPublicKey, sign, verify, generateKeyPairSync, randomBytes } from 'node:crypto';

export const SPEC = 'hitch/1';
export const TIERS = ['narrow', 'decide', 'confirm', 'local'];
export const tierRank = (t) => TIERS.indexOf(t);

// RFC 8785 (JCS). Keys sorted by UTF-16 code units (JS default sort), numbers in
// ECMAScript shortest form (JSON.stringify), no whitespace.
export function jcs(v) {
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('jcs: non-finite number');
    return JSON.stringify(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(jcs).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}';
  }
  throw new TypeError('jcs: unsupported ' + typeof v);
}

export const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const hashOf = (obj) => 'sha256:' + sha256hex(Buffer.from(jcs(obj), 'utf8'));
export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(s, 'base64url');

const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };

// shownHash: what the client rendered. summary is required in the record (may be "").
export function shownHash(d) {
  return hashOf({ id: d.id, rev: d.rev, title: d.title, summary: d.summary, effect: d.effect, preview: d.preview });
}

// ---- keys ------------------------------------------------------------------
// ed25519 public keys travel as base64url raw 32 bytes (JWK OKP "x").
// p256 public keys travel as {x, y} base64url (JWK EC). Signatures: ed25519 raw
// 64 bytes; p256 raw r||s 64 bytes (ieee-p1363). hmac-sha256: 32-byte tag.
export function genKey(suite) {
  if (suite === 'hmac-sha256') { const secret = randomBytes(32); return { suite, secret, pub: null }; }
  const { privateKey, publicKey } = suite === 'ed25519'
    ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { suite, privateKey, publicKey, pub: pubOf(suite, publicKey) };
}

export function pubOf(suite, publicKey) {
  const j = publicKey.export({ format: 'jwk' });
  return suite === 'ed25519' ? j.x : { x: j.x, y: j.y };
}

export function importPub(suite, pub) {
  if (suite === 'ed25519') return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub }, format: 'jwk' });
  if (suite === 'p256') return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y }, format: 'jwk' });
  throw new Error('importPub: no public key for suite ' + suite);
}

export function signBytes(key, bytes) {
  const data = Buffer.from(bytes);
  if (key.suite === 'hmac-sha256') return b64u(createHmac('sha256', key.secret).update(data).digest());
  if (key.suite === 'ed25519') return b64u(sign(null, data, key.privateKey));
  if (key.suite === 'p256') return b64u(sign('sha256', data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' }));
  throw new Error('signBytes: unknown suite ' + key.suite);
}

// verifier: {suite, publicKey} or {suite:'hmac-sha256', secret}
export function verifyBytes(ver, bytes, v) {
  const data = Buffer.from(bytes);
  try {
    if (ver.suite === 'hmac-sha256') {
      const want = createHmac('sha256', ver.secret).update(data).digest();
      const got = unb64u(v);
      return got.length === want.length && want.equals(got);
    }
    const pk = ver.publicKey ?? importPub(ver.suite, ver.pub);
    if (ver.suite === 'ed25519') return verify(null, data, pk, unb64u(v));
    if (ver.suite === 'p256') return verify('sha256', data, { key: pk, dsaEncoding: 'ieee-p1363' }, unb64u(v));
  } catch { return false; }
  return false;
}

// Node key id: node:<aid>:<fp>, fp = first 8 hex of sha256(raw 32-byte x).
// A rotation changes kid; aid stays.
export const nodeKid = (aid, x) => `node:${aid}:${sha256hex(unb64u(x)).slice(0, 8)}`;

// ---- node signatures over objects ------------------------------------------
export function signObject(obj, key, kid) {
  const body = without(obj, 'sig');
  return { ...body, sig: { suite: key.suite, kid, v: signBytes(key, jcs(body)) } };
}
export function verifyObject(obj, ver) {
  if (!obj || !obj.sig || obj.sig.suite !== ver.suite) return false;
  return verifyBytes(ver, jcs(without(obj, 'sig')), obj.sig.v);
}

// ---- request signing -------------------------------------------------------
export function requestString({ aid, method, path, body = '', nonce, iat }) {
  return [SPEC, aid, method.toUpperCase(), path, sha256hex(Buffer.from(body, 'utf8')), nonce, String(iat)].join('\n');
}
export function signRequest({ cid, key, aid, method, path, body = '', nonce, iat }) {
  nonce ??= b64u(randomBytes(16));
  iat ??= Math.floor(Date.now() / 1000);
  const sig = signBytes(key, requestString({ aid, method, path, body, nonce, iat }));
  return { 'hitch-client': cid, 'hitch-nonce': nonce, 'hitch-iat': String(iat), 'hitch-sig': sig };
}

// ---- answers ---------------------------------------------------------------
// Build a hitch.answer@1 body for a decision as rendered. presenceKey optional.
export function buildAnswer(decision, { aid, verb, text, presenceKey, presenceKid, iat, ttl = 120, nonce } = {}) {
  iat ??= Math.floor(Date.now() / 1000);
  const a = {
    decisionId: decision.id, aid, verb, rev: decision.rev,
    bindHash: decision.bind.hash, shownHash: shownHash(decision),
    iat, exp: iat + ttl, nonce: nonce ?? b64u(randomBytes(16)),
  };
  if (text !== undefined) a.text = text;
  if (presenceKey) a.presence = { suite: presenceKey.suite, kid: presenceKid, v: signBytes(presenceKey, jcs(a)) };
  return a;
}
export const presenceBytes = (answer) => jcs(without(answer, 'presence'));

// A presence-bearing command body (revoke, revoke-all): {iat, exp, nonce, presence?}.
export function commandBody({ presenceKey, presenceKid, iat, ttl = 120, nonce } = {}) {
  iat ??= Math.floor(Date.now() / 1000);
  const b = { iat, exp: iat + ttl, nonce: nonce ?? b64u(randomBytes(16)) };
  if (presenceKey) b.presence = { suite: presenceKey.suite, kid: presenceKid, v: signBytes(presenceKey, jcs(b)) };
  return b;
}

export const randomUlid = () => {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = Date.now(), s = '';
  for (let i = 0; i < 10; i++) { s = A[t % 32] + s; t = Math.floor(t / 32); }
  const r = randomBytes(16);
  for (let i = 0; i < 16; i++) s += A[r[i] % 32];
  return s;
};

