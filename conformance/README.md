# hitch/1 conformance kit

Node 22+, no dependencies. Everything here tests itself: `npm test` runs the kit against an in-repo **toy node** and **naive client**, then against variants with planted bugs, and each bug must turn its check red.

| Tool | Tests | Run |
|---|---|---|
| `hitch-check` | a **node** (haystack-api), black-box over HTTP plus an adapter | `node conformance/server/hitch-check.mjs --adapter ./adapter.mjs` |
| `hitch-client-check` | a **client** (hitch-ref, Herdquarters) against `hitch-mock` | `node conformance/client/hitch-client-check.mjs --client ./adapter.mjs` |
| `hitch-catalog-check` | the `sdk:check` gate: every emitted type has a schema, every decision kind a tier at or above its floor | `node conformance/catalog-check.mjs --emitted emitted.json` |

Load: each run starts one small in-process server and finishes in about a second. Run one check with `--only <id>` or one profile with `--only decisions`.

## Server suite: writing an adapter

`hitch-check` talks to the node over HTTP for everything the wire can do. The adapter does what the wire cannot: mint credentials, request decisions as a mod, move time. Default-export the adapter, or a function returning it.

```js
export default {
  async setup() { return { url: 'http://127.0.0.1:7777' }; },  // start, or point at, a node
  async teardown() {},
  async principals() {
    return {
      mod: { token },  app: { token },  session: { token },     // Bearer credentials
      clientDecide:  { cid, key },                              // key: {suite, privateKey} (node KeyObject) or {suite:'hmac-sha256', secret}
      clientDecide2: { cid, key },                              // optional: a second decide client
      clientConfirm: { cid, key, presence: { kid, key } },      // ceiling confirm, presence key p256
      clientLocal:   { cid, key, presence: { kid, key } },      // ceiling local (loopback)
      clientHmac:    { cid, key },                              // hmac-sha256 suite
      revoked:       { cid, key },                              // active now; the suite revokes it
    };
  },
  async requestDecision({ kind, args, title, summary, expires, onExpire, defaultable, options }) { return 'dec_…'; },
  // throw an Error with .code = 'invalid' when the node refuses the request
  async editDecision(id) {},             // change the bound args: rev+1, new bind
  // optional: each check that needs one is skipped (and its profile not claimable) without it
  async executorCalls(id) { return 0; }, // how often the executor ran for this decision
  async advanceClock(ms) {},             // decision time only (expiry, attention); signature windows stay on the wall clock
  async restart() { return { url }; },   // restart the node with its store intact
  async trimEvents(n) {},                // drop the oldest n events, as retention would
  async revokeClient(cid) {},
  async issueGrant({ kinds }) { return { token }; },  // throw .code 'invalid' for a safety kind
  async publishType() { return { type: 'wins.weekly@1', data: {} }; },  // a type the `mod` principal owns
  async mintClient({ ceiling, privacy, presence }) { return { cid, key, presence?: { kid, key } }; },  // a fresh paired client
  async setFeed(name, data) {},          // publish a feed revision (kernel.connectors@1, wins.weekly@1)
};
```

The toy node's adapter, [`example/toy-adapter.mjs`](example/toy-adapter.mjs), is a working example.

**Profiles.** The output ends with `may claim: …`. A profile is claimable only when all its checks passed and none were skipped. `/.well-known/hitch` claiming more than that fails the run (`OVERCLAIMED`).

| Profile | Checks |
|---|---|
| core | discovery, sockhello, hello, unauthenticated, request-replay, lists, envelopes, sse-equals-longpoll, resume, longpoll-waits, gap, from-stamped, publish-owner-only |
| decisions | decision-signed, not-a-client, decide-answer, tier, narrow-decline, step-up, local-step-up, suite, stale, one-winner, answer-replay, answer-window, verb-offered, revoked, waits-forever, expiry-never-approves, no-safety-default, grant-safety |
| pairing | pairing-sas, pairing-impostor, pairing-commit, agent-bootstrap, pairing-approve, pairing-presence, revoke-self, revoke-other, revoke-all (always runs last: it revokes the adapter's clients) |
| feeds | feed-read, feed-changed, feed-guards |

Not yet covered: messaging, tasks, push, relay, federation, privacy classes on events, the attention ladder, and the OS-dialog bootstrap (it needs a human). 

## Client suite: writing an adapter

Each check starts a fresh `hitch-mock` (a scripted toy node with a request log), pairs a client to it, and calls your factory. The adapter drives your real client code; `view()` returns what your UI would show.

```js
export default async function ({ url, aid, nodeKey, credentials }) {
  // credentials: {cid, suite, key (KeyObject), jwk, presence?: {kid, suite, key, jwk}}
  return {
    async sync() {},                 // what the client does on start or reconnect: list, verify, store
    async view(id) {                 // null if the client does not have it
      return { shown, rejected?, generic, status, text, options: [{ verb, enabled, openElsewhere? }] };
      // status: open | waiting-executor | applied | answered-elsewhere | declined | withdrawn | expired | …
      // text: every visible string, joined (the checks search it)
    },
    async answer(id, verb, { text } = {}) { return { ok, code? }; },  // the person pressed a button
    async push(payload) {},          // optional: deliver a push wake
    async close() {},
  };
}
```

Example: [`example/naive-client.mjs`](example/naive-client.mjs). Use `--ceiling confirm --presence` to run with a confirm-ceiling client.

`hitch-mock` is also importable for a client's own tests (`hitch/mock`): `request()`, `edit()`, `withdraw()`, `resolveElsewhere()`, `answerFromOtherDevice()`, `runExecutor()`, `forgeTitle()`, `resign()`, `putContent()`, `requests(method, regex)`.

## Python stdlib client kit (pairview)

`conformance/python/` (Python 3.9+, stdlib only; needs `node` on PATH for the mock):

| File | What |
|---|---|
| `hitch_wire.py` | JCS (byte-identical to the JS kit, cross-checked in the tests), hashes, hmac-sha256 request signing, `shown_hash`, `build_answer` |
| `hitch_client_check.py` | the 12 client checks, driving `hitch-mock` through `client/hitch-mock-serve.mjs` (a loopback JSON control API) |
| `naive_client.py` | an example adapter (`make_client(env)`) and the self-test subject |

```sh
python3 conformance/python/hitch_client_check.py --client my_adapter.py   # hmac-sha256, ceiling decide
python3 -m unittest discover -s conformance/python                        # the kit's own tests
```

The adapter is the JS one in Python form; `env.credentials.secret` is the hmac secret as bytes. A stdlib client sets `verifies_signatures = False`: there is no Ed25519 in the stdlib, so `verifies-signature` is skipped (SPEC allows an hmac client to relay without verifying, and caps it at decide).

## Library

| Module | What |
|---|---|
| `lib/wire.mjs` | JCS, hashes, node signatures, request signing, `shownHash`, `buildAnswer` with presence, key helpers for ed25519, p256, hmac |
| `lib/schema.mjs` | a no-dependency validator for exactly the keywords the pack uses (it errors on any other), plus `validateEnvelope` |
| `lib/client.mjs` | a minimal signed HTTP client with SSE and long-poll |
