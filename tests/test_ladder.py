"""Run from the Ladder App folder:  python -m unittest -v"""
import csv
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ladder import importer, scheduler  # noqa: E402
from ladder.store import ActionError, Store  # noqa: E402


HAVE_DATA = os.path.exists(os.path.join(importer.SOURCE, "ratings.csv"))
NEEDS_DATA = unittest.skipUnless(HAVE_DATA, "league CSVs are not in this checkout")


@NEEDS_DATA
class EngineTest(unittest.TestCase):
    def test_reproduces_published_ratings(self):
        """The imported weeks must give exactly the ratings in Ladder League/ratings.csv."""
        state = importer.build()
        with open(os.path.join(importer.SOURCE, "ratings.csv"), encoding="utf-8") as f:
            expected = {r["Player"]: int(round(float(r["DUPR"]) * 1000)) for r in csv.DictReader(f)}
        got = {p["name"]: state["ratings"]["current"][pid] for pid, p in state["players"].items()}
        self.assertEqual(len(got), 35)
        self.assertEqual(got, expected)
        totals = state["ratings"]["totals"]
        self.assertEqual(sum(t["w"] for t in totals.values()), sum(t["l"] for t in totals.values()))
        self.assertEqual(sum(t["w"] for t in totals.values()), 109 * 2)


