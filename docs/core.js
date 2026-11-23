/* Ladder League core: rating engine, scheduler and league rules.
   Runs in the browser (window.Ladder) and in Node (module.exports) so it can be tested.
   Mirrors ladder/engine.py, scheduler.py and store.py. Ratings are integers in thousandths. */
(function (L) {
  "use strict";

  /* ---------------- seeded random ---------------- */
  function rng(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }

  /* ---------------- rating engine ---------------- */
  const K_ELO = 100, K_PROB = 8.988, MAX_EXACT_ROUNDS = 9, SAMPLE_ORDERS = 20000;
  const BASE_POINTS = 11;      // the score bonus is worked out for a game to 11; longer or shorter games are scaled to it
  const rnd = x => Math.floor(x + 0.5);
  const cache = new Map();

  /* start: {pid: rating}. rounds: [[{gid, win:[a,b], lose:[c,d], ws, ls, bw?, bl?}]]: bw and bl are the winners' and
     losers' score bonus when the game was not to 11 (otherwise ws - ls and ls).
     Replays the rounds in every order and averages. Returns {ends: {pid: mean}, games: {gid: [prob, dw, dl]}}. */
  function allOrders(start, rounds) {
    const players = [...new Set(rounds.flat().flatMap(g => g.win.concat(g.lose)))].sort();
    const key = JSON.stringify([players.map(p => start[p]), rounds]);
    if (cache.has(key)) return cache.get(key);
    const idx = new Map(players.map((p, i) => [p, i]));
    const base = players.map(p => start[p]);
    const rds = rounds.map(rd => rd.map(g => [idx.get(g.win[0]), idx.get(g.win[1]), idx.get(g.lose[0]), idx.get(g.lose[1]), g.bw != null ? g.bw : g.ws - g.ls, g.bl != null ? g.bl : g.ls]));
    const sums = rounds.map(rd => rd.map(() => [0, 0, 0]));
    const total = new Array(players.length).fill(0);
    const n = rounds.length, r = new Array(players.length);
    let count = 0;
    const play = order => {
      for (let j = 0; j < base.length; j++) r[j] = base[j];
      for (let o = 0; o < n; o++) {
        const i = order[o], games = rds[i], acc = sums[i];
        for (let k = 0; k < games.length; k++) {
          const g = games[k];
          const prob = 1 / (1 + Math.exp(-K_PROB * (r[g[0]] + r[g[1]] - r[g[2]] - r[g[3]]) / 2000));
          const elo = Math.floor(K_ELO * (1 - prob) + 0.5);
          const dw = elo + g[4], dl = g[5] - elo;
          r[g[0]] += dw; r[g[1]] += dw; r[g[2]] += dl; r[g[3]] += dl;
          const s = acc[k]; s[0] += prob; s[1] += dw; s[2] += dl;
        }
      }
      for (let j = 0; j < base.length; j++) total[j] += r[j];
      count++;
    };
    const order = Array.from({ length: n }, (_, i) => i);
    if (n <= MAX_EXACT_ROUNDS) {
      const c = new Array(n).fill(0);            // Heap's algorithm: every permutation once
      play(order);
      let i = 0;
      while (i < n) {
        if (c[i] < i) {
          const j = i % 2 ? c[i] : 0, t = order[j];
          order[j] = order[i]; order[i] = t;
          play(order);
          c[i]++; i = 0;
        } else { c[i] = 0; i++; }
      }
    } else {
      const rand = rng("orders-" + n);
      for (let s = 0; s < SAMPLE_ORDERS; s++) play(shuffle(order, rand));
    }
    const out = { ends: {}, games: {} };
    players.forEach((p, i) => { out.ends[p] = total[i] / count; });
    rounds.forEach((rd, i) => rd.forEach((g, k) => { out.games[g.gid] = sums[i][k].map(v => v / count); }));
    if (cache.size > 400) cache.clear();
    cache.set(key, out);
    return out;
  }

  function compute(state) {
    const rating = {}, totals = {};
    for (const pid in state.players) { rating[pid] = state.players[pid].seed; totals[pid] = { w: 0, l: 0, pf: 0, pa: 0 }; }
    const bySession = {}, gameOut = {};
    const closed = state.sessions.filter(s => s.status === "closed").sort((a, b) => (a.date + "|" + a.id < b.date + "|" + b.id ? -1 : 1));
    for (const sess of closed) {
      const rec = {}, start = Object.assign({}, rating);
      for (const pool of sess.pools) {
        const rounds = [], T = pool.target || sess.pointsToWin || BASE_POINTS;
        for (const rd of pool.rounds || []) {
          const games = [];
          for (const gid of rd) {
            const g = sess.games[gid];
            if (!g || g.status !== "done" || g.s1 === g.s2) continue;
            const w = g.s1 > g.s2 ? { gid, win: g.t1, lose: g.t2, ws: g.s1, ls: g.s2 } : { gid, win: g.t2, lose: g.t1, ws: g.s2, ls: g.s1 };
            /* a game to 15 or 21 has more points in it: scale the bonus so it is worth what a game to 11 is */
            if (T !== BASE_POINTS) { w.bw = rnd((w.ws - w.ls) * BASE_POINTS / T); w.bl = rnd(w.ls * BASE_POINTS / T); }
            games.push(w);
          }
          if (games.length) rounds.push(games);
        }
        if (!rounds.length) continue;
        const res = allOrders(start, rounds);
        for (const pid in res.ends) {
          rating[pid] = rnd(res.ends[pid]);
          rec[pid] = { pool: pool.id, start: start[pid], end: rating[pid], w: 0, l: 0, pf: 0, pa: 0 };
        }
        for (const rd of rounds) for (const g of rd) {
          const [prob, dw, dl] = res.games[g.gid], t1Won = sess.games[g.gid].s1 > sess.games[g.gid].s2;
          gameOut[g.gid] = { p1: +(t1Won ? prob : 1 - prob).toFixed(4), d1: +(t1Won ? dw : dl).toFixed(2), d2: +(t1Won ? dl : dw).toFixed(2) };
          for (const pid of g.win) for (const d of [rec[pid], totals[pid]]) { d.w++; d.pf += g.ws; d.pa += g.ls; }
          for (const pid of g.lose) for (const d of [rec[pid], totals[pid]]) { d.l++; d.pf += g.ls; d.pa += g.ws; }
        }
      }
      bySession[sess.id] = rec;
    }
    return { current: rating, sessions: bySession, games: gameOut, totals };
  }

  /* ---------------- scheduler ---------------- */
  const TARGET_GAMES = 7, MIN_POOL = 4, MAX_POOL = 12;

  function roundCount(n) {
    const perRound = 4 * Math.floor(n / 4);
    let best = null;
    for (let rounds = 1; rounds < 60; rounds++) {
      if ((perRound * rounds) % n) continue;
      const each = perRound * rounds / n, key = [Math.abs(each - TARGET_GAMES), -each];
      if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) best = { key, rounds };
    }
    return best.rounds;
  }
  /* How many pools for n players: the fewest with nobody over 9, so pools are 8s and 9s. If that would leave a pool
     under 8 (28 to 31 players, say), one pool fewer: 10s and 11s on two courts beat 7s playing one game at a time. */
  function poolCount(n) {
    let k = Math.max(1, Math.ceil(n / 9));
    if (k > 1 && Math.floor(n / k) < 8 && Math.ceil(n / (k - 1)) <= 11) k--;
    return k;
  }
  /* What a pool of n plays to, so it finishes at about the same time as a pool of eight playing to base. Playing time is
     taken as rounds x points. Only 11, 15 and 21 are offered; a tie goes to the shorter game. */
  const TARGETS = [11, 15, 21];
  function suggestTarget(n, base) {
    if (!TARGETS.includes(base) || n < MIN_POOL || n > MAX_POOL) return base;
    const budget = roundCount(8) * base, rounds = roundCount(n);
    return TARGETS.reduce((best, t) => (Math.abs(rounds * t - budget) < Math.abs(rounds * best - budget) ? t : best));
  }
  function counts(n, rounds) {
    const partner = Array.from({ length: n }, () => new Array(n).fill(0)), oppose = Array.from({ length: n }, () => new Array(n).fill(0));
    for (const rd of rounds) for (const [[a, b], [c, d]] of rd) {
      partner[a][b]++; partner[b][a]++; partner[c][d]++; partner[d][c]++;
      for (const x of [a, b]) for (const y of [c, d]) { oppose[x][y]++; oppose[y][x]++; }
    }
    return { partner, oppose };
  }
  function permutations(items) {
    if (items.length <= 1) return [items];
    const out = [];
    items.forEach((x, i) => permutations(items.slice(0, i).concat(items.slice(i + 1))).forEach(p => out.push([x].concat(p))));
    return out;
  }
  let whistCache = null;
  function whist8() {
    if (whistCache) return whistCache;
    const INF = 7;
    for (const p of permutations([1, 2, 3, 4, 5, 6])) {
      const starter = [[[INF, 0], [p[0], p[1]]], [[p[2], p[3]], [p[4], p[5]]]];
      const rounds = [];
      for (let k = 0; k < 7; k++) {
        const sh = x => (x === INF ? x : (x + k) % 7);
        rounds.push(starter.map(([[a, b], [c, d]]) => [[sh(a), sh(b)], [sh(c), sh(d)]]));
      }
      const { partner, oppose } = counts(8, rounds);
      let ok = true;
      for (let i = 0; i < 8 && ok; i++) for (let j = 0; j < 8; j++) if (i !== j && (partner[i][j] !== 1 || oppose[i][j] !== 2)) { ok = false; break; }
      if (ok) return (whistCache = rounds);
    }
    return null;
  }
  function balanced(n, nRounds, rand) {
    const perRound = Math.floor(n / 4);
    let best = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const partner = Array.from({ length: n }, () => new Array(n).fill(0)), oppose = Array.from({ length: n }, () => new Array(n).fill(0));
      const played = new Array(n).fill(0), rounds = [];
      for (let r = 0; r < nRounds; r++) {
        const tie = Array.from({ length: n }, () => rand());
        const playing = Array.from({ length: n }, (_, i) => i).sort((a, b) => played[a] - played[b] || tie[a] - tie[b]).slice(0, 4 * perRound);
        let pick = null;
        for (let t = 0; t < 150; t++) {
          shuffle(playing, rand);
          let cost = 0;
          for (let k = 0; k < perRound; k++) {
            const a = playing[4 * k], b = playing[4 * k + 1], c = playing[4 * k + 2], d = playing[4 * k + 3];
            cost += 12 * (partner[a][b] + partner[c][d]) + oppose[a][c] + oppose[a][d] + oppose[b][c] + oppose[b][d];
          }
          if (!pick || cost < pick.cost) pick = { cost, order: playing.slice() };
        }
        const rd = [];
        for (let k = 0; k < perRound; k++) {
          const [a, b, c, d] = pick.order.slice(4 * k, 4 * k + 4);
          rd.push([[a, b], [c, d]]);
          partner[a][b]++; partner[b][a]++; partner[c][d]++; partner[d][c]++;
          for (const x of [a, b]) for (const y of [c, d]) { oppose[x][y]++; oppose[y][x]++; }
          for (const x of [a, b, c, d]) played[x]++;
        }
        rounds.push(rd);
      }
      let score = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) score += 12 * partner[i][j] ** 2 + oppose[i][j] ** 2;
      if (!best || score < best.score) best = { score, rounds };
    }
    return best.rounds;
  }
  /* players: ids. Returns rounds: [[[pair, pair], ...], ...] using those ids. Same seed, same schedule. */
  function generate(players, seed) {
    const n = players.length;
    if (n < MIN_POOL || n > MAX_POOL) throw new Error(`a pool needs ${MIN_POOL} to ${MAX_POOL} players, got ${n}`);
    const rand = rng(String(seed) + "-" + n);
    const design = (n === 8 && whist8()) || balanced(n, roundCount(n), rand);
    const slots = shuffle(players.slice(), rand), order = shuffle(design.slice(), rand);
    return order.map(rd => rd.map(([[a, b], [c, d]]) => [[slots[a], slots[b]], [slots[c], slots[d]]]));
  }
  function summary(players, rounds) {
    const index = new Map(players.map((p, i) => [p, i])), n = players.length;
    const asIdx = rounds.map(rd => rd.map(([[a, b], [c, d]]) => [[index.get(a), index.get(b)], [index.get(c), index.get(d)]]));
    const { partner, oppose } = counts(n, asIdx);
    const games = players.map((_, i) => asIdx.flat().filter(([t1, t2]) => t1.concat(t2).includes(i)).length);
    const pv = [], ov = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { pv.push(partner[i][j]); ov.push(oppose[i][j]); }
    return { rounds: rounds.length, games: rounds.flat().length, eachMin: Math.min(...games), eachMax: Math.max(...games),
      partnerMin: Math.min(...pv), partnerMax: Math.max(...pv), opposeMin: Math.min(...ov), opposeMax: Math.max(...ov) };
  }

  /* ---------------- league rules (actions on the state document) ---------------- */
  const DEFAULT_SEEDS = [3700, 3500, 3300, 3100];
  const OPEN_ACTIONS = new Set(["game.score", "game.clear", "round.confirm"]);   // anyone, during a live session

  function ActionError(code, message, extra) { this.code = code; this.message = message; this.extra = extra || {}; }
  const fail = (code, message, extra) => { throw new ActionError(code, message, extra); };

  function emptyState(name) {
    return { version: 1, seq: { p: 0, s: 0, g: 0 }, league: { name: name || "Doubles Ladder League", seeds: DEFAULT_SEEDS.slice(), poolSize: 8, pointsToWin: 11, nameStyle: "short" },
      players: {}, sessions: [], ratings: { current: {}, sessions: {}, games: {}, totals: {} } };
  }
  const toArray = x => (Array.isArray(x) ? x.filter(v => v != null) : x && typeof x === "object" ? Object.keys(x).sort((a, b) => a - b).map(k => x[k]) : []);
  const idNum = id => parseInt(String(id).slice(1), 10) || 0;
  /* Fill in anything a database dropped (empty lists, nulls) and accept sessions keyed by id. */
  function normalize(raw) {
    const st = Object.assign(emptyState(), raw || {});
    st.seq = Object.assign({ p: 0, s: 0, g: 0 }, st.seq);
    st.league = Object.assign(emptyState().league, st.league);
    st.league.seeds = toArray(st.league.seeds);
    st.players = st.players || {};
    st.sessions = toArray(st.sessions).sort((a, b) => idNum(a.id) - idNum(b.id)).map(s => {
      const games = {};
      for (const gid in s.games || {}) {
        const g = s.games[gid];
        games[gid] = Object.assign({}, g, { t1: toArray(g.t1), t2: toArray(g.t2), s1: g.s1 == null ? null : g.s1, s2: g.s2 == null ? null : g.s2 });
      }
      return Object.assign({}, s, { attending: toArray(s.attending), games,
        pools: toArray(s.pools).map(p => Object.assign({}, p, { confirmed: p.confirmed || 0, players: toArray(p.players), rounds: toArray(p.rounds).map(toArray) })) });
    });
    const r = st.ratings || {};
    st.ratings = { current: r.current || {}, sessions: r.sessions || {}, games: r.games || {}, totals: r.totals || {} };
    return st;
  }

  const H = {};   // action handlers: (state, args, org) => result
  const nextId = (st, kind) => kind + (++st.seq[kind]);
  const ratingOf = (st, pid) => (st.ratings.current[pid] != null ? st.ratings.current[pid] : st.players[pid].seed);
  const byRating = st => (a, b) => ratingOf(st, b) - ratingOf(st, a) || st.players[a].name.toLowerCase().localeCompare(st.players[b].name.toLowerCase());
  const openSession = st => st.sessions.find(s => s.status !== "closed");
  const doneGames = s => Object.values(s.games).filter(g => g.status === "done");
  const recompute = st => { st.ratings = compute(st); };
  function getSession(st, sid, ...statuses) {
    const s = st.sessions.find(x => x.id === sid);
    if (!s) fail("missing", "Session not found.");
    if (statuses.length && !statuses.includes(s.status)) fail("status", `This session is ${s.status}, so that is not possible.`);
    return s;
  }
  const getPlayer = (st, pid) => st.players[pid] || fail("missing", "Player not found.");
  const clearSchedule = s => { s.games = {}; s.pools.forEach(p => { p.rounds = []; }); };
  const hasPlayed = (st, pid) => st.sessions.some(s => doneGames(s).some(g => g.t1.concat(g.t2).includes(pid)));
  function checkName(st, name, skip) {
    name = String(name || "").trim().split(/\s+/).join(" ").slice(0, 60);
    if (!name) fail("invalid", "Enter the player's name.");
    for (const pid in st.players) if (pid !== skip && st.players[pid].name.toLowerCase() === name.toLowerCase()) fail("duplicate", `${st.players[pid].name} is already in the league.`);
    return name;
  }
  function seedOf(value) {
    const seed = Math.round(parseFloat(value) * 1000);
    if (!Number.isFinite(seed)) fail("invalid", "Starting rating must be a number, for example 3.3.");
    if (seed < 1500 || seed > 6000) fail("invalid", "Starting rating must be between 1.5 and 6.0.");
    return seed;
  }
  function removeFromSession(s, pid) {
    s.attending = s.attending.filter(p => p !== pid);
    for (const pool of s.pools) if (pool.players.includes(pid)) { pool.players = pool.players.filter(p => p !== pid); clearSchedule(s); }
  }

  function pointsOf(value) {
    const raw = String(value).trim(), pts = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (!(pts >= 5 && pts <= 21)) fail("invalid", "Points to win must be a whole number from 5 to 21.");
    return pts;
  }
  H["league.update"] = (st, a) => {
    if ("name" in a) { const name = String(a.name).trim(); if (!name) fail("invalid", "League name cannot be empty."); st.league.name = name.slice(0, 80); }
    if ("nameStyle" in a) { if (a.nameStyle !== "short" && a.nameStyle !== "full") fail("invalid", "Choose short or full names."); st.league.nameStyle = a.nameStyle; }
    if ("pointsToWin" in a) st.league.pointsToWin = pointsOf(a.pointsToWin);
  };
  H["player.add"] = (st, a) => {
    const name = checkName(st, a.name), seed = seedOf(a.seed != null ? a.seed : st.league.seeds[st.league.seeds.length - 1] / 1000);
    const pid = nextId(st, "p");
    st.players[pid] = { id: pid, name, active: true, seed };
    st.ratings.current[pid] = seed;
    st.ratings.totals[pid] = { w: 0, l: 0, pf: 0, pa: 0 };
    if (a.sid) getSession(st, a.sid, "setup").attending.push(pid);
    return { id: pid };
  };
  H["player.update"] = (st, a) => {
    const p = getPlayer(st, a.id);
    if ("name" in a) p.name = checkName(st, a.name, p.id);
    if ("active" in a) {
      p.active = !!a.active;
      const s = openSession(st);
      if (!p.active && s && s.status === "setup" && s.attending.includes(p.id)) removeFromSession(s, p.id);
    }
    if ("seed" in a) {
      if (hasPlayed(st, p.id)) fail("locked", `${p.name} has played games, so the starting rating is fixed.`);
      p.seed = seedOf(a.seed);
      recompute(st);
    }
  };
  H["session.create"] = (st, a) => {
    if (openSession(st)) fail("open", "Finish the current session before creating another.");
    const date = String(a.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + "T00:00").getTime())) fail("invalid", "Pick a date for the session.");
    const closed = st.sessions.filter(s => s.status === "closed").sort((x, y) => (x.date + "|" + x.id < y.date + "|" + y.id ? -1 : 1));
    /* a session dated before the last finished one would slot in ahead of it and re-rate every later week */
    if (closed.length && date < closed[closed.length - 1].date) fail("date", `That date is before the last finished session (${closed[closed.length - 1].date}). Pick that day or later.`);
    const active = Object.keys(st.players).filter(pid => st.players[pid].active);
    const last = closed.length ? new Set(closed[closed.length - 1].attending) : new Set(active);
    const s = { id: nextId(st, "s"), date, status: "setup", attending: active.filter(p => last.has(p)), pools: [], games: {} };
    st.sessions.push(s);
    return { id: s.id };
  };
  H["session.attend"] = (st, a) => {
    const s = getSession(st, a.sid, "setup"), p = getPlayer(st, a.pid);
    if (a.on) {
      if (!p.active) fail("inactive", `${p.name} is marked as dropped out. Restore them first.`);
      if (!s.attending.includes(p.id)) s.attending.push(p.id);
    } else removeFromSession(s, p.id);
  };
  H["session.attendAll"] = (st, a) => {
    const s = getSession(st, a.sid, "setup");
    if (a.last) {
      /* exactly the players who were at the last finished session (and are still in the league); pools keep whoever stays */
      const closed = st.sessions.filter(x => x.status === "closed").sort((x, y) => (x.date + "|" + x.id < y.date + "|" + y.id ? -1 : 1));
      if (!closed.length) fail("none", "There is no finished session to copy from yet.");
      const want = closed[closed.length - 1].attending.filter(pid => st.players[pid] && st.players[pid].active);
      s.attending.filter(pid => !want.includes(pid)).forEach(pid => removeFromSession(s, pid));
      want.forEach(pid => { if (!s.attending.includes(pid)) s.attending.push(pid); });
      return { players: s.attending.length };
    }
    if (a.on) { for (const pid in st.players) if (st.players[pid].active && !s.attending.includes(pid)) s.attending.push(pid); }
    else { s.attending = []; s.pools = []; s.games = {}; }
  };
  H["session.assign"] = (st, a) => {
    const s = getSession(st, a.sid, "setup"), ranked = s.attending.slice().sort(byRating(st)), n = ranked.length;
    if (n < MIN_POOL) fail("few", `At least ${MIN_POOL} players are needed.`);
    let k = a.pools ? parseInt(a.pools, 10) : poolCount(n);
    k = Math.max(1, Math.min(k, Math.floor(n / MIN_POOL), 12));
    while (Math.ceil(n / k) > MAX_POOL) k++;
    const courts = {};
    s.pools.forEach(p => { courts[p.id] = p.courts; });
    const base = Math.floor(n / k), extra = n % k, pools = [];
    let at = 0;
    for (let i = 0; i < k; i++) {
      const count = base + (i < extra ? 1 : 0), id = String.fromCharCode(65 + i);
      /* a pool of 8 or more plays two games a round, so it gets two courts unless the organiser gave it three */
      pools.push({ id, name: "Pool " + id, courts: count < 8 ? 1 : Math.max(courts[id] || 0, 2), confirmed: 0, players: ranked.slice(at, at + count), rounds: [] });
      at += count;
    }
    s.pools = pools; s.games = {};
  };
  H["session.move"] = (st, a) => {
    const s = getSession(st, a.sid, "setup");
    if (!s.attending.includes(a.pid)) fail("missing", "That player is not marked as attending.");
    let target = null;
    if (a.to && a.to !== "none") target = s.pools.find(p => p.id === a.to) || fail("missing", "Pool not found.");
    s.pools.forEach(p => { p.players = p.players.filter(x => x !== a.pid); });
    if (target) { target.players.push(a.pid); target.players.sort(byRating(st)); }
    clearSchedule(s);
  };
  H["session.pool"] = (st, a) => {
    const s = getSession(st, a.sid, "setup", "live");
    if (a.add) { const s2 = getSession(st, a.sid, "setup"), id = String.fromCharCode(65 + s2.pools.length); s2.pools.push({ id, name: "Pool " + id, courts: 1, confirmed: 0, players: [], rounds: [] }); return; }
    const pool = s.pools.find(p => p.id === a.pool) || fail("missing", "Pool not found.");
    if (a.remove) {
      const s2 = getSession(st, a.sid, "setup");
      if (pool.players.length || pool !== s2.pools[s2.pools.length - 1]) fail("invalid", "Only the last pool can be removed, and only when it is empty.");
      s2.pools.pop(); return;
    }
    if ("courts" in a) { const c = parseInt(a.courts, 10); if (!(c >= 1 && c <= 3)) fail("invalid", "A pool can use 1 to 3 courts."); pool.courts = c; }
    if ("target" in a) {
      /* what this pool plays to. "auto" hands it back to the session's setting; once a pool has scores it stays as it is */
      if (Object.values(s.games).some(g => g.pool === pool.id && g.status === "done")) fail("scores", `${pool.name} already has scores, so what it plays to cannot change.`);
      if (a.target === "auto" || a.target === null || a.target === "") { if (s.status !== "setup") fail("status", "Choose 11, 15 or 21."); delete pool.target; }
      else pool.target = pointsOf(a.target);
    }
  };
  /* What a pool of eight plays to in this session. Every pool goes back to automatic: other sizes follow so all finish together. */
  H["session.target"] = (st, a) => {
    const s = getSession(st, a.sid, "setup");
    s.pointsToWin = pointsOf(a.points);
    s.pools.forEach(p => { delete p.target; });
  };
  H["session.schedule"] = (st, a) => {
    const s = getSession(st, a.sid, "setup");
    if (!s.pools.length) fail("pools", "Assign pools first.");
    const placed = new Set(s.pools.flatMap(p => p.players)), loose = s.attending.filter(p => !placed.has(p)).map(p => st.players[p].name);
    if (loose.length) fail("unassigned", `Not in a pool yet: ${loose.join(", ")}.`);
    for (const pool of s.pools) { const n = pool.players.length; if (n < MIN_POOL || n > MAX_POOL) fail("size", `${pool.name} has ${n} players. A pool needs ${MIN_POOL} to ${MAX_POOL}.`); }
    s.games = {};
    for (const pool of s.pools) {
      pool.confirmed = 0;
      pool.rounds = generate(pool.players, s.id + pool.id).map((rd, ri) => rd.map(([t1, t2]) => {
        const gid = nextId(st, "g");
        s.games[gid] = { id: gid, pool: pool.id, round: ri, t1, t2, s1: null, s2: null, status: "pending" };
        return gid;
      }));
    }
  };
  H["session.start"] = (st, a, org) => {
    const s = getSession(st, a.sid, "setup");
    if (!Object.keys(s.games).length) H["session.schedule"](st, a, org);
    /* the session and each pool keep the target they started with, whatever the league setting does later */
    const base = s.pointsToWin || st.league.pointsToWin;
    s.pools.forEach(p => { p.target = p.target || suggestTarget(p.players.length, base); });
    s.pointsToWin = base;
    s.status = "live";
  };
  /* What a game in this pool is played to. In setup a pool without its own setting follows the session (or league) setting. */
  function targetOf(st, s, pool) {
    const base = s.pointsToWin || st.league.pointsToWin;
    if (pool && pool.target) return pool.target;
    return pool && s.status === "setup" ? suggestTarget(pool.players.length, base) : base;
  }
  H["session.unstart"] = (st, a) => {
    const s = getSession(st, a.sid, "live");
    if (doneGames(s).length) fail("scores", "Scores have been entered, so the session cannot go back to setup.");
    s.status = "setup";
    /* a target that is just what automatic gives goes back to automatic; one set by hand stays */
    s.pools.forEach(p => { p.confirmed = 0; if (p.target === suggestTarget(p.players.length, s.pointsToWin || st.league.pointsToWin)) delete p.target; });
  };
  /* Back to a fresh start for the same draw: no scores, every pool on round 1. */
  H["session.reset"] = (st, a) => {
    const s = getSession(st, a.sid, "live");
    for (const g of Object.values(s.games)) { g.s1 = null; g.s2 = null; g.status = "pending"; delete g.at; delete g.auto; }
    s.pools.forEach(p => { p.confirmed = 0; });
    return { games: Object.keys(s.games).length };
  };
  /* Deleting a session that has scores takes an explicit yes (force), because the scores go with it. */
  H["session.delete"] = (st, a) => {
    const s = getSession(st, a.sid, "setup", "live");
    if (doneGames(s).length && !a.force) fail("scores", "Scores have been entered. Deleting the session deletes them too.");
    st.sessions = st.sessions.filter(x => x !== s);
  };

  function getGame(st, a, org) {
    const s = getSession(st, a.sid);
    if (s.status === "setup") fail("status", "The session has not started.");
    if (s.status === "closed" && !org) fail("pin", "This session is finished. Only the organiser can change it.");
    /* a score screen left open on a phone must not write into a night that has since been finished */
    if (s.status === "closed" && !a.history) fail("closed", "This session has been finished. Its scores can only be changed from Organiser, History.");
    return { s, g: s.games[a.gid] || fail("missing", "Game not found.") };
  }
  function checkScore(a) {
    const s1 = parseInt(a.s1, 10), s2 = parseInt(a.s2, 10);
    if (!Number.isInteger(s1) || !Number.isInteger(s2)) fail("invalid", "Enter both scores.");
    if (s1 < 0 || s1 > 60 || s2 < 0 || s2 > 60 || s1 === s2) fail("invalid", "Scores must be different whole numbers.");
    return { s1, s2 };
  }
  /* The rule for one game, shared with the database transaction used when many phones score at once. */
  function scoreGame(g, a, org, target) {
    const { s1, s2 } = checkScore(a);
    if (target && Math.max(s1, s2) > target) fail("invalid", `Games are first to ${target}, so the winning score cannot be more than ${target}.`);
    if (g.status === "skipped" && !org) fail("skipped", "This game was marked as not played.");
    if (g.status === "done" && (g.s1 !== s1 || g.s2 !== s2)) {
      /* replace needs the caller to have seen the score it is replacing: a.was is what its screen showed */
      const stale = a.was && (a.was.s1 !== g.s1 || a.was.s2 !== g.s2);
      if (!a.replace || stale) fail("exists", `Already entered as ${g.s1}-${g.s2}.`, { s1: g.s1, s2: g.s2 });
    }
    const out = Object.assign({}, g, { s1, s2, status: "done", at: Math.floor(Date.now() / 1000) });
    delete out.auto;
    return out;
  }
  H["game.score"] = (st, a, org) => { const { s, g } = getGame(st, a, org); s.games[g.id] = scoreGame(g, a, org, targetOf(st, s, s.pools.find(p => p.id === g.pool))); if (s.status === "closed") recompute(st); };
  H["game.clear"] = (st, a, org) => {
    const { s, g } = getGame(st, a, org);
    g.s1 = null; g.s2 = null; g.status = s.status === "closed" ? "skipped" : "pending"; delete g.at; delete g.auto;
    if (s.status === "closed") recompute(st);
  };
  H["game.skip"] = (st, a, org) => { const { g } = getGame(st, a, org); if (g.status === "done") fail("scores", "Clear the score first."); g.status = a.skip === false ? "pending" : "skipped"; delete g.auto; };
  /* A round is ready to confirm when none of its games is still waiting for a score. */
  const roundReady = (s, pool, round) => (pool.rounds[round] || []).length > 0 && pool.rounds[round].every(id => s.games[id] && s.games[id].status !== "pending");
  H["round.confirm"] = (st, a) => {
    const s = getSession(st, a.sid, "live"), pool = s.pools.find(p => p.id === a.pool) || fail("missing", "Pool not found.");
    const round = parseInt(a.round, 10), at = pool.confirmed || 0;
    if (round < at) return { round: at };                       // another device already moved this pool on
    if (round > at || round >= pool.rounds.length) fail("order", "That round is not being played yet.");
    if (!roundReady(s, pool, round)) fail("scores", "Enter every score in this round first.");
    pool.confirmed = round + 1;
    return { round: pool.confirmed };
  };
  /* Organiser only: undo a confirm made too early. Scores are untouched. */
  H["round.back"] = (st, a) => {
    const s = getSession(st, a.sid, "live"), pool = s.pools.find(p => p.id === a.pool) || fail("missing", "Pool not found.");
    if (!(pool.confirmed > 0)) fail("order", "This pool is already on its first round.");
    pool.confirmed -= 1;
    return { round: pool.confirmed };
  };
  H["session.substitute"] = (st, a) => {
    const s = getSession(st, a.sid, "setup", "live"), out = a.out, neu = a.in, pNew = getPlayer(st, neu);
    if (!pNew.active) fail("inactive", `${pNew.name} is marked as dropped out.`);
    const pool = s.pools.find(p => p.players.includes(out)) || fail("missing", "The player to replace is not in a pool.");
    if (s.pools.some(p => p.players.includes(neu))) fail("duplicate", `${pNew.name} is already playing in this session.`);
    let changed = 0;
    for (const g of Object.values(s.games)) if (g.pool === pool.id && g.status !== "done") for (const t of ["t1", "t2"]) if (g[t].includes(out)) { g[t] = g[t].map(p => (p === out ? neu : p)); changed++; }
    /* the replacement takes the leaver's place in the pool; someone who already played stays on the attendance list for the record */
    pool.players[pool.players.indexOf(out)] = neu;
    if (!doneGames(s).some(g => g.t1.concat(g.t2).includes(out))) s.attending = s.attending.filter(p => p !== out);
    if (!s.attending.includes(neu)) s.attending.push(neu);
    return { games: changed };
  };
  /* Finish one session object in place. Shared with the database transaction, so it copes with a raw database record. */
  function closeSession(s) {
    if (s.status !== "live") fail("status", `This session is ${s.status}, so that is not possible.`);
    const games = Object.values(s.games || {});
    if (!games.some(g => g.status === "done")) fail("scores", "No scores have been entered. Delete the session instead of finishing it.");
    games.forEach(g => { if (g.status === "pending") { g.status = "skipped"; g.auto = true; } });   // auto: skipped by Finish, not by a person
    s.status = "closed";
    s.wasClosed = true;
    return s;
  }
  H["session.close"] = (st, a) => { closeSession(getSession(st, a.sid, "live")); recompute(st); };
  H["session.reopen"] = (st, a) => {
    const s = getSession(st, a.sid, "closed");
    if (openSession(st)) fail("open", "Another session is already open.");
    const closed = st.sessions.filter(x => x.status === "closed").sort((x, y) => (x.date + "|" + x.id < y.date + "|" + y.id ? -1 : 1));
    if (closed[closed.length - 1] !== s) fail("order", "Only the most recent session can be reopened.");
    s.status = "live";
    Object.values(s.games).forEach(g => { if (g.status === "skipped" && g.auto) { g.status = "pending"; delete g.auto; } });   // games marked not played by hand stay that way
    recompute(st);
  };

  /* Apply one action to a state document (mutates it). Throws ActionError. */
  function apply(state, kind, args, org) {
    const handler = H[kind];
    if (!handler) fail("unknown", `Unknown action ${kind}.`);
    if (!OPEN_ACTIONS.has(kind) && !org) fail("pin", "Organiser access needed.");
    const result = handler(state, args || {}, !!org) || {};
    state.version = (state.version || 0) + 1;
    return result;
  }

  Object.assign(L, { rng, allOrders, compute, roundCount, poolCount, suggestTarget, targetOf, TARGETS, generate, summary, emptyState, normalize, apply, scoreGame, checkScore, roundReady, closeSession,
    ActionError, OPEN_ACTIONS, MIN_POOL, MAX_POOL });
})(typeof module !== "undefined" && module.exports ? module.exports : (window.Ladder = {}));
