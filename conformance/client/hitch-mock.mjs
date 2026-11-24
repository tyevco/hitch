// hitch-mock: a scripted hitch/1 node for testing clients. It is toy-node with
// a request log, tampering, and manual executors, so a test can set up a
// situation, let the client act, and read back exactly what the client did.
//
//   const mock = await startMock({ ceiling: 'decide' });
//   const id = mock.request({ kind: 'acme.widget@1', args: {...} });
//   ... drive the client against mock.url with mock.credentials ...
//   mock.requests('POST', /answers$/)   // what the client sent
//   await mock.close();
import { createNode } from '../example/toy-node.mjs';
import { genKey, signObject, buildAnswer } from '../lib/wire.mjs';

export async function startMock({ ceiling = 'decide', suite = 'ed25519', privacy = 'text', presence = false, retention = 1000 } = {}) {
  const log = [];
  const tamper = new Map(); // decision id -> fn(obj) applied AFTER signing
  const node = createNode({
    bugs: { noExecutor: true }, retention, declaredKinds: ['acme.widget@1'],
    onRequest: (r) => log.push(r),
    onSend: (path, obj) => {
      const id = path.match(/decisions\/(dec_[0-9A-Z]+)$/)?.[1] ?? obj?.id;
      if (id && tamper.has(id)) return tamper.get(id)(structuredClone(obj));
      if (Array.isArray(obj?.list)) return { ...obj, list: obj.list.map((d) => (tamper.has(d.id) ? tamper.get(d.id)(structuredClone(d)) : d)) };
      return obj;
    },
  });
  const url = await node.listen();
  const pkey = presence ? genKey('p256') : null;
  const c = node.addClient({ suite, ceiling, privacy, device: 'client-under-test',
    presence: pkey ? [{ kid: 'pk-test', key: pkey }] : [] });
  const other = node.addClient({ ceiling: 'local', device: 'other-phone' });
  const jwk = (k) => (k.privateKey ? k.privateKey.export({ format: 'jwk' }) : { kty: 'oct', k: k.secret.toString('base64url') });
  const disc = await (await fetch(url + '/.well-known/hitch')).json();

  return {
    url, aid: node.aid, nodeKey: disc.nodeKey, node,
    credentials: { cid: c.cid, suite, key: c.key, jwk: jwk(c.key),
      ...(pkey ? { presence: { kid: 'pk-test', suite: 'p256', key: pkey, jwk: jwk(pkey) } } : {}) },
    log,
    requests: (method, re) => log.filter((r) => r.method === method && re.test(r.path)),
    clearLog: () => { log.length = 0; },
    request: (d) => node.requestDecision({ requester: 'mod:mock', ...d }),
    edit: (id) => node.editDecision(id),
    withdraw: (id) => node.withdraw(id),
    resolveElsewhere: (id, where = 'herdr') => node.resolveElsewhere(id, where),
    // another paired device answers first
    answerFromOtherDevice(id, verb = 'approve') {
      const d = node.store.decisions.get(id).d;
      const cl = node.store.clients.get(other.cid);
      return node.answerAs({ principal: `client:${other.cid}`, client: { ...cl, ceiling: 'decide' } }, id, JSON.stringify(buildAnswer(d, { aid: node.aid, verb })));
    },
    runExecutor: (id) => node.execute(id),
    // serve this decision with a body the node did not sign
    forgeTitle: (id, title = 'Something harmless') => tamper.set(id, (o) => ({ ...o, title })),
    // serve this decision signed by a different key
    resign: (id) => { const k = genKey('ed25519'); tamper.set(id, (o) => signObject(o, k, `node:${node.aid}:00000000`)); },
    clearTamper: (id) => tamper.delete(id),
    putContent: (...a) => node.putContent(...a),
    setFeed: (name, data) => node.setFeed(name, data),
    close: () => node.close(),
  };
}
