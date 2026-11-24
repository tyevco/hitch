// toy-node: a minimal, in-memory hitch/1 node. It exists so the conformance
// kit can test itself (every hitch-check check passes here and fails on a
// broken variant), and as a readable reference for implementers. Not for
// production: no persistence beyond the process, no TLS, one transport.
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import {
  SPEC, tierRank, jcs, hashOf, shownHash, genKey, signObject, verifyBytes, importPub,
  requestString, presenceBytes, randomUlid, b64u,
} from '../lib/wire.mjs';
import { makeValidator } from '../lib/schema.mjs';
import { catalogue } from '../catalog-check.mjs';
import codes from '../../codes.json' with { type: 'json' };
import { sasOf } from '../server/sas.mjs';

const V = makeValidator();
const SAFE_KINDS = (k) => (catalogue.types[k]?.safety ?? 'none') !== 'none';
const iso = (ms) => new Date(ms).toISOString();

class Refusal extends Error {
  constructor(code, extra = {}) { super(code); this.code = code; this.extra = extra; }
}

// store survives restart(); everything else is rebuilt.
export function createStore() {
  return { seq: 0, events: [], floor: 0, decisions: new Map(), items: new Map(), sessions: new Map(),
    messages: new Map(), clients: new Map(), pairings: new Map(), grants: new Map(), audit: new Map(),
    nonces: new Map(), executorCalls: new Map(), content: new Map(), feeds: new Map() };
}

