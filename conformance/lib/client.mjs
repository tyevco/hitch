// A minimal hitch/1 HTTP client used by hitch-check (and usable by clients'
// own tests): signed or bearer requests, lists, answers, SSE and long-poll.
import { signRequest, buildAnswer, verifyObject } from './wire.mjs';

// cred: {token} (bearer) | {cid, key, presence?:{kid,key}} (signed client) | null
export function connect(url, aid, cred) {
  async function req(method, path, body) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (cred?.token) headers.authorization = `Bearer ${cred.token}`;
    else if (cred?.cid) Object.assign(headers, signRequest({ cid: cred.cid, key: cred.key, aid, method, path, body: text }));
    const res = await fetch(url + path, { method, headers, body: method === 'GET' ? undefined : text });
    const raw = await res.text();
    let json; try { json = raw ? JSON.parse(raw) : null; } catch { json = { raw }; }
    return { status: res.status, body: json };
  }
  return {
    req,
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b ?? {}),
    hello: () => req('POST', '/hitch/v1/hello', { proto: 'hitch/1', client: { name: 'hitch-check', version: '1' } }),
    list: (r, q = '') => req('GET', `/hitch/v1/${r}${q}`),
    decision: (id) => req('GET', `/hitch/v1/decisions/${id}`),
    answerRaw: (id, a) => req('POST', `/hitch/v1/decisions/${id}/answers`, a),
    // fetch, then answer exactly what was fetched
    async answer(id, verb, opts = {}) {
      const d = opts.decision ?? (await req('GET', `/hitch/v1/decisions/${id}`)).body;
      const p = opts.noPresence ? undefined : cred?.presence;
      const a = buildAnswer(d, { aid: opts.aid ?? aid, verb, text: opts.text, presenceKey: p?.key, presenceKid: p?.kid, ...opts.answer });
      return req('POST', `/hitch/v1/decisions/${id}/answers`, opts.mutate ? opts.mutate(a) : a);
    },
    poll: (after, wait = 0) => req('GET', `/hitch/v1/events?after=${after}&wait=${wait}`),
    // read SSE until `until(events)` is true or timeout; returns {status, events, refusal?}
    async sse({ after, lastEventId, until = (e) => e.length > 0, timeoutMs = 3000 } = {}) {
      const path = '/hitch/v1/events' + (after != null ? `?after=${after}` : '');
      const headers = { accept: 'text/event-stream' };
      if (lastEventId != null) headers['last-event-id'] = String(lastEventId);
      if (cred?.token) headers.authorization = `Bearer ${cred.token}`;
      else if (cred?.cid) Object.assign(headers, signRequest({ cid: cred.cid, key: cred.key, aid, method: 'GET', path, body: '' }));
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const events = [], beats = [];
      try {
        const res = await fetch(url + path, { headers, signal: ac.signal });
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
          clearTimeout(timer);
          return { status: res.status, events, refusal: await res.json().catch(() => null) };
        }
        const dec = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const f = {};
            for (const line of block.split('\n')) { const m = line.match(/^(\w+): ?(.*)$/); if (m) f[m[1]] = (f[m[1]] ? f[m[1]] + '\n' : '') + m[2]; }
            if (!f.data) continue;
            const e = JSON.parse(f.data);
            if (e.type === 'hitch.beat@1') beats.push(e); else events.push({ ...e, _sseId: f.id });
          }
          if (until(events)) break;
        }
        return { status: res.status, events, beats };
      } catch (err) {
        if (err.name === 'AbortError') return { status: 200, events, beats, timedOut: true };
        throw err;
      } finally { clearTimeout(timer); ac.abort(); }
    },
  };
}

export const verifiedBy = (nodeKey) => (obj) => verifyObject(obj, { suite: nodeKey.suite, pub: nodeKey.x });
