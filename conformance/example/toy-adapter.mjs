// hitch-check adapter for toy-node. Copy this shape for a real node: see
// conformance/README.md "Writing an adapter". bugs: flags that break the toy
// on purpose, so the kit's own tests can prove each check catches its fault.
import { createNode, createStore } from './toy-node.mjs';
import { genKey } from '../lib/wire.mjs';

export function toyAdapter({ bugs = {} } = {}) {
  const store = createStore();
  const clock = { offset: 0, now() { return Date.now() + this.offset; } };
  const nodeKey = genKey('ed25519');
  let node, P;
  const wrap = (f) => async (...a) => { try { return f(...a); } catch (e) { throw Object.assign(new Error(e.code ?? e.message), { code: e.code }); } };
  async function start() { node = createNode({ store, clock, nodeKey, bugs }); return { url: await node.listen() }; }
  return {
    async setup() {
      const env = await start();
      const pk = (kid) => ({ kid, key: genKey('p256') });
      const confirmP = pk('pk-confirm'), localP = pk('pk-local');
      const mk = (o, presence) => { const c = node.addClient({ ...o, presence: presence ? [presence] : [] }); return { ...c, ...(presence ? { presence } : {}) }; };
      P = {
        mod: { token: node.addToken('mod:wins', { owner: 'wins' }) },
        app: { token: node.addToken('app:herdr-teams', { owner: 'herdr-teams' }) },
        session: { sid: 's-test', token: node.addToken('session:s-test', { owner: 'session' }) },
        session2: { sid: 's-other', token: node.addToken('session:s-other', { owner: 'session' }) },
        clientDecide: mk({ ceiling: 'decide' }),
        clientDecide2: mk({ ceiling: 'decide', device: 'phone' }),
        clientConfirm: mk({ ceiling: 'confirm', suite: 'p256' }, confirmP),
        clientLocal: mk({ ceiling: 'local', suite: 'p256' }, localP),
        clientHmac: mk({ ceiling: 'decide', suite: 'hmac-sha256' }),
        revoked: mk({ ceiling: 'decide' }),
      };
      return env;
    },
    async teardown() { await node.close(); },
    principals: async () => P,
    requestDecision: wrap((d) => node.requestDecision({ requester: 'mod:test', ...d })),
    editDecision: wrap((id) => node.editDecision(id)),
    executorCalls: async (id) => node.executorCalls(id),
    advanceClock: async (ms) => { clock.offset += ms; },
    async restart() { await node.close(); return start(); },
    trimEvents: async (n) => node.trim(n),
    revokeClient: async (cid) => node.revokeClient(cid),
    issueGrant: wrap(({ kinds }) => ({ token: node.issueGrant({ kinds }) })),
    mintClient: async ({ ceiling = 'decide', privacy = 'text', presence = false } = {}) => {
      const pr = presence ? { kid: 'pk-' + Math.random().toString(36).slice(2, 8), key: genKey('p256') } : null;
      const c = node.addClient({ ceiling, privacy, suite: pr ? 'p256' : 'ed25519', presence: pr ? [pr] : [] });
      return { ...c, ...(pr ? { presence: pr } : {}) };
    },
    setFeed: async (name, data) => node.setFeed(name, data),
    putItem: async (it) => node.putItem(it),
    enablePersonTestOps: async () => node.enablePersonTestOps(),
    crashNextExecution: async () => node.crashNextExecution(),
    publishType: async () => ({ type: 'wins.weekly@1', data: { week: '2026-11-16', wins: [] } }),
  };
}