export function createNode({ store = createStore(), clock = { now: () => Date.now() }, nodeKey = genKey('ed25519'),
  aid = 'toynode01', retention = 1000, beatMs = 25000, bugs = {}, onRequest, onSend, declaredKinds = [] } = {}) {
  const kid = `node:${aid}`;
  const tokens = (store.tokens ??= new Map()); // bearer token -> principal
  // clock drives decision time (expiry, attention). Signature windows use the
  // wall clock, so a test that advances decision time can still sign requests.
  const now = () => clock.now();
  const sign = (o) => signObject(o, nodeKey, kid);

  // ---- events ----------------------------------------------------------------
  const listeners = new Set();
  const timers = new Set(); // cleared on close()
  function emit(type, data, { subject, from = { aid, principal: 'node' }, to, privacy } = {}) {
    const env = { spec: SPEC, id: randomUlid(), seq: ++store.seq, time: iso(now()), type, from,
      privacy: privacy ?? catalogue.types[type]?.privacy ?? 'meta', data };
    if (subject) env.subject = subject;
    if (to) env.to = to;
    const signed = sign(env);
    store.events.push(signed);
    while (store.events.length > retention) store.floor = store.events.shift().seq;
    for (const l of listeners) l(signed);
    return signed;
  }
  const changed = (resource, id, rev, op, state) =>
    emit('hitch.changed@1', { resource, id, rev, op, ...(state ? { state } : {}) }, { subject: `${resource.replace(/s$/, '')}/${id}`, privacy: 'public' });

  function trim(n) { // test hook: drop the oldest n events, as retention would
    for (let i = 0; i < n && store.events.length; i++) store.floor = store.events.shift().seq;
  }

  // ---- decisions ---------------------------------------------------------------
  function audit(id, entry) { (store.audit.get(id) ?? store.audit.set(id, []).get(id)).push({ at: iso(now()), ...entry }); }

  function requestDecision({ kind, args = {}, title = kind, summary = '', preview, options, requester = 'mod:toy',
    expires = null, onExpire = 'withdraw', defaultable, remoteApprove = false }) {
    const cat = catalogue.types[kind];
    if (!cat?.decision && !V.has(kind) && !declaredKinds.includes(kind)) throw new Refusal('unknown_type');
    if (V.has(kind)) { const e = V.validate(kind, args); if (e.length) throw new Refusal('invalid', { message: e.join('; ') }); }
    if (kind === 'hitch.grant.issue@1' && args.kinds.some(SAFE_KINDS)) throw new Refusal('invalid', { message: 'grants may not cover safety kinds' });
    const safety = cat?.safety ?? 'none';
    if (safety !== 'none' && (onExpire === 'fallback' || defaultable)) throw new Refusal('invalid', { message: 'safety kinds take no default' });
    const floor = cat?.floor === 'vendor' || !cat ? 'local' : cat.floor;
    const narrow = new Set(cat?.narrowVerbs ?? ['decline']);
    options = (options ?? [{ verb: 'approve', label: 'Approve' }, { verb: 'decline', label: 'Decline' }]).map((o) => {
      const t = narrow.has(o.verb) ? 'narrow' : o.tier && tierRank(o.tier) > tierRank(floor) ? o.tier : floor;
      return { ...o, tier: t };
    });
    const id = 'dec_' + randomUlid();
    const t = iso(now());
    const d = { spec: SPEC, id, kind, rev: 1, state: 'open', owner: kind.split('.')[0], requester: { principal: requester },
      title, summary, effect: `${kind} with ${Object.keys(args).length} bound argument(s)`,
      preview: preview ?? Object.entries(args).slice(0, 10).map(([k, v]) => ({ label: k, value: JSON.stringify(v).slice(0, 200) })),
      bind: { alg: 'sha256/v1', hash: hashOf({ kind, args }) }, safety, audience: 'person', options, remoteApprove,
      urgency: 'normal', expires, onExpire, created: t, updated: t };
    if (defaultable) d.defaultable = defaultable;
    store.decisions.set(id, { d, args });
    audit(id, { event: 'requested', by: requester });
    changed('decisions', id, 1, 'create', 'open');
    return id;
  }

  function editDecision(id, args) {
    const r = store.decisions.get(id);
    r.args = args ?? { ...r.args, edited: (r.args.edited ?? 0) + 1 };
    r.d = { ...r.d, rev: r.d.rev + 1, bind: { alg: 'sha256/v1', hash: hashOf({ kind: r.d.kind, args: r.args }) }, updated: iso(now()) };
    r.d.preview = Object.entries(r.args).slice(0, 10).map(([k, v]) => ({ label: k, value: JSON.stringify(v).slice(0, 200) }));
    audit(id, { event: 'edited', rev: r.d.rev });
    changed('decisions', id, r.d.rev, 'update', r.d.state);
  }

  function resolve(id, outcome, extra = {}) {
    const r = store.decisions.get(id);
    r.d = { ...r.d, state: 'resolved', outcome, rev: r.d.rev + 1, updated: iso(now()), ...extra };
    audit(id, { event: 'resolved', outcome });
    changed('decisions', id, r.d.rev, 'update', 'resolved');
  }

  function sweepExpiry() {
    for (const [id, r] of store.decisions) {
      if (r.d.state !== 'open' || !r.d.expires || Date.parse(r.d.expires) > now()) continue;
      if (bugs.expiryApproves) { r.d.action = { id: 'act_' + randomUlid(), state: 'queued' }; execute(id); continue; }
      const outcome = r.d.onExpire === 'fallback' && r.d.defaultable ? 'fallback' : r.d.onExpire === 'expire' ? 'expired' : 'withdrawn';
      resolve(id, outcome);
    }
  }

  function execute(id) {
    const r = store.decisions.get(id);
    store.executorCalls.set(id, (store.executorCalls.get(id) ?? 0) + 1);
    if (hashOf({ kind: r.d.kind, args: r.args }) !== r.d.bind.hash) { r.d.action.state = 'failed'; return resolve(id, 'failed'); }
    if (r.d.kind === 'hitch.client.pair@1') activatePairing(r.args);
    if (r.d.kind === 'hitch.client.scope@1') {
      const c = store.clients.get(r.args.client);
      if (r.args.ceiling) c.ceiling = c.suite === 'hmac-sha256' && tierRank(r.args.ceiling) > tierRank('decide') ? 'decide' : r.args.ceiling;
      if (r.args.privacy) c.privacy = r.args.privacy;
      changed('clients', c.id, 2, 'update', 'active');
    }
    r.d.action = { ...r.d.action, state: 'applied' };
    resolve(id, 'applied');
  }

  // ---- auth ----------------------------------------------------------------------
  function authenticate(req, body) {
    const h = req.headers;
    if (h.authorization?.startsWith('Bearer ')) {
      const p = tokens.get(h.authorization.slice(7));
      if (!p) throw new Refusal('unauthenticated');
      if (p.revoked) throw new Refusal('revoked');
      return p;
    }
    if (h['hitch-client']) {
      const c = store.clients.get(h['hitch-client']);
      if (!c || c.state === 'pending') throw new Refusal('unauthenticated');
      const iat = Number(h['hitch-iat']);
      if (!Number.isInteger(iat) || Math.abs(Date.now() / 1000 - iat) > 120) throw new Refusal('unauthenticated', { message: 'iat outside window' });
      const s = requestString({ aid, method: req.method, path: req.url, body, nonce: h['hitch-nonce'], iat });
      if (!verifyBytes(c.ver, s, h['hitch-sig'] ?? '')) throw new Refusal('unauthenticated', { message: 'bad signature' });
      if (c.state === 'revoked') throw new Refusal('revoked');
      const nk = `req:${c.id}:${h['hitch-nonce']}`;
      if (store.nonces.has(nk)) throw new Refusal('replay');
      store.nonces.set(nk, iat + 120);
      return { principal: `client:${c.id}`, client: c };
    }
    throw new Refusal('unauthenticated');
  }

  // test hooks to mint credentials (a real node mints these through pairing and cx/1 hello)
  function addToken(principal, extra = {}) { const t = b64u(randomBytes(24)); tokens.set(t, { principal, ...extra }); return t; }
  function addClient({ suite = 'ed25519', ceiling = 'decide', privacy = 'text', presence = [], name = 'test', device = 'test', state = 'active' } = {}) {
    const key = genKey(suite);
    const id = 'c_' + b64u(randomBytes(6)).replace(/[-_]/g, 'x');
    const ver = suite === 'hmac-sha256' ? { suite, secret: key.secret } : { suite, publicKey: key.publicKey };
    if (suite === 'hmac-sha256' && tierRank(ceiling) > tierRank('decide')) ceiling = 'decide';
    store.clients.set(id, { id, name, device, suite, ver, ceiling, privacy, scopes: ['read', 'answer'], state,
      presence: presence.map((p) => ({ kid: p.kid, suite: p.key.suite, ver: { suite: p.key.suite, publicKey: p.key.publicKey } })),
      paired: iso(now()) });
    return { cid: id, key };
  }
  function revokeClient(cid) { store.clients.get(cid).state = 'revoked'; changed('clients', cid, 2, 'update', 'revoked'); }
  function issueGrant({ kinds, perHour = 10, perDay = 50 }) {
    if (kinds.some(SAFE_KINDS)) throw new Refusal('invalid', { message: 'grants may not cover safety kinds' });
    const id = 'gr_' + randomUlid();
    store.grants.set(id, { id, kinds, caps: { perHour, perDay }, used: 0, state: 'active' });
    return addToken(`grant:${id}`, { grant: id });
  }

  // ---- answers -------------------------------------------------------------------------
  function answer(p0, id, body) {
    let p = p0;
    const isGrant = p.principal.startsWith('grant:');
    if (!p.client && !isGrant && !bugs.modAnswers) throw new Refusal('not_a_client');
    if (!p.client && !isGrant) p = { ...p, client: { suite: 'ed25519', ceiling: 'local', presence: [], device: 'mod' } };
    const r = store.decisions.get(id);
    if (!r) throw new Refusal('gone');
    let a;
    try { a = JSON.parse(body); } catch { throw new Refusal('invalid'); }
    const errs = V.validate('hitch.answer@1', a);
    if (errs.length || a.decisionId !== id) throw new Refusal('invalid', { message: errs.join('; ') || 'decisionId mismatch' });
    sweepExpiry();
    const d = r.d;
    const opt = d.options.find((o) => o.verb === a.verb);
    if (!opt) throw new Refusal('invalid', { message: 'verb not offered' });
    if (isGrant) {
      const g = store.grants.get(p.grant);
      if (SAFE_KINDS(d.kind) || !g.kinds.includes(d.kind)) throw new Refusal('scope');
      if (g.used >= g.caps.perHour) throw new Refusal('rate');
    } else {
      const c = p.client;
      if (!bugs.ignoreCeiling && c.suite === 'hmac-sha256' && tierRank(opt.tier) > tierRank('decide')) throw new Refusal('suite');
      if (!bugs.ignoreCeiling && tierRank(opt.tier) > tierRank(c.ceiling)) throw new Refusal('tier');
      if (!bugs.skipPresence && tierRank(opt.tier) >= tierRank('confirm')) {
        const pk = a.presence && c.presence.find((x) => x.kid === a.presence.kid);
        if (!pk || !verifyBytes(pk.ver, presenceBytes(a), a.presence.v)) throw new Refusal('step_up_required');
      }
    }
    if (a.aid !== aid) throw new Refusal('replay', { message: 'answer names another node' });
    if (d.state === 'resolved' && (d.outcome === 'withdrawn' || d.outcome === 'expired')) throw new Refusal(d.outcome);
    if (d.state !== 'open') throw new Refusal('already', { winner: d.answered });
    if (a.rev !== d.rev || a.bindHash !== d.bind.hash || (!bugs.skipShown && a.shownHash !== shownHash(d)))
      throw new Refusal('stale', { current: { rev: d.rev, bindHash: d.bind.hash } });
    const nk = `ans:${a.nonce}`;
    if (!bugs.noNonceCheck && store.nonces.has(nk)) throw new Refusal('replay');
    if (a.exp < a.iat || a.exp - a.iat > 120 || a.exp < Date.now() / 1000 || a.iat > Date.now() / 1000 + 120) throw new Refusal('replay', { message: 'iat/exp window' });
    store.nonces.set(nk, a.exp);
    // CAS: single-threaded here, so the open check above is the compare.
    const answered = { verb: a.verb, by: p.principal, at: iso(now()), ...(p.client ? { device: p.client.device } : {}) };
    if (isGrant) store.grants.get(p.grant).used++;
    audit(id, { event: 'answered', by: p.principal, verb: a.verb, tier: opt.tier, presence: a.presence?.kid ?? null, shownHash: a.shownHash, bindHash: a.bindHash });
    emit('hitch.answer@1', { ...a }, { subject: `decision/${id}`, from: { aid, principal: p.principal } });
    if (a.verb === 'decline' || a.verb === 'deny') resolve(id, 'declined', { answered });
    else if (a.verb === 'sendBack') resolve(id, 'sent-back', { answered });
    else {
      r.d = { ...d, state: 'answered', answered, rev: d.rev + 1, updated: iso(now()), action: { id: 'act_' + randomUlid(), state: 'queued' } };
      changed('decisions', id, r.d.rev, 'update', 'answered');
      if (!bugs.noExecutor) execute(id);
    }
    return sign(viewFor(p, store.decisions.get(id).d));
  }

  // ---- revoke --------------------------------------------------------------------------
  // Self: free. Another client: confirm ceiling + presence. All: local + presence.
  function checkPresence(c, b, need) {
    if (tierRank(c.ceiling) < tierRank(need)) throw new Refusal('tier');
    const pk = b.presence && c.presence.find((x) => x.kid === b.presence.kid);
    if (!pk || !verifyBytes(pk.ver, presenceBytes(b), b.presence.v)) throw new Refusal('step_up_required');
  }
  function revokeBody(p, body) {
    if (!p.client) throw new Refusal('not_a_client');
    const b = JSON.parse(body || '{}');
    const e = V.validate('hitch.revoke.request', b);
    if (e.length) throw new Refusal('invalid', { message: e.join('; ') });
    if (b.exp < b.iat || b.exp - b.iat > 120 || b.exp < Date.now() / 1000) throw new Refusal('replay', { message: 'iat/exp window' });
    const nk = `rev:${p.client.id}:${b.nonce}`;
    if (store.nonces.has(nk)) throw new Refusal('replay');
    store.nonces.set(nk, b.exp);
    return b;
  }
  function revokeOne(p, cid, body) {
    const b = revokeBody(p, body);
    const t = store.clients.get(cid);
    if (!t || t.state === 'revoked') throw new Refusal('gone');
    if (cid !== p.client.id && !bugs.revokeOthersFree) checkPresence(p.client, b, 'confirm');
    revokeClient(cid);
    audit(`client/${cid}`, { event: 'revoked', by: p.principal });
    return clientView(store.clients.get(cid));
  }
  function revokeAll(p, body) {
    const b = revokeBody(p, body);
    checkPresence(p.client, b, 'local');
    for (const c of store.clients.values()) if (c.state === 'active') revokeClient(c.id);
    return { spec: SPEC, revoked: [...store.clients.values()].filter((c) => c.state === 'revoked').length };
  }
  const clientView = ({ ver, presence, ...c }) => ({ spec: SPEC, ...c, presence: presence.map(({ kid, suite }) => ({ kid, suite })) });

  // ---- feeds ---------------------------------------------------------------------------
  function setFeed(name, data) {
    const f = store.feeds.get(name);
    const rev = (f?.rev ?? 0) + 1;
    store.feeds.set(name, { rev, data, updated: iso(now()) });
    emit('hitch.changed@1', { resource: 'feeds', id: name, rev, op: f ? 'update' : 'create' }, { subject: `feed/${name}`, privacy: 'public' });
    return rev;
  }

  function viewFor(p, d) {
    const c = p.client;
    if (!c) return d;
    return { ...d, options: d.options.map((o) => ({ ...o, allowedForYou: tierRank(o.tier) <= tierRank(c.ceiling) && !(c.suite === 'hmac-sha256' && tierRank(o.tier) > 1) })) };
  }

  // ---- pairing -------------------------------------------------------------------------
  function pairStart(body) {
    const b = JSON.parse(body);
    const e = V.validate('hitch.pairing.request', b);
    if (e.length) throw new Refusal('invalid', { message: e.join('; ') });
    const id = 'pr_' + randomUlid();
    const serverNonce = b64u(randomBytes(16));
    store.pairings.set(id, { ...b, serverNonce, state: 'committed' });
    return { spec: SPEC, pairing: id, serverNonce, expiresIn: 300 };
  }
  function pairReveal(id, body) {
    const p = store.pairings.get(id);
    if (!p || p.state !== 'committed') throw new Refusal('gone');
    const { nonce } = JSON.parse(body);
    if (hashOf({ pub: p.pub, nonce }) !== p.commit) throw new Refusal('invalid', { message: 'commit does not match' });
    const sas = sasOf({ commit: p.commit, clientNonce: nonce, serverNonce: p.serverNonce, pub: p.pub, nodeKey: bugs.sasNoNodeKey ? '' : nodeKey.pub });
    p.state = 'revealed';
    // Every client after the first starts at decide (hmac is capped there anyway);
    // only a later hitch.client.scope@1 (local) raises it. The first client's
    // bootstrap (OS dialog, ceiling local) is outside this toy.
    const ceiling = 'decide';
    const presence = (p.presence ?? []).map((k) => ({ kid: k.kid, suite: k.suite, key: hashOf(k.pub) }));
    p.decision = requestDecision({ kind: 'hitch.client.pair@1', requester: 'node', title: `Pair ${p.name}`,
      args: { pairing: id, name: p.name, sas, suite: p.suite, scopes: ['read', 'answer'], ceiling, presence },
      preview: [{ label: 'Device', value: p.name }, { label: 'Code', value: sas }, { label: 'Signs with', value: p.suite },
        { label: 'Starts at', value: ceiling },
        ...presence.map((k) => ({ label: 'Presence key', value: `${k.suite} ${k.kid} ${k.key.slice(7, 23)}` }))] });
    return { spec: SPEC, pairing: id, sas, decision: p.decision };
  }
  function pairStatus(id) {
    const p = store.pairings.get(id);
    if (!p) throw new Refusal('gone');
    const dec = p.decision && store.decisions.get(p.decision)?.d;
    const state = p.state === 'paired' ? 'paired' : dec?.outcome === 'declined' ? 'declined'
      : dec?.state === 'resolved' ? 'expired' : 'pending';
    return { spec: SPEC, pairing: id, state, ...(p.cid ? { client: p.cid, ceiling: store.clients.get(p.cid).ceiling, aid } : {}) };
  }

  function activatePairing(args) {
    const p = store.pairings.get(args.pairing);
    const cid = 'c_' + b64u(randomBytes(6)).replace(/[-_]/g, 'x');
    const ver = { suite: p.suite, publicKey: importPub(p.suite, p.pub) };
    // presence keys recorded exactly as committed in the pairing request (and bound into the pair decision)
    const presence = (p.presence ?? []).filter((k) => k.suite !== 'webauthn') // toy: no webauthn verifier
      .map((k) => ({ kid: k.kid, suite: k.suite, ver: { suite: k.suite, publicKey: importPub(k.suite, k.pub) } }));
    store.clients.set(cid, { id: cid, name: p.name, device: p.name, suite: p.suite, ver, ceiling: args.ceiling, privacy: 'meta',
      scopes: args.scopes, state: 'active', presence, paired: iso(now()) });
    p.state = 'paired'; p.cid = cid;
    changed('clients', cid, 1, 'create', 'active');
  }

  // ---- HTTP ------------------------------------------------------------------------------
  const lists = { decisions: () => [...store.decisions.values()].map((r) => r.d), items: () => [...store.items.values()],
    sessions: () => [...store.sessions.values()], messages: (p) => [...store.messages.values()].map((m) => messageView(p, m)).filter(Boolean),
    clients: () => [...store.clients.values()].map(clientView) };

  function send(res, status, obj, headers = {}) {
    if (onSend && res.req) obj = onSend(new URL(res.req.url, 'http://x').pathname, obj, status) ?? obj;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  }
  function refuse(res, err) {
    const status = codes.codes[err.code]?.status ?? 500;
    send(res, status, { spec: SPEC, code: err.code, ...(err.message !== err.code ? { message: err.message } : {}), ...err.extra });
  }

  function eventsAfter(after) {
    if (after < store.floor) throw new Refusal('gap', { resync: ['decisions', 'items', 'sessions', 'messages', 'clients'] });
    return store.events.filter((e) => e.seq > after);
  }

  async function handle(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    onRequest?.({ method: req.method, path, query: url.search, body, at: Date.now() });
    try {
      sweepExpiry();
      if (req.method === 'GET' && path === '/.well-known/hitch') {
        return send(res, 200, { specs: [SPEC], impl: { name: 'toy-node', version: '0.1.0' }, aid, caps: ['sse', 'longpoll'],
          profiles: ['core', 'decisions', 'pairing', 'feeds', 'messaging'], suites: ['hmac-sha256', 'p256', 'ed25519'],
          nodeKey: { suite: 'ed25519', kid, x: nodeKey.pub } });
      }
      if (req.method === 'POST' && path === '/hitch/v1/clients/pairings') return send(res, 202, pairStart(body));
      const m = path.match(/^\/hitch\/v1\/clients\/pairings\/([^/]+)\/reveal$/);
      if (req.method === 'POST' && m) return send(res, 200, pairReveal(m[1], body));
      const ps = path.match(/^\/hitch\/v1\/clients\/pairings\/([^/]+)$/);
      if (req.method === 'GET' && ps) return send(res, 200, pairStatus(ps[1]));
      if (req.method === 'POST' && path === '/hitch/v1/sockhello') {
        const { challenge } = JSON.parse(body || '{}');
        if (typeof challenge !== 'string' || Buffer.from(challenge, 'base64url').length !== 32) throw new Refusal('invalid', { message: 'challenge: 32 bytes base64url' });
        const sig = signObject({ purpose: 'hitch-sockhello', spec: SPEC, aid, challenge }, nodeKey, kid).sig;
        return send(res, 200, { spec: SPEC, aid, challenge, sig });
      }
      if (req.method === 'GET' && path === '/hitch/v1/nonce') return send(res, 200, { spec: SPEC, nonce: b64u(randomBytes(16)) });

      const p = authenticate(req, body);
      if (req.method === 'POST' && path === '/hitch/v1/hello') {
        const h = JSON.parse(body || '{}');
        const e = V.validate('hitch.hello.request', h);
        if (e.length) throw new Refusal('invalid', { message: e.join('; ') });
        return send(res, 200, { spec: SPEC, aid, principal: p.principal, caps: ['sse', 'longpoll'], cursor: store.seq,
          ...(p.client ? { ceiling: p.client.ceiling, scopes: p.client.scopes, privacy: p.client.privacy } : {}) });
      }
      const lm = path.match(/^\/hitch\/v1\/(decisions|items|sessions|messages|clients)$/);
      if (req.method === 'GET' && lm) {
        let list = lists[lm[1]](p);
        const st = url.searchParams.get('state'); if (st) list = list.filter((x) => x.state === st);
        const k = url.searchParams.get('kind'); if (k) list = list.filter((x) => x.kind === k);
        if (lm[1] === 'decisions') list = list.map((d) => sign(viewFor(p, d)));
        return send(res, 200, { spec: SPEC, resource: lm[1], list, cursor: store.seq });
      }
      const dm = path.match(/^\/hitch\/v1\/decisions\/(dec_[0-9A-Z]+)(\/answers|\/audit)?$/);
      if (dm) {
        const r = store.decisions.get(dm[1]);
        if (!r) throw new Refusal('gone');
        if (req.method === 'GET' && !dm[2]) return send(res, 200, sign(viewFor(p, r.d)));
        if (req.method === 'GET' && dm[2] === '/audit') return send(res, 200, { spec: SPEC, id: dm[1], audit: store.audit.get(dm[1]) ?? [] });
        if (req.method === 'POST' && dm[2] === '/answers') return send(res, 200, answer(p, dm[1], body));
      }
      if (req.method === 'POST' && path === '/hitch/v1/publish') {
        if (!/^(mod|app|session):/.test(p.principal)) throw new Refusal('scope');
        const b = JSON.parse(body);
        const owner = p.owner ?? p.principal.split(':')[1];
        if (typeof b.type !== 'string' || b.type.split('.')[0] !== owner) throw new Refusal('scope', { message: 'owner types only' });
        if (!V.has(b.type) && !catalogue.types[b.type]) throw new Refusal('unknown_type');
        if (V.has(b.type)) { const e = V.validate(b.type, b.data ?? {}); if (e.length) throw new Refusal('invalid', { message: e.join('; ') }); }
        const from = bugs.trustBodyFrom && b.from ? b.from : { aid, principal: p.principal };
        return send(res, 200, emit(b.type, b.data ?? {}, { subject: b.subject, to: b.to, from }));
      }
      if (req.method === 'GET' && path === '/hitch/v1/events') return events(req, res, url, p);
      if (req.method === 'POST' && path === '/hitch/v1/messages') return send(res, 200, postMessage(p, body));
      const ms = path.match(/^\/hitch\/v1\/messages\/(msg_[0-9A-Z]+)\/state$/);
      if (req.method === 'POST' && ms) return send(res, 200, messageState(p, ms[1], body));
      const rv = path.match(/^\/hitch\/v1\/clients\/(c_[A-Za-z0-9]+)\/revoke$/);
      if (req.method === 'POST' && rv) return send(res, 200, revokeOne(p, rv[1], body));
      if (req.method === 'POST' && path === '/hitch/v1/clients/revoke-all') return send(res, 200, revokeAll(p, body));
      const fm = path.match(/^\/hitch\/v1\/feeds\/([a-z][a-z0-9-]*(?:\.[a-z][a-zA-Z0-9-]*)+@[1-9][0-9]*)$/);
      if (req.method === 'GET' && fm) {
        if (p.client && !p.client.scopes.includes('read')) throw new Refusal('scope');
        const f = store.feeds.get(fm[1]);
        if (!f) throw new Refusal('gone');
        const PR = ['public', 'counts', 'meta', 'text', 'secret'];
        const cls = catalogue.types[fm[1]]?.privacy ?? 'text';
        if (p.client && PR.indexOf(cls) > PR.indexOf(p.client.privacy)) throw new Refusal('privacy');
        return send(res, 200, sign({ spec: SPEC, feed: fm[1], rev: f.rev, updated: f.updated, privacy: cls, data: f.data }));
      }
      const cm = path.match(/^\/hitch\/v1\/content\/(sha256:[0-9a-f]{64})$/);
      if (req.method === 'GET' && cm) {
        const c = store.content.get(cm[1]);
        if (!c) throw new Refusal('gone');
        const PR = ['public', 'counts', 'meta', 'text', 'secret'];
        if (p.client && PR.indexOf(c.privacy) > PR.indexOf(p.client.privacy)) throw new Refusal('privacy');
        res.writeHead(200, { 'content-type': c.type, 'hitch-digest': cm[1] });
        return res.end(c.b);
      }
      throw new Refusal('gone');
    } catch (err) {
      if (err instanceof Refusal) return refuse(res, err);
      if (err instanceof SyntaxError) return refuse(res, new Refusal('invalid', { message: 'bad JSON' }));
      send(res, 500, { spec: SPEC, code: 'invalid', message: String(err.message) });
    }
  }

  // What a principal may see of an event: a session sees only its own to:{session}
  // traffic (and untargeted events); a client sees everything, with data above
  // its privacy class withheld. Redacted copies are re-signed.
  const PRIV = ['public', 'counts', 'meta', 'text', 'secret'];
  function visible(p, e) {
    if (bugs.noEventFilter) return e;
    const sid = p.principal.startsWith('session:') ? p.principal.slice(8) : null;
    if (e.to?.session && sid !== null && e.to.session !== sid) return null;
    if (p.client && PRIV.indexOf(e.privacy) > PRIV.indexOf(p.client.privacy)) {
      const { sig, ...rest } = e;
      return sign({ ...rest, data: { withheld: true } });
    }
    return e;
  }

  function events(req, res, url, p) {
    const sse = (req.headers.accept ?? '').includes('text/event-stream');
    const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? store.seq);
    const raw = eventsAfter(after);
    const backlog = raw.map((e) => visible(p, e)).filter(Boolean);
    if (!sse) {
      const wait = Math.min(Number(url.searchParams.get('wait') ?? 0), 25);
      const cursor = raw.at(-1)?.seq ?? Math.max(after, 0);
      if (raw.length || !wait) return send(res, 200, { spec: SPEC, events: backlog, cursor });
      const t = setTimeout(() => { timers.delete(t); listeners.delete(l); send(res, 200, { spec: SPEC, events: [], cursor: after }); }, wait * 1000);
      timers.add(t);
      const l = (e0) => { const e = visible(p, e0); clearTimeout(t); timers.delete(t); listeners.delete(l); send(res, 200, { spec: SPEC, events: e ? [e] : [], cursor: e0.seq }); };
      listeners.add(l);
      res.on('close', () => { clearTimeout(t); timers.delete(t); listeners.delete(l); });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const write = (e0) => { const e = visible(p, e0); if (e) res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); };
    raw.forEach(write);
    const beat = setInterval(() => res.write(`event: hitch.beat@1\ndata: ${JSON.stringify({ spec: SPEC, type: 'hitch.beat@1', data: { head: store.seq } })}\n\n`), beatMs);
    timers.add(beat);
    listeners.add(write);
    res.on('close', () => { clearInterval(beat); timers.delete(beat); listeners.delete(write); });
  }

  // ---- messages ------------------------------------------------------------------------
  const STATES = ['queued', 'sent', 'seen', 'acked'];
  function messageView(p, m) {
    if (p.client && PRIV.indexOf('text') > PRIV.indexOf(p.client.privacy)) { const { text, ...rest } = m; return { ...rest, withheld: true }; }
    const sid = p.principal.startsWith('session:') ? p.principal.slice(8) : null;
    if (sid !== null && m.to.session !== sid) return null;
    return m;
  }
  function postMessage(p, body) {
    if (!p.client) throw new Refusal('not_a_client', { message: 'POST /messages is person-authored; agents publish their own types' });
    const b = JSON.parse(body || '{}');
    const e = V.validate('hitch.message.post', b);
    if (e.length) throw new Refusal('invalid', { message: e.join('; ') });
    if (b.idem) { const prior = [...store.messages.values()].find((m) => m.idem === b.idem && m.from.principal === p.principal); if (prior) return prior; }
    const id = 'msg_' + randomUlid();
    const m = { spec: SPEC, id, from: { aid, principal: p.principal, ...(p.client.device ? { device: p.client.device } : {}) }, to: b.to,
      intent: b.intent ?? 'message', text: b.text, state: 'queued', time: iso(now()), ...(b.idem ? { idem: b.idem } : {}), ...(b.replyTo ? { replyTo: b.replyTo } : {}) };
    store.messages.set(id, m);
    emit('message.received@1', { message: id, intent: m.intent, text: m.text }, { subject: `message/${id}`, to: b.to, from: m.from, privacy: 'text' });
    changed('messages', id, 1, 'create', 'queued');
    return m;
  }
  function messageState(p, id, body) {
    const m = store.messages.get(id);
    if (!m) throw new Refusal('gone');
    const b = JSON.parse(body || '{}');
    const e = V.validate('hitch.message.state', b);
    if (e.length) throw new Refusal('invalid', { message: e.join('; ') });
    if (p.principal !== `session:${m.to.session}` && !bugs.anyoneAcks) throw new Refusal('scope', { message: 'only the addressee reports delivery' });
    if (STATES.indexOf(b.state) <= STATES.indexOf(m.state)) throw new Refusal('invalid', { message: 'delivery state only moves forward' });
    m.state = b.state;
    emit('message.delivery@1', { message: id, state: b.state }, { subject: `message/${id}`, from: { aid, principal: p.principal }, privacy: 'meta' });
    changed('messages', id, STATES.indexOf(b.state) + 1, 'update', b.state);
    return m;
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  return {
    server, aid, store, clock, nodeKey,
    listen: (port = 0) => new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((ok) => {
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      timers.clear(); listeners.clear();
      server.closeAllConnections?.(); server.close(() => ok());
    }),
    // test hooks
    requestDecision, editDecision, sign, execute,
    putContent: (bytes, type = 'text/plain; charset=utf-8', privacy = 'text') => {
      const b = Buffer.from(bytes); const h = 'sha256:' + createHash('sha256').update(b).digest('hex');
      store.content.set(h, { b, type, privacy }); return { hash: h, bytes: b.length };
    }, answerAs: (p, id, body) => answer(p, id, body), withdraw: (id) => resolve(id, 'withdrawn'), addToken, addClient, revokeClient, issueGrant, trim, setFeed,
    resolveElsewhere: (id, where) => resolve(id, 'resolved-elsewhere', { answered: { verb: 'approve', by: 'app:herdr', at: iso(now()), where } }),
    executorCalls: (id) => store.executorCalls.get(id) ?? 0,
    publishAs: (principal, type, data) => emit(type, data, { from: { aid, principal } }),
  };
}

export { Refusal, importPub, jcs };
