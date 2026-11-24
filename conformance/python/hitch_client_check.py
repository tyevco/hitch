"""hitch-client-check for Python clients (stdlib only, 3.9+).

The same client checks as conformance/client/checks.mjs, run against
hitch-mock through hitch-mock-serve (needs `node` on PATH). Default mock:
an hmac-sha256 client at ceiling decide, which is what pairview pairs as.

    python3 conformance/python/hitch_client_check.py --client my_adapter.py

my_adapter.py defines `make_client(env)` returning an object with:
    verifies_signatures: bool        # False for a stdlib client (no Ed25519)
    sync()                           # list and store decisions, as on start or reconnect
    view(id) -> dict | None          # {shown, rejected?, generic, status, text, options:[{verb, enabled, openElsewhere?}]}
    answer(id, verb, text=None) -> dict   # {ok, code?}: the person pressed a button
    push(payload)                    # optional: a push wake
    close()
env = {url, aid, nodeKey, credentials: {cid, suite, secret (bytes) | jwk, presence?}}
"""
import importlib.util
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVE = os.path.join(HERE, "..", "client", "hitch-mock-serve.mjs")


class Skip(Exception):
    pass


def _http(method, url, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


class MockServer:
    """One hitch-mock-serve process; each check gets a fresh mock from it."""

    def __init__(self):
        self.proc = subprocess.Popen(["node", SERVE], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.control = json.loads(self.proc.stdout.readline())["control"]

    def new(self, **opts):
        return Mock(self.control, _http("POST", self.control + "/mocks", opts))

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


class Mock:
    def __init__(self, control, info):
        self.base = "%s/mocks/%s" % (control, info["id"])
        self.url, self.aid, self.node_key = info["url"], info["aid"], info["nodeKey"]
        c = dict(info["credentials"])
        if "secret" in c:
            c["secret"] = __import__("hitch_wire").unb64u(c["secret"])
        self.credentials = c

    def op(self, name, **args):
        return _http("POST", "%s/%s" % (self.base, name), args)["result"]

    def request(self, **d):
        return self.op("request", **d)

    def requests(self, method, path_re):
        q = urllib.parse.urlencode({"method": method, "path": path_re})
        return _http("GET", "%s/requests?%s" % (self.base, q))["requests"]

    def close(self):
        _http("DELETE", self.base)


PLAIN = {"kind": "wins.confirm@1", "args": {"win": "w1", "title": "Shipped hitch-check"},
         "title": "Log win: shipped hitch-check", "summary": "From the Friday sweep"}
SEND = {"kind": "outbox.send@1", "args": {"channel": "teams", "to": "Dana", "body": {"content": "sha256:" + "0" * 64, "bytes": 0}, "send": {"body": {"content": "sha256:" + "0" * 64, "bytes": 0}, "path": "/chats/19:x/messages"}}, "title": "Send reply to Dana", "summary": "Re: Q4 plan"}


def _opt(v, verb):
    return next((o for o in v["options"] if o["verb"] == verb), None)


# ---- checks: each takes (mock, client) and raises AssertionError or Skip ----

def generic_unknown_kind(m, c):
    i = m.request(kind="acme.widget@1", args={"colour": "teal"}, title="Paint the widget", summary="acme wants this",
                  options=[{"verb": "approve", "label": "Paint"}, {"verb": "decline", "label": "No"}])
    m.op("setTier", id=i, verb="approve", tier="decide")
    c.sync()
    v = c.view(i)
    assert v and v["shown"], "shown"
    assert v["generic"] is True, "rendered with the generic renderer"
    for s in ("Paint the widget", "acme.widget@1 with 1 bound argument(s)", "colour", "teal"):
        assert s in v["text"], 'shows "%s"' % s
    assert sorted(o["verb"] for o in v["options"]) == ["approve", "decline"]


def never_auto_answers(m, c):
    ids = [m.request(**PLAIN), m.request(**SEND)]
    c.sync()
    for i in ids:
        c.view(i)
    time.sleep(0.3)
    c.sync()
    assert not m.requests("POST", r"/answers$"), "no answers sent without a press"


def hides_above_ceiling(m, c):
    i = m.request(**SEND)
    c.sync()
    v = c.view(i)
    ap = _opt(v, "approve")
    assert ap is None or ap["enabled"] is False, "approve (confirm) hidden or disabled"
    assert (_opt(v, "decline") or {}).get("enabled") is True, "decline stays available"


def verifies_signature(m, c):
    if not getattr(c, "verifies_signatures", True):
        raise Skip("client declares it cannot verify node signatures (stdlib, no Ed25519; allowed for hmac clients)")
    a, b = m.request(**PLAIN), m.request(**PLAIN)
    m.op("forgeTitle", id=a)
    m.op("resign", id=b)
    c.sync()
    for i in (a, b):
        v = c.view(i)
        assert not (v and v["shown"]) or v.get("rejected"), "forged body rejected"
    assert not c.answer(a, "approve").get("ok"), "cannot answer what it rejected"


def answer_accepted(m, c):
    i = m.request(**PLAIN)
    c.sync()
    c.view(i)
    r = c.answer(i, "approve")
    assert r.get("ok") is True, "answer refused: %s" % r.get("code")
    assert len(m.requests("POST", r"/answers$")) == 1
    assert m.op("state", id=i)["state"] == "answered"


def refetch_on_stale(m, c):
    i = m.request(**PLAIN)
    c.sync()
    c.view(i)
    m.op("edit", id=i)
    m.op("clearLog")
    r = c.answer(i, "approve")
    assert r.get("ok") is False and r.get("code") == "stale", r
    time.sleep(0.1)
    log = m.requests("", ".")  # every request, in order
    posts = [k for k, x in enumerate(log) if x["method"] == "POST" and x["path"].endswith("/answers")]
    assert len(posts) == 1, "exactly one POST: no silent retry"
    assert any(x["method"] == "GET" and "/decisions" in x["path"] for x in log[posts[0] + 1:]), "GET after stale"
    assert "edited" in c.view(i)["text"], "shows the edited preview"


def already_shows_winner(m, c):
    i = m.request(**PLAIN)
    c.sync()
    c.view(i)
    m.op("answerFromOtherDevice", id=i)
    r = c.answer(i, "approve")
    assert r.get("ok") is False and r.get("code") == "already", r
    v = c.view(i)
    assert v["status"] == "answered-elsewhere"
    assert "other-phone" in v["text"], "names the winning device"


def resolved_elsewhere(m, c):
    i = m.request(**PLAIN)
    m.op("resolveElsewhere", id=i, where="herdr")
    c.sync()
    v = c.view(i)
    assert v["status"] == "answered-elsewhere"
    assert "herdr" in v["text"]


def waiting_for_executor(m, c):
    i = m.request(**PLAIN)
    c.sync()
    c.view(i)
    assert c.answer(i, "approve").get("ok") is True
    c.sync()
    assert c.view(i)["status"] == "waiting-executor"
    m.op("runExecutor", id=i)
    c.sync()
    assert c.view(i)["status"] == "applied"


def withheld(m, c):
    ct = m.op("putContent", text="TOP SECRET BODY", type="text/plain", privacy="secret")
    i = m.request(preview=[{"label": "To", "value": "dana@example.com"},
                           {"label": "Body", "withheld": True, "digest": ct["hash"], "bytes": ct["bytes"]}], **PLAIN)
    c.sync()
    v = c.view(i)
    assert "Body" in v["text"], "the row label is shown"
    assert "TOP SECRET" not in v["text"], "withheld text not shown"
    assert not m.requests("GET", r"/content/"), "withheld content not fetched"


def push_relists(m, c):
    if not hasattr(c, "push"):
        raise Skip("client has no push")
    c.sync()
    m.op("clearLog")
    m.request(**PLAIN)
    c.push({"head": m.op("seq"), "counts": {"decisions": 1}, "kinds": ["wins.confirm@1"]})
    assert m.requests("GET", r"^/hitch/v1/decisions$"), "GET /hitch/v1/decisions after the wake"


def kind_input(m, c):
    i = m.request(kind="acme.widget@1", args={}, options=[{"verb": "configure", "label": "Configure", "kindInput": True}, {"verb": "decline"}])
    m.op("setTier", id=i, verb="configure", tier="decide")
    c.sync()
    o = _opt(c.view(i), "configure")
    assert o is None or o["enabled"] is False or o.get("openElsewhere") is True, "not a plain button"


CHECKS = [
    ("generic-unknown-kind", generic_unknown_kind), ("never-auto-answers", never_auto_answers),
    ("hides-above-ceiling", hides_above_ceiling), ("verifies-signature", verifies_signature),
    ("answer-accepted", answer_accepted), ("refetch-on-stale", refetch_on_stale),
    ("already-shows-winner", already_shows_winner), ("resolved-elsewhere", resolved_elsewhere),
    ("waiting-for-executor", waiting_for_executor), ("withheld", withheld),
    ("push-relists", push_relists), ("kind-input", kind_input),
]


def run_client_checks(make_client, only=None, log=print, mock_options=None):
    opts = {"suite": "hmac-sha256", "ceiling": "decide"}
    opts.update(mock_options or {})
    server = MockServer()
    results = []
    try:
        for cid, fn in CHECKS:
            if only and cid not in only:
                continue
            m = server.new(**opts)
            client = None
            try:
                client = make_client({"url": m.url, "aid": m.aid, "nodeKey": m.node_key, "credentials": m.credentials})
                fn(m, client)
                results.append({"id": cid, "status": "pass"})
                log("✓ " + cid)
            except Skip as e:
                results.append({"id": cid, "status": "skip", "why": str(e)})
                log("- %s: skipped (%s)" % (cid, e))
            except Exception as e:  # AssertionError, or the client crashed
                results.append({"id": cid, "status": "fail", "error": "%s: %s" % (type(e).__name__, e)})
                log("✗ %s\n    %s: %s" % (cid, type(e).__name__, e))
            finally:
                if client is not None and hasattr(client, "close"):
                    client.close()
                m.close()
    finally:
        server.close()
    return results


def main(argv):
    if "--client" not in argv:
        print("usage: hitch_client_check.py --client adapter.py [--only id,id] [--suite hmac-sha256|ed25519]", file=sys.stderr)
        return 2
    path = argv[argv.index("--client") + 1]
    spec = importlib.util.spec_from_file_location("hitch_client_adapter", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    only = argv[argv.index("--only") + 1].split(",") if "--only" in argv else None
    suite = argv[argv.index("--suite") + 1] if "--suite" in argv else "hmac-sha256"
    r = run_client_checks(mod.make_client, only=only, mock_options={"suite": suite})
    n = lambda s: sum(1 for x in r if x["status"] == s)
    print("\nclient suite: %d✓ %d✗ %d-" % (n("pass"), n("fail"), n("skip")))
    return 1 if n("fail") else 0


sys.path.insert(0, HERE)
if __name__ == "__main__":
    sys.exit(main(sys.argv))
