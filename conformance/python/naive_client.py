"""naive_client: the smallest stdlib Python client that passes the Python
client suite. The kit's self-test subject (with planted bugs), and a readable
example of the adapter for pairview. Not a UI: view() returns what a UI shows.
"""
import json
import urllib.error
import urllib.request

import hitch_wire as w


class NaiveClient:
    verifies_signatures = False  # stdlib: no Ed25519 (SPEC: hmac clients relay without verifying)

    def __init__(self, env, bugs=(), renders=()):
        self.url, self.aid = env["url"], env["aid"]
        self.cred = env["credentials"]
        self.bugs, self.renders = set(bugs), set(renders)
        self.me = "client:" + self.cred["cid"]
        self.seen = {}

    def _req(self, method, path, body=None):
        text = "" if body is None else json.dumps(body)
        h = w.sign_request_hmac(self.cred["cid"], self.cred["secret"], self.aid, method, path, text)
        h["content-type"] = "application/json"
        req = urllib.request.Request(self.url + path, data=text.encode() if method != "GET" else None, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def _fetch(self, i):
        s, b = self._req("GET", "/hitch/v1/decisions/" + i)
        if s == 200:
            self.seen[i] = b
        return self.seen.get(i)

    def _status(self, d):
        a = d.get("answered")
        if a and a.get("by") != self.me:
            return "answered-elsewhere"
        if d["state"] == "answered":
            return "applied" if "claimsDone" in self.bugs else "waiting-executor"
        if d["state"] == "resolved":
            return "answered-elsewhere" if d.get("outcome") == "resolved-elsewhere" else d.get("outcome")
        return "open"

    def sync(self):
        s, b = self._req("GET", "/hitch/v1/decisions")
        for d in b.get("list", []):
            self.seen[d["id"]] = d
        if "autoAnswer" in self.bugs:
            for d in list(self.seen.values()):
                if d["state"] == "open":
                    self.answer(d["id"], d["options"][0]["verb"])

    def view(self, i):
        d = self.seen.get(i) or self._fetch(i)
        if not d:
            return None
        rows = []
        for p in d["preview"]:
            if p.get("withheld") and "showWithheld" not in self.bugs:
                rows.append("%s: (withheld)" % p["label"])
            elif p.get("withheld"):  # planted bug: fetch and show what the node withheld
                h = w.sign_request_hmac(self.cred["cid"], self.cred["secret"], self.aid, "GET", "/hitch/v1/content/" + p["digest"])
                try:
                    with urllib.request.urlopen(urllib.request.Request(self.url + "/hitch/v1/content/" + p["digest"], headers=h)) as r:
                        rows.append("%s: %s" % (p["label"], r.read().decode()))
                except urllib.error.HTTPError:
                    rows.append("%s: ?" % p["label"])
            else:
                rows.append("%s: %s" % (p["label"], p.get("value") or p.get("digest") or ""))
        a = d.get("answered")
        who = ""
        if a:
            who = "answered on %s" % (a.get("device") or a.get("where") or a.get("by"))
            if a.get("where"):
                who += " in " + a["where"]
        return {
            "shown": True, "generic": d["kind"] not in self.renders, "status": self._status(d),
            "text": "\n".join([d["owner"], d["kind"], d["title"], d["summary"], d["effect"]] + rows + [who]),
            "options": [{"verb": o["verb"], "openElsewhere": bool(o.get("kindInput")),
                         "enabled": (not o.get("kindInput")) and ("showAll" in self.bugs or o.get("allowedForYou") is not False)}
                        for o in d["options"]],
        }

    def answer(self, i, verb, text=None):
        d = self.seen.get(i) or self._fetch(i)
        s, b = self._req("POST", "/hitch/v1/decisions/%s/answers" % i, w.build_answer(d, self.aid, verb, text))
        if s == 200:
            self.seen[i] = b
            return {"ok": True}
        code = (b or {}).get("code")
        if "retryOnStale" in self.bugs and code == "stale":
            f = self._fetch(i)
            s, b = self._req("POST", "/hitch/v1/decisions/%s/answers" % i, w.build_answer(f, self.aid, verb, text))
            if s == 200:
                self.seen[i] = b
                return {"ok": True}
        if "noRefetch" not in self.bugs and code in ("stale", "already", "withdrawn", "expired"):
            self._fetch(i)
        return {"ok": False, "code": code}

    def push(self, payload):
        if "ignorePush" not in self.bugs:
            self.sync()

    def close(self):
        pass


def make_client(env):
    return NaiveClient(env)
