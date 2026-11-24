#!/usr/bin/env node
// hitch-mock-serve: hitch-mock behind a small JSON control API, so a client
// kit in another language (the Python stdlib one for pairview) can script it.
// Prints one line {"control": "http://127.0.0.1:<port>"} on stdout, then serves.
// Loopback only. Not authenticated: it is a test fixture, never run it on a LAN.
//
//   POST   /mocks                      {ceiling?, suite?, privacy?, presence?} -> {id, url, aid, nodeKey, credentials}
//   POST   /mocks/:id/<op>             op in OPS below, body = its arguments object -> {result}
//   GET    /mocks/:id/requests?method=&path=<regex>  -> {requests:[{method, path, query, at}]}
//   GET    /mocks/:id/seq              -> {seq}
//   DELETE /mocks/:id
import http from 'node:http';
import { startMock } from './hitch-mock.mjs';

const mocks = new Map();
let next = 1;

const OPS = {
  request: (m, a) => m.request(a),
  edit: (m, a) => m.edit(a.id),
  withdraw: (m, a) => m.withdraw(a.id),
  resolveElsewhere: (m, a) => m.resolveElsewhere(a.id, a.where),
  answerFromOtherDevice: (m, a) => { m.answerFromOtherDevice(a.id, a.verb); return true; },
  runExecutor: (m, a) => { m.runExecutor(a.id); return true; },
  forgeTitle: (m, a) => { m.forgeTitle(a.id, a.title); return true; },
  resign: (m, a) => { m.resign(a.id); return true; },
  putContent: (m, a) => m.putContent(a.text, a.type, a.privacy),
  setTier: (m, a) => { const d = m.node.store.decisions.get(a.id).d; d.options.find((o) => o.verb === a.verb).tier = a.tier; return true; },
  seq: (m) => m.node.store.seq,
  setFeed: (m, a) => m.setFeed(a.name, a.data),
  clearLog: (m) => { m.clearLog(); return true; },
  state: (m, a) => { const r = m.node.store.decisions.get(a.id); return r ? { state: r.d.state, outcome: r.d.outcome ?? null, rev: r.d.rev } : null; },
};

function creds(c) {
  const out = { cid: c.cid, suite: c.suite };
  if (c.suite === 'hmac-sha256') out.secret = c.key.secret.toString('base64url');
  else out.jwk = c.jwk;
  if (c.presence) out.presence = { kid: c.presence.kid, suite: c.presence.suite, jwk: c.presence.jwk };
  return out;
}

const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const send = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    const url = new URL(req.url, 'http://x');
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.method === 'POST' && url.pathname === '/mocks') {
      const m = await startMock(body);
      const id = String(next++);
      mocks.set(id, m);
      return send(200, { id, url: m.url, aid: m.aid, nodeKey: m.nodeKey, credentials: creds(m.credentials) });
    }
    const p = url.pathname.match(/^\/mocks\/(\d+)(?:\/(\w+))?$/);
    const m = p && mocks.get(p[1]);
    if (!m) return send(404, { error: 'no such mock' });
    if (req.method === 'DELETE' && !p[2]) { await m.close(); mocks.delete(p[1]); return send(200, { ok: true }); }
    if (req.method === 'GET' && p[2] === 'requests') {
      const method = url.searchParams.get('method'), re = new RegExp(url.searchParams.get('path') ?? '.');
      return send(200, { requests: m.log.filter((r) => (!method || r.method === method) && re.test(r.path)).map(({ method: mm, path, query, at }) => ({ method: mm, path, query, at })) });
    }
    if (req.method === 'GET' && p[2] === 'seq') return send(200, { seq: m.node.store.seq });
    if (req.method === 'POST' && OPS[p[2]]) return send(200, { result: (await OPS[p[2]](m, body)) ?? null });
    send(404, { error: 'unknown op' });
  } catch (e) { send(500, { error: String(e.message) }); }
});

server.listen(Number(process.env.HITCH_MOCK_PORT ?? 0), '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ control: `http://127.0.0.1:${server.address().port}` }) + '\n');
});
const stop = async () => { for (const m of mocks.values()) await m.close(); server.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.stdin.on('end', stop); process.stdin.resume(); // exits when the parent closes our stdin
