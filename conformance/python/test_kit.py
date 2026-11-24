"""Self-tests for the Python kit: python3 -m unittest discover -s conformance/python"""
import json
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hitch_wire as w  # noqa: E402
from hitch_client_check import run_client_checks  # noqa: E402
from naive_client import NaiveClient  # noqa: E402

WIRE_MJS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib", "wire.mjs")
VECTORS = [{}, {"hello": "hitch"}, {"b": 1, "a": [True, None, "x"], "c": {"z": 1e21, "y": 0.1}},
           {"€": 1, "a": 2, "B": 3, "\U0001F600": 4, "｡": 5}, [1e-7, 123.456, -0.0, 1e20, 5e-324, 2 ** 60, 0.000001, 1.5e-6, 1e300],
           {"s": "tab\tnl\nq\"bs\\ctl\x1f é"}]
QUIET = lambda *a: None  # noqa: E731


class Wire(unittest.TestCase):
    def test_jcs_and_hashes_match_the_node_kit(self):
        js = "import('%s').then(w=>{const v=JSON.parse(process.argv[1]);console.log(JSON.stringify(v.map(x=>[w.jcs(x),w.hashOf(x)])))})" % WIRE_MJS.replace("\\", "/")
        out = json.loads(subprocess.check_output(["node", "-e", js, json.dumps(VECTORS)], text=True))
        for v, (j, h) in zip(VECTORS, out):
            self.assertEqual(w.jcs(v), j)
            self.assertEqual(w.hash_of(v), h)

    def test_request_string_and_hmac(self):
        s = w.request_string("node01", "post", "/hitch/v1/x?a=1", "{}", "n", 1)
        self.assertEqual(s, "hitch/1\nnode01\nPOST\n/hitch/v1/x?a=1\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\nn\n1")
        h = w.sign_request_hmac("c_1", b"k" * 32, "node01", "POST", "/hitch/v1/x?a=1", "{}", "n", 1)
        self.assertEqual(set(h), {"hitch-client", "hitch-nonce", "hitch-iat", "hitch-sig"})


class ClientSuite(unittest.TestCase):
    def test_naive_client_passes(self):
        r = run_client_checks(lambda env: NaiveClient(env), log=QUIET)
        self.assertEqual([x for x in r if x["status"] == "fail"], [])
        self.assertEqual([x["id"] for x in r if x["status"] == "skip"], ["verifies-signature"])

    def test_planted_bugs_are_caught(self):
        planted = {"autoAnswer": ["never-auto-answers"], "showAll": ["hides-above-ceiling"],
                   "retryOnStale": ["refetch-on-stale"], "noRefetch": ["refetch-on-stale", "already-shows-winner"],
                   "claimsDone": ["waiting-for-executor"], "showWithheld": ["withheld"], "ignorePush": ["push-relists"]}
        for bug, ids in planted.items():
            with self.subTest(bug=bug):
                r = run_client_checks(lambda env: NaiveClient(env, bugs=[bug]), only=ids, log=QUIET)
                self.assertEqual({x["id"]: x["status"] for x in r}, {i: "fail" for i in ids})


if __name__ == "__main__":
    unittest.main()
