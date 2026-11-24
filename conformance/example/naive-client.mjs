// naive-client: the smallest client that passes the client suite. It is the
// kit's self-test subject (with planted bugs) and a readable example of the
// client-adapter interface. Not a UI: view() returns what a UI would show.
import { connect, verifiedBy } from '../lib/client.mjs';
import { buildAnswer, tierRank } from '../lib/wire.mjs';

export function naiveClient(env, { bugs = {}, renders = [] } = {}) {
  const { url, aid, nodeKey, credentials: cred } = env;
  const api = connect(url, aid, cred);
  const verify = verifiedBy(nodeKey);
  const me = `client:${cred.cid}`;
  const seen = new Map(); // id -> {d, ok}
  const keep = (d) => seen.set(d.id, { d, ok: bugs.noVerify ? true : verify(d) });

  async function fetchOne(id) { const r = await api.decision(id); if (r.status === 200) keep(r.body); return seen.get(id); }

  function status(d) {
    if (d.answered && d.answered.by !== me) return 'answered-elsewhere';
    if (d.state === 'answered') return bugs.claimsDone ? 'applied' : 'waiting-executor';
    if (d.state === 'resolved') return d.outcome === 'resolved-elsewhere' ? 'answered-elsewhere' : d.outcome;
    return 'open';
  }

  return {
    async sync() {
      const r = await api.list('decisions');
      for (const d of r.body.list ?? []) keep(d);
      if (bugs.autoAnswer) for (const { d } of seen.values()) if (d.state === 'open') await this.answer(d.id, d.options[0].verb);
    },
    async view(id) {
      const s = seen.get(id) ?? await fetchOne(id);
      if (!s) return null;
      if (!s.ok) return { shown: false, rejected: true };
      const d = s.d;
      const rows = d.preview.map((p) => `${p.label}: ${p.withheld && !bugs.showWithheld ? '(withheld)' : p.value ?? p.digest ?? ''}`);
      if (bugs.showWithheld) for (const p of d.preview.filter((x) => x.withheld && x.digest)) rows.push(await (await fetch(`${url}/hitch/v1/content/${p.digest}`)).text());
      const who = d.answered ? `answered on ${d.answered.device ?? d.answered.where ?? d.answered.by}${d.answered.where ? ` in ${d.answered.where}` : ''}` : '';
      return {
        shown: true, generic: !renders.includes(d.kind), status: status(d),
        text: [d.owner, d.kind, d.title, d.summary, d.effect, ...rows, who].join('\n'),
        options: d.options.map((o) => ({ verb: o.verb, label: o.label, openElsewhere: !!o.kindInput,
          enabled: !o.kindInput && (bugs.showAll ? true : o.allowedForYou !== false) })),
      };
    },
    async answer(id, verb, { text } = {}) {
      const s = seen.get(id) ?? await fetchOne(id);
      if (!s?.ok) return { ok: false, code: 'unverified' };
      const opt = s.d.options.find((o) => o.verb === verb);
      const p = opt && tierRank(opt.tier) >= tierRank('confirm') ? cred.presence : undefined;
      const a = buildAnswer(s.d, { aid, verb, text, presenceKey: p?.key, presenceKid: p?.kid });
      let r = await api.answerRaw(id, a);
      if (r.status === 200) { keep(r.body); return { ok: true }; }
      if (bugs.retryOnStale && r.body?.code === 'stale') {
        const f = await fetchOne(id);
        r = await api.answerRaw(id, buildAnswer(f.d, { aid, verb, text }));
        if (r.status === 200) { keep(r.body); return { ok: true }; }
      }
      if (!bugs.noRefetch && ['stale', 'already', 'withdrawn', 'expired'].includes(r.body?.code)) await fetchOne(id);
      return { ok: false, code: r.body?.code };
    },
    async push() { if (!bugs.ignorePush) await this.sync(); },
    async close() {},
  };
}
