/* Run from the Ladder App folder:  node tests/core.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const L = require("../docs/core.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + (e && e.message)); process.exitCode = 1; }
}
const throwsCode = (fn, code) => { try { fn(); } catch (e) { assert.strictEqual(e.code, code); return e; } assert.fail("expected " + code); };

test("8 players get the full whist design", () => {
  const players = Array.from({ length: 8 }, (_, i) => "p" + i), s = L.summary(players, L.generate(players, "x"));
  assert.deepStrictEqual([s.rounds, s.games, s.partnerMin, s.partnerMax, s.opposeMin, s.opposeMax, s.eachMin, s.eachMax], [7, 14, 1, 1, 2, 2, 7, 7]);
});

test("pools of 4 to 12 are valid and even", () => {
  for (let n = 4; n <= 12; n++) {
    const players = Array.from({ length: n }, (_, i) => "p" + i), rounds = L.generate(players, "y");
    for (const rd of rounds) {
      const used = rd.flat(2);
      assert.strictEqual(new Set(used).size, used.length, "player twice in a round, n=" + n);
      assert.strictEqual(rd.length, Math.floor(n / 4));
    }
    const s = L.summary(players, rounds);
    assert.strictEqual(s.eachMin, s.eachMax, "uneven games, n=" + n);
    assert.ok(Math.abs(s.eachMin - 7) <= 1, "n=" + n);
    assert.ok(s.partnerMax - s.partnerMin <= 2, "n=" + n);
  }
  const nine = Array.from({ length: 9 }, (_, i) => "p" + i);
  assert.deepStrictEqual(L.generate(nine, "s1A"), L.generate(nine, "s1A"));
});

test("ratings match the Python engine on the local league data (skipped if absent)", () => {
  const file = path.join(__dirname, "..", "data", "league.json");
  if (!fs.existsSync(file)) { console.log("     no data/league.json here, nothing to compare"); return; }
  const saved = JSON.parse(fs.readFileSync(file, "utf8")), st = L.normalize(JSON.parse(JSON.stringify(saved)));
  const got = L.compute(st);
  assert.ok(Object.keys(got.current).length >= 30);
  assert.deepStrictEqual(got.current, saved.ratings.current);
  assert.deepStrictEqual(got.totals, saved.ratings.totals);
  for (const sid in saved.ratings.sessions) for (const pid in saved.ratings.sessions[sid]) assert.deepStrictEqual(got.sessions[sid][pid], saved.ratings.sessions[sid][pid]);
});

function league(n) {
  const st = L.emptyState("Test League");
  for (let i = 0; i < n; i++) L.apply(st, "player.add", { name: "Player " + String(i + 1).padStart(2, "0"), seed: [3.7, 3.5, 3.3, 3.1][Math.floor(i / 8) % 4] }, true);
  return st;
}

test("full session flow: pools, new player, scores, clash, close, correction", () => {
  const st = league(32);
  throwsCode(() => L.apply(st, "session.create", { date: "2026-11-23" }, false), "pin");
  const sid = L.apply(st, "session.create", { date: "2026-11-23" }, true).id, sess = st.sessions[0];
  assert.strictEqual(sess.attending.length, 32);
  L.apply(st, "session.assign", { sid }, true);
  assert.deepStrictEqual(sess.pools.map(p => p.players.length), [8, 8, 8, 8]);
  assert.ok(sess.pools[0].players.every(p => st.players[p].seed === 3700));

  const neu = L.apply(st, "player.add", { name: "New Person", seed: 3.3, sid }, true).id;
  throwsCode(() => L.apply(st, "session.schedule", { sid }, true), "unassigned");
  L.apply(st, "session.move", { sid, pid: neu, to: "C" }, true);
  assert.strictEqual(sess.pools[2].players.length, 9);
  L.apply(st, "session.start", { sid }, true);
  assert.strictEqual(sess.status, "live");
  assert.strictEqual(sess.pools[0].rounds.flat().length, 14);

  const gid = sess.pools[0].rounds[0][0];
  L.apply(st, "game.score", { sid, gid, s1: 11, s2: 6 }, false);
  const clash = throwsCode(() => L.apply(st, "game.score", { sid, gid, s1: 11, s2: 4 }, false), "exists");
  assert.deepStrictEqual(clash.extra, { s1: 11, s2: 6 });
  L.apply(st, "game.score", { sid, gid, s1: 11, s2: 4, replace: true }, false);
  throwsCode(() => L.apply(st, "game.score", { sid, gid, s1: 7, s2: 7, replace: true }, false), "invalid");

  const before = Object.assign({}, st.ratings.current);
  let i = 0;
  for (const g of Object.values(sess.games)) if (g.pool === "A" && g.status === "pending") {
    const ls = (i * 3) % 10, t1Wins = i++ % 3 !== 0;
    L.apply(st, "game.score", { sid, gid: g.id, s1: t1Wins ? 11 : ls, s2: t1Wins ? ls : 11 }, false);
  }
  throwsCode(() => L.apply(st, "session.close", { sid }, false), "pin");
  L.apply(st, "session.close", { sid }, true);
  assert.strictEqual(sess.status, "closed");
  assert.ok(sess.pools[0].players.every(p => st.ratings.current[p] !== before[p]));
  assert.strictEqual(st.ratings.current[sess.pools[1].players[0]], before[sess.pools[1].players[0]]);
  const rec = st.ratings.sessions[sid][sess.pools[0].players[0]];
  assert.strictEqual(rec.w + rec.l, 7);
  const sum = Object.values(st.ratings.sessions[sid]).reduce((t, r) => t + r.end - r.start, 0);
  assert.ok(Math.abs(sum - 14 * 22) <= 8, "every 11-point game adds 0.022 across four players, got " + sum);

  throwsCode(() => L.apply(st, "game.score", { sid, gid, s1: 11, s2: 9, replace: true }, false), "pin");
  const after = JSON.stringify(st.ratings.current);
  L.apply(st, "game.score", { sid, gid, s1: 4, s2: 11, replace: true }, true);
  assert.notStrictEqual(JSON.stringify(st.ratings.current), after);
});

test("substitute, dropout, uneven attendance, database round trip", () => {
  const st = league(34);
  const sid = L.apply(st, "session.create", { date: "2026-11-23" }, true).id, sess = st.sessions[0];
  ["p33", "p34"].forEach(pid => L.apply(st, "session.attend", { sid, pid, on: false }, true));
  ["p1", "p2", "p3"].forEach(pid => L.apply(st, "session.attend", { sid, pid, on: false }, true));
  L.apply(st, "session.assign", { sid }, true);
  assert.deepStrictEqual(sess.pools.map(p => p.players.length), [8, 7, 7, 7]);
  L.apply(st, "session.start", { sid }, true);
  assert.strictEqual(sess.pools[1].rounds.flat().length, 14);
  const out = sess.pools[3].players[0];
  const res = L.apply(st, "session.substitute", { sid, out, in: "p33" }, true);
  assert.strictEqual(res.games, 8);
  assert.ok(!Object.values(sess.games).some(g => g.t1.concat(g.t2).includes(out)));

  // what a database does to the document: drops nulls and empty lists, keys sessions by id
  const db = JSON.parse(JSON.stringify(st, (k, v) => (v === null || (Array.isArray(v) && !v.length) ? undefined : v)));
  db.sessions = { [sess.id]: db.sessions[0] };
  const back = L.normalize(db);
  assert.deepStrictEqual(back.sessions[0].games, sess.games);
  assert.deepStrictEqual(back.sessions[0].pools, sess.pools);

  L.apply(st, "player.update", { id: out, active: false }, true);
  L.apply(st, "session.delete", { sid }, true);
  L.apply(st, "session.create", { date: "2026-11-30" }, true);
  assert.ok(!st.sessions[0].attending.includes(out));
});

console.log(`${passed} passed`);