class SchedulerTest(unittest.TestCase):
    def test_eight_is_full_whist(self):
        players = ["p%d" % i for i in range(8)]
        s = scheduler.summary(players, scheduler.generate(players, seed="x"))
        self.assertEqual((s["rounds"], s["games"]), (7, 14))
        self.assertEqual((s["partner_min"], s["partner_max"]), (1, 1))
        self.assertEqual((s["oppose_min"], s["oppose_max"]), (2, 2))
        self.assertEqual((s["each_min"], s["each_max"]), (7, 7))

    def test_other_sizes_are_valid_and_even(self):
        for n in range(4, 13):
            players = ["p%d" % i for i in range(n)]
            rounds = scheduler.generate(players, seed="y")
            for rd in rounds:
                used = [p for t1, t2 in rd for p in t1 + t2]
                self.assertEqual(len(used), len(set(used)), "player twice in a round, n=%d" % n)
                self.assertEqual(len(rd), n // 4)
            s = scheduler.summary(players, rounds)
            self.assertEqual(s["each_min"], s["each_max"], "uneven games, n=%d" % n)
            self.assertLessEqual(abs(s["each_min"] - 7), 1, "n=%d" % n)
            self.assertLessEqual(s["partner_max"] - s["partner_min"], 2, "n=%d" % n)

    def test_same_seed_same_schedule(self):
        players = ["p%d" % i for i in range(9)]
        self.assertEqual(scheduler.generate(players, seed="s1A"), scheduler.generate(players, seed="s1A"))


@NEEDS_DATA
class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        with open(os.path.join(self.tmp.name, "league.json"), "w", encoding="utf-8") as f:
            json.dump(importer.build(), f)
        self.store = Store(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def name(self, pid):
        return self.store.state["players"][pid]["name"]

    def test_full_session_flow(self):
        st = self.store
        with self.assertRaises(ActionError) as cm:
            st.apply("session.create", dict(date="2026-11-23"), org=False)
        self.assertEqual(cm.exception.code, "pin")

        sid = st.apply("session.create", dict(date="2026-11-23"), org=True)["id"]
        sess = st.state["sessions"][-1]
        self.assertEqual(len(sess["attending"]), 32)          # the 32 who played week 2
        st.apply("session.assign", dict(sid=sid), org=True)
        self.assertEqual([len(p["players"]) for p in sess["pools"]], [8, 8, 8, 8])
        ranked = sorted(sess["attending"], key=lambda p: -st.state["ratings"]["current"][p])
        self.assertEqual(set(sess["pools"][0]["players"]), set(ranked[:8]))       # Pool A is the top eight by rating
        self.assertEqual(set(sess["pools"][3]["players"]), set(ranked[24:]))

        # a new player joins and is placed by hand
        new = st.apply("player.add", dict(name="Test Newcomer", seed=3.3, sid=sid), org=True)["id"]
        with self.assertRaises(ActionError) as cm:
            st.apply("session.schedule", dict(sid=sid), org=True)
        self.assertEqual(cm.exception.code, "unassigned")
        st.apply("session.move", dict(sid=sid, pid=new, to="C"), org=True)
        self.assertEqual(len(sess["pools"][2]["players"]), 9)

        st.apply("session.start", dict(sid=sid), org=True)
        self.assertEqual(sess["status"], "live")
        pool_a = sess["pools"][0]
        self.assertEqual(sum(len(r) for r in pool_a["rounds"]), 14)

        # players enter scores without a PIN; a second, different entry is refused
        gid = pool_a["rounds"][0][0]
        st.apply("game.score", dict(sid=sid, gid=gid, s1=11, s2=6), org=False)
        with self.assertRaises(ActionError) as cm:
            st.apply("game.score", dict(sid=sid, gid=gid, s1=11, s2=4), org=False)
        self.assertEqual((cm.exception.code, cm.exception.extra), ("exists", dict(s1=11, s2=6)))
        st.apply("game.score", dict(sid=sid, gid=gid, s1=11, s2=4, replace=True), org=False)
        with self.assertRaises(ActionError):
            st.apply("game.score", dict(sid=sid, gid=gid, s1=7, s2=7, replace=True), org=False)

        # rounds: scores stay on screen until someone confirms, then the pool moves on
        self.assertEqual(pool_a["confirmed"], 0)
        with self.assertRaises(ActionError) as cm:
            st.apply("round.confirm", dict(sid=sid, pool="A", round=0), org=False)
        self.assertEqual(cm.exception.code, "scores")
        st.apply("game.score", dict(sid=sid, gid=pool_a["rounds"][0][1], s1=9, s2=11), org=False)
        with self.assertRaises(ActionError) as cm:
            st.apply("round.confirm", dict(sid=sid, pool="A", round=1), org=False)
        self.assertEqual(cm.exception.code, "order")
        self.assertEqual(st.apply("round.confirm", dict(sid=sid, pool="A", round=0), org=False)["round"], 1)
        self.assertEqual(st.apply("round.confirm", dict(sid=sid, pool="A", round=0), org=False)["round"], 1)
        self.assertEqual(pool_a["confirmed"], 1)
        with self.assertRaises(ActionError) as cm:
            st.apply("round.back", dict(sid=sid, pool="A"), org=False)       # organiser only
        self.assertEqual(cm.exception.code, "pin")
        self.assertEqual(st.apply("round.back", dict(sid=sid, pool="A"), org=True)["round"], 0)
        with self.assertRaises(ActionError) as cm:
            st.apply("round.back", dict(sid=sid, pool="A"), org=True)
        self.assertEqual(cm.exception.code, "order")
        self.assertEqual(sess["games"][pool_a["rounds"][0][1]]["status"], "done")   # scores untouched
        st.apply("round.confirm", dict(sid=sid, pool="A", round=0), org=False)

        before = dict(st.state["ratings"]["current"])
        for g in sess["games"].values():
            if g["pool"] == "A" and g["status"] == "pending":
                st.apply("game.score", dict(sid=sid, gid=g["id"], s1=11, s2=5), org=False)
        with self.assertRaises(ActionError):
            st.apply("session.close", dict(sid=sid), org=False)
        st.apply("session.close", dict(sid=sid), org=True)
        after = st.state["ratings"]["current"]
        self.assertEqual(sess["status"], "closed")
        self.assertTrue(all(after[p] != before[p] for p in pool_a["players"]))
        self.assertEqual(after[sess["pools"][1]["players"][0]], before[sess["pools"][1]["players"][0]])  # no games, no change
        self.assertEqual(st.state["ratings"]["sessions"][sid][pool_a["players"][0]]["w"]
                         + st.state["ratings"]["sessions"][sid][pool_a["players"][0]]["l"], 7)

        # closed session: players are locked out, the organiser can correct
        with self.assertRaises(ActionError) as cm:
            st.apply("game.score", dict(sid=sid, gid=gid, s1=11, s2=9, replace=True), org=False)
        self.assertEqual(cm.exception.code, "pin")
        st.apply("game.score", dict(sid=sid, gid=gid, s1=4, s2=11, replace=True), org=True)
        self.assertNotEqual(st.state["ratings"]["current"], after)

        # state survives a restart
        again = Store(self.tmp.name)
        self.assertEqual(again.state["ratings"]["current"], st.state["ratings"]["current"])

    def test_substitute_and_dropout(self):
        st = self.store
        sid = st.apply("session.create", dict(date="2026-11-23"), org=True)["id"]
        sess = st.state["sessions"][-1]
        st.apply("session.assign", dict(sid=sid), org=True)
        st.apply("session.start", dict(sid=sid), org=True)
        out = sess["pools"][3]["players"][0]
        sub = next(pid for pid, p in st.state["players"].items() if pid not in sess["attending"])
        res = st.apply("session.substitute", {"sid": sid, "out": out, "in": sub}, org=True)
        self.assertEqual(res["games"], 7)
        self.assertFalse(any(out in g["t1"] + g["t2"] for g in sess["games"].values()))
        self.assertIn(sub, sess["pools"][3]["players"])

        st.apply("player.update", dict(id=out, active=False), org=True)
        st.apply("session.delete", dict(sid=sid), org=True)
        sid2 = st.apply("session.create", dict(date="2026-11-30"), org=True)["id"]
        self.assertNotIn(out, st.state["sessions"][-1]["attending"])
        self.assertTrue(sid2)

    def test_uneven_attendance(self):
        st = self.store
        sid = st.apply("session.create", dict(date="2026-11-23"), org=True)["id"]
        sess = st.state["sessions"][-1]
        for pid in sess["attending"][:3]:
            st.apply("session.attend", dict(sid=sid, pid=pid, on=False), org=True)
        st.apply("session.assign", dict(sid=sid), org=True)
        self.assertEqual([len(p["players"]) for p in sess["pools"]], [8, 7, 7, 7])
        st.apply("session.schedule", dict(sid=sid), org=True)
        self.assertEqual(sum(len(r) for r in sess["pools"][1]["rounds"]), 14)


if __name__ == "__main__":
    unittest.main()
