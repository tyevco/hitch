# Haystack adapter guide: getting haystack-kernel through hitch-check

For the engineers adding `/hitch/v1` to `claude-extended-v2/haystack-kernel` (migration phases P1 to P3). It covers what to build in which order, how to write the conformance adapter, where each hook sits in today's v2 code, and the traps the reference client already found.

## The loop

```sh
# from the hitch repo, against your adapter in haystack-kernel
node conformance/server/hitch-check.mjs --adapter ../claude-extended-v2/haystack-kernel/daemon/hitch/adapter.mjs --only core
```

- **Load: one check or one profile at a time** (`--only discovery` or `--only core`). Each run starts one daemon; never run the daemon's full test suite alongside it.
- A profile counts only when **all** its checks pass with **none skipped**. `/.well-known/hitch` must list only those, or the run fails with `OVERCLAIMED`.
- Before writing route code, read `example/toy-node.mjs`. It is about 500 lines, in-memory, and passes every check; the order of checks inside its `answer()` is the normative refusal order.

## Build order

| Phase | Profile to turn green | Routes | Adapter hooks it needs |
|---|---|---|---|
| **P1** | `core` | first add the **node key** and **clock** seams (below); then `/.well-known/hitch`, `sockhello`, `hello`, `nonce`, the five lists, `events` (SSE + long-poll), `publish` | `setup`, `teardown`, `principals` (mod, app, session, session2, clientDecide), `requestDecision` (to make events), `trimEvents`, `publishType` |
| **P1** | `feeds` | `GET /hitch/v1/feeds/:feed` | `setFeed`, `mintClient` |
| **P2** | `pairing` | `clients/pairings` (commit, reveal, status), `clients/:cid/revoke`, `clients/revoke-all` | `mintClient`, `principals` (clientConfirm, clientLocal with presence keys), `revokeClient` |
| **P3** | `decisions` | `GET decisions/:id`, `POST …/answers`, `GET …/audit` | `editDecision`, `executorCalls`, `advanceClock`, `restart`, `issueGrant` |
| P3+ | `messaging` | `POST /messages`, `POST /messages/:id/state` | `principals.session2` |

P2 cannot finish before P3's answer route exists, because pairing approval is a `hitch.client.pair@1` decision answered at the local tier. Build the answer route's skeleton (the refusal funnel) in P2 and finish it in P3.

## Writing the adapter

The adapter is **test-only code**. Keep it outside the shipped bundle (for example `daemon/hitch/adapter.mjs`, excluded by `bundle/`) and never let a route reach its hooks. Its whole job is to reach inside the daemon and do what a mod, the OS dialog or time would do.

| Hook | Must do | Must not do |
|---|---|---|
| `setup()` | start the daemon in-process on a free loopback port with a temp state dir; return `{url}` | reuse Tyler's real state dir or `daemon.sock` |
| `principals()` | mint credentials directly in the stores: a cx/1 hello token per mod, an app principal, two sessions `{sid, token}`, clients with real keys (`wire.genKey`) | mint through HTTP routes that real agents could call |
| `requestDecision(d)` | call the same internal function a mod's gate calls, as `mod:<owner>`; on refusal throw `Object.assign(new Error(code), {code})` | write the decision store directly (that skips the floor, bind and safety checks under test) |
| `advanceClock(ms)` | move **decision time** only (expiry, attention) | move the signature windows: `iat`/`exp` checks stay on the wall clock, or every signed request after the jump is refused |
| `restart()` | stop and start the daemon on the **same** state dir; return the new `{url}` if the port changed | keep in-memory state across the restart (the expiry check exists to prove persistence) |
| `executorCalls(id)` | count real executor invocations for the decision's action | infer from state: an executor that ran and failed still counts |
| `trimEvents(n)` | drop the oldest `n` events as retention would, moving the gap floor | delete decisions (they are never compacted) |
| `issueGrant({kinds})` | create the grant through the same path a `hitch.grant.issue@1` outcome uses; throw `invalid` for a safety kind | bypass the safety-kind refusal |

