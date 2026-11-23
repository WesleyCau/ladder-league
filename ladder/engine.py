"""Rating engine: Sharks per-game formula, averaged over every order of a session's rounds.

Ported from Ladder League/ladder_4dr.py. All ratings are integers in thousandths (3700 = 3.700).

Per game:
  win prob = 1 / (1 + e^(-K_PROB * (winners' avg - losers' avg)))
  Elo term = round(0.100 * (1 - win prob), 3)      winners gain it, losers lose it
  bonus    = winners +(W - L)/1000, losers +L/1000
Per session, per pool: replay the rounds in every possible order and average the end ratings,
so a result is worth the same whenever in the night it was played.
"""
import itertools
import math

K_ELO = 100
K_PROB = 8.988
MAX_EXACT_ROUNDS = 9      # 9! = 362,880 orders; beyond that, sample. Must match docs/core.js
SAMPLE_ORDERS = 20000

_cache = {}


def rnd(x):
    return math.floor(x + 0.5)


_M = 0xFFFFFFFF


def _rng(seed):
    """The website's seeded generator (rng in docs/core.js), bit for bit, so both engines sample the same orders."""
    h = (1779033703 ^ len(seed)) & _M
    for ch in seed:
        h = ((h ^ ord(ch)) * 3432918353) & _M
        h = ((h << 13) | (h >> 19)) & _M
    state = [h]

    def rand():
        a = state[0] = (state[0] + 0x6D2B79F5) & _M
        t = ((a ^ (a >> 15)) * (1 | a)) & _M
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & _M)) & _M) ^ t
        return ((t ^ (t >> 14)) & _M) / 4294967296
    return rand


def _sampled_orders(n):
    rand, order = _rng("orders-%d" % n), list(range(n))
    for _ in range(SAMPLE_ORDERS):
        for i in range(n - 1, 0, -1):          # the same shuffle, carried on from the previous order
            j = int(rand() * (i + 1))
            order[i], order[j] = order[j], order[i]
        yield order


def all_orders(start, rounds):
    """start: {pid: rating}. rounds: [[(gid, win_pair, lose_pair, ws, ls), ...], ...].

    Returns ({pid: mean end rating}, {gid: (mean winners' prob, mean winners' change, mean losers' change)})."""
    players = sorted({p for rd in rounds for g in rd for p in g[1] + g[2]})
    key = (tuple((p, start[p]) for p in players), tuple(tuple(rd) for rd in rounds))
    if key in _cache:
        return _cache[key]
    idx = {p: i for i, p in enumerate(players)}
    base = [start[p] for p in players]
    rds = [[(k, idx[g[1][0]], idx[g[1][1]], idx[g[2][0]], idx[g[2][1]], g[3], g[4]) for k, g in enumerate(rd)] for rd in rounds]
    sums = [[[0.0, 0.0, 0.0] for _ in rd] for rd in rounds]
    total = [0.0] * len(players)
    if len(rounds) <= MAX_EXACT_ROUNDS:
        orders = itertools.permutations(range(len(rounds)))
    else:
        orders = _sampled_orders(len(rounds))
    n = 0
    exp = math.exp
    for order in orders:
        r = base[:]
        for i in order:
            acc = sums[i]
            for k, a, b, c, d, ws, ls in rds[i]:
                prob = 1 / (1 + exp(-K_PROB * (r[a] + r[b] - r[c] - r[d]) / 2000))
                elo = math.floor(K_ELO * (1 - prob) + 0.5)
                dw, dl = elo + ws - ls, ls - elo
                r[a] += dw
                r[b] += dw
                r[c] += dl
                r[d] += dl
                s = acc[k]
                s[0] += prob
                s[1] += dw
                s[2] += dl
        for j, v in enumerate(r):
            total[j] += v
        n += 1
    ends = {p: total[idx[p]] / n for p in players}
    games = {g[0]: tuple(v / n for v in sums[i][k]) for i, rd in enumerate(rounds) for k, g in enumerate(rd)}
    if len(_cache) > 400:
        _cache.clear()
    _cache[key] = (ends, games)
    return ends, games


def compute(state):
    """Recompute every rating from the closed sessions, oldest first."""
    players = state["players"]
    rating = {pid: p["seed"] for pid, p in players.items()}
    totals = {pid: dict(w=0, l=0, pf=0, pa=0) for pid in players}
    by_session, game_out = {}, {}
    closed = sorted((s for s in state["sessions"] if s["status"] == "closed"), key=lambda s: (s["date"], s["id"]))
    for sess in closed:
        rec = {}
        start = dict(rating)
        for pool in sess["pools"]:
            rounds = []
            for rd in pool.get("rounds", []):
                games = []
                for gid in rd:
                    g = sess["games"][gid]
                    if g["status"] != "done" or g["s1"] == g["s2"]:
                        continue
                    t1, t2 = tuple(g["t1"]), tuple(g["t2"])
                    if g["s1"] > g["s2"]:
                        games.append((gid, t1, t2, g["s1"], g["s2"]))
                    else:
                        games.append((gid, t2, t1, g["s2"], g["s1"]))
                if games:
                    rounds.append(games)
            if not rounds:
                continue
            ends, gmean = all_orders(start, rounds)
            for pid, v in ends.items():
                rating[pid] = rnd(v)
                rec[pid] = dict(pool=pool["id"], start=start[pid], end=rating[pid], w=0, l=0, pf=0, pa=0)
            for rd in rounds:
                for gid, win, lose, ws, ls in rd:
                    prob, dw, dl = gmean[gid]
                    t1_won = sess["games"][gid]["s1"] > sess["games"][gid]["s2"]
                    game_out[gid] = dict(p1=round(prob if t1_won else 1 - prob, 4),
                                         d1=round(dw if t1_won else dl, 2), d2=round(dl if t1_won else dw, 2))
                    for pid in win:
                        for d in (rec[pid], totals[pid]):
                            d["w"] += 1
                            d["pf"] += ws
                            d["pa"] += ls
                    for pid in lose:
                        for d in (rec[pid], totals[pid]):
                            d["l"] += 1
                            d["pf"] += ls
                            d["pa"] += ws
        by_session[sess["id"]] = rec
    return dict(current=rating, sessions=by_session, games=game_out, totals=totals)
