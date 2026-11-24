"""hitch/1 wire primitives for Python, stdlib only (3.9+).

Mirrors conformance/lib/wire.mjs for the parts a stdlib client can do: JCS
(RFC 8785), hashes, the hmac-sha256 request signature, shownHash and answers.
It cannot verify node signatures (no Ed25519 in the stdlib); SPEC.md allows a
stdlib client to relay without verifying, and caps hmac clients at decide.
"""
import base64
import hashlib
import hmac
import json
import math
import os
import time
from decimal import Decimal

SPEC = "hitch/1"
TIERS = ["narrow", "decide", "confirm", "local"]


def tier_rank(t):
    return TIERS.index(t)


def _es_number(x):
    """Format a number exactly like ECMAScript Number.prototype.toString (JCS 3.2.2.3)."""
    if isinstance(x, bool):
        raise TypeError("bool is not a number")
    if isinstance(x, int) and abs(x) <= 2 ** 53:
        return str(x)  # exact; larger ints are doubles in JCS, as in JavaScript
    x = float(x)
    if math.isnan(x) or math.isinf(x):
        raise ValueError("jcs: non-finite number")
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    t = Decimal(repr(abs(x))).normalize().as_tuple()
    digits = "".join(map(str, t.digits))
    k = len(digits)
    n = k + t.exponent  # decimal point position, as in the ES algorithm
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    es = ("+" if e >= 0 else "-") + str(abs(e))
    return sign + digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + es


def jcs(v):
    """RFC 8785 canonical JSON, returned as str (encode as UTF-8 for hashing)."""
    if v is None or isinstance(v, bool):
        return json.dumps(v)
    if isinstance(v, (int, float)):
        return _es_number(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, (list, tuple)):
        return "[" + ",".join(jcs(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + jcs(v[k]) for k in keys) + "}"
    raise TypeError("jcs: unsupported %r" % type(v))


def sha256hex(b):
    return hashlib.sha256(b).hexdigest()


def hash_of(obj):
    return "sha256:" + sha256hex(jcs(obj).encode("utf-8"))


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def unb64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def shown_hash(d):
    return hash_of({k: d[k] for k in ("id", "rev", "title", "summary", "effect", "preview")})


def request_string(aid, method, path, body, nonce, iat):
    return "\n".join([SPEC, aid, method.upper(), path, sha256hex(body.encode("utf-8")), nonce, str(iat)])


def sign_request_hmac(cid, secret, aid, method, path, body="", nonce=None, iat=None):
    """Headers for a hitch-sig request with the hmac-sha256 suite. secret: bytes."""
    nonce = nonce or b64u(os.urandom(16))
    iat = int(time.time()) if iat is None else iat
    tag = hmac.new(secret, request_string(aid, method, path, body, nonce, iat).encode("utf-8"), hashlib.sha256).digest()
    return {"hitch-client": cid, "hitch-nonce": nonce, "hitch-iat": str(iat), "hitch-sig": b64u(tag)}


def build_answer(decision, aid, verb, text=None, iat=None, ttl=120, nonce=None):
    """A hitch.answer@1 body for the decision exactly as rendered. No presence:
    hmac clients cannot reach confirm or local, where presence is required."""
    iat = int(time.time()) if iat is None else iat
    a = {
        "decisionId": decision["id"], "aid": aid, "verb": verb, "rev": decision["rev"],
        "bindHash": decision["bind"]["hash"], "shownHash": shown_hash(decision),
        "iat": iat, "exp": iat + ttl, "nonce": nonce or b64u(os.urandom(16)),
    }
    if text is not None:
        a["text"] = text
    return a