A full annotated adapter is in [README.md](README.md#server-suite-writing-an-adapter); `example/toy-adapter.mjs` is a working one.

## Where each hook lives in v2

Read from `claude-extended-v2/haystack-kernel/daemon` at `39fbe4a6`. The paths are relative to `daemon/`.

| Hook | Reuse | Gap to close |
|---|---|---|
| `setup` / `teardown` | The spawn pattern in `actions.test.mjs:31-160`: `mkdtempSync`, `installFirstParty` (`registry.fixture.mjs:20`), then `spawn(server.mjs)` with `WATCHTOWER_DIR`, `WATCHTOWER_SOCKET`, `CLAUDE_CONFIG_DIR`, `WATCHTOWER_TERMINAL=0`, polling `/health`. `hubcaller.fixture.mjs` is the model for calling route functions in-process | `createKernel()` (`kernel/kernel.mjs:50`) takes no arguments, so boot runs out-of-process through env |
| mod token | `kernel/registry.mjs:445 hello()` → `:362 grant()` (48 hex, sha256 kept). First-party mods are installed with `installFirstParty` | A third-party mod needs `decide()` (`:499`) first |
| app principal | none | **new**: `app:<id>` with scope `publish+request+execute:<owner>` (SPEC Principals) |
| session `{sid, token}` | `kernel/sessions.mjs:84 createSessions` tracks sessions only | **new**: a session credential distinct from its mod's token, or a stamped `session:<sid>` on the mod hello |
| paired client | Structure to copy: `kernel/pairing.mjs:122 createPairing` (`ask` :184, `reveal` :231, `decide` :291, `verify` :397, `revoke` :458) and its spent-nonce set (:76). Presence: `lan/webauthn.mjs:325 verifyAssertion`. Test key: `lan/webauthn-soft.test-helper.mjs:51 softAuthenticator` | **new record shape**: suite, ceiling, privacy, scopes and presence keys. v2 pairs mods with X25519 and a different code (`pairCode` :92, a uint32 over a `cx-pair2` string). Hitch's commit, SAS (which includes the node key) and request signature are new; do not reuse `pairCode` |
| `requestDecision` | The gate path today: `POST /v1/inbox` → `kernel/inbox-feeds.mjs:164 publish()`; a press goes to `kernel/services/actions.mjs:26 webAction()`, which runs the gate and appends to `state.actions`. Tier table: `lan/tiers.mjs:23 LAN_TIER`, `:183 gate()` | **new**: a durable decision store. Inside it, `bindHash` = sha256 over JCS({kind, args}). Today's `contentSig` (`inbox.mjs:910`) is a 32-bit FNV over display text; it is not a bind |
| `editDecision` | republish through `inbox-feeds.publish` | `rev` and a new bind; answers on an old `rev` give `stale` |
| `executorCalls` | `state.actions[].claimedBy/status/result` (`kernel/routes/actions.mjs:36-66`) | **new**: an append-only executor log. `state.actions` keeps only its last 200 entries (`services/actions.mjs:243`) and records no calls |
| `advanceClock` | The factories already take `now`: `createRegistry`, `createPairing`, `createBus`, `createFeeds`, `createTickets`, `nonceStore`, `createLimiter`, `gate()` | Services call `Date.now()` directly (about 124 calls). Give the decision store's clock one seam, e.g. a `WATCHTOWER_HITCH_CLOCK_OFFSET` knob read through `knob()` (`kernel/legacy-ids.mjs:109`) and honoured **only** when the adapter's test flag is set |
| `restart` | `kernel/state.mjs:150 readState` and `:228 writeState`; respawn with the same `WATCHTOWER_DIR` | Hello tokens, `mem` pairings and LAN sessions do not survive a restart, so re-mint in `principals()` after `restart()` (the runner calls it again) |
| `trimEvents` | `kernel/bus.mjs:42 KEEP = 500`; `createBus` :71, `publish` :121 (`++seq`), `read({after})` :183 | Either publish 501 events, or add a test-only trim. The `gap` floor must be the oldest kept seq |
| `revokeClient` | `pairing.revoke` :458, `lanSessions.signOut`, `passkeys.remove` (`lan/webauthn.mjs:499`) | **new**: one revoke across every credential kind |
| `issueGrant` | none: the hub grants in `kernel/hub/policy.mjs` are delivery grants, a different concept | **new** grant store; its first rule refuses safety kinds |
| `publishType` / `setFeed` | `bus.publishAs` :145 with `TOPIC` (`bus.mjs:47`, already `owner.name@N`). Feeds: `POST /v1/feeds` → `kernel/feeds.mjs:101 write()`, `read` :132 | Feeds need `rev` and node signing on read |
| node key | `kernel/hub/link.mjs` has an Ed25519 device key, but only after a hub join, kept in the OS secret store | **new**: an always-present Ed25519 node key with a test override; `/.well-known/hitch` publishes it. `aid` (`proto/aid.mjs:90`) is a hash, not a key |
| nonces, rate limits | `nonces.mjs:17 nonceStore` (single use, but keyed on item and verb), `ratelimit.mjs:28 createLimiter` | Request nonces are keyed on `(cid, nonce)`, answer nonces on `nonce`, within 120 s |

**Seams to add before any check can pass.** Hitch has a fixed point for each of these and none exists in v2:

1. A **node key** (Ed25519, always present, test-overridable).
2. A **decision-time clock seam**.
3. A **durable decision store** with `rev`, `bindHash` and an append-only audit.
4. A **client model** with suite, ceiling, privacy, scopes and presence keys, plus one revoke.
5. An **executor call log**.

## Traps the reference client already hit

| Trap | Rule |
|---|---|
| SSE vs long-poll on one route | `Accept: text/event-stream` selects SSE; otherwise JSON long-poll. Resume with `Last-Event-ID` **or** `?after=` |
| Feed names | `@` in `/hitch/v1/feeds/wins.weekly@1` is sent raw, not `%40`; accept both |
| List shape | `{spec, resource, list, cursor}`: `resource` is the plural route name, and `cursor` is the event seq the list is consistent with |
| Decision state | `state` (`open`/`answered`/`resolved`) and `outcome` are separate fields; `answered` + `action.state: queued` is "waiting for executor", never done |
| Signed request path | the signed string uses the path **with** its query string, exactly as sent |
| Advancing time | see `advanceClock` above |
| `from` in bodies | ignored and overwritten, never refused |
| Redacted events | re-sign after replacing `data` with `{withheld: true}`, or clients reject them as forged |
| Pairing SAS | includes the node key `x`; the node computes it over its own real key |
| `revoke-all` | revokes the caller too; the check runs last because it kills the adapter's clients |

## Done means

```sh
node conformance/server/hitch-check.mjs --adapter <adapter> --json > hitch-check.json
```

`claimable` lists every profile `/.well-known/hitch` claims, and `overclaimed` is empty. Then `hitch-catalog-check --emitted` over the daemon's emitted topics and decision kinds (the `sdk:check` gate) exits 0.
