"use strict";
/* Ladder League Manager front end. One state document from the server, re-rendered on every change. */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = v => (v / 1000).toFixed(3);
const sgn = v => (v < 0 ? "−" : "+") + (Math.abs(v) / 1000).toFixed(3);

const app = {
  st: null, urls: [], online: true,
  be: null,          // the backend: firebase, server or local (see backend.js)
  importDoc: null,   // league file chosen for import, waiting for confirmation
  short: {},         // player id -> "First L", rebuilt whenever the roster changes
  flow: null,        // score entry overlay
  sel: null,         // player picked up for a move (organiser)
  confirm: null,     // key of the action waiting for a second tap
  edit: null,        // player id being renamed
  form: {},          // values of inputs with an id, kept across re-renders
  err: {},           // message per area
  tab: "ratings",
  hl: null,          // players highlighted on the ratings chart: [{ id, slot }]
  chart: null,       // geometry of the chart on screen, for hover and tap
};

/* ---------- backend ---------- */
async function send(type, args = {}) {
  if (!app.be) return { ok: false, code: "offline", message: "Still loading. Try again in a moment." };
  return app.be.send(type, args);
}
const isOrg = () => !!app.be && app.be.isOrg();
function accept(j) { app.st = j.state; app.urls = j.urls || []; app.short = shortNames(j.state.players); render(); }
/* "Joel Carr" -> "Joel C". Two players who would collide get more of the surname: "Matt Gi", "Matt Gr". */
function shortNames(players) {
  const cap = w => (w ? w[0].toUpperCase() + w.slice(1) : w), rows = Object.values(players).map(p => {
    const parts = p.name.trim().split(/\s+/);
    return { id: p.id, first: cap(parts[0]), last: parts.length > 1 ? cap(parts[parts.length - 1]) : "" };
  });
  const out = {};
  for (const r of rows) {
    const same = rows.filter(o => o !== r && o.first.toLowerCase() === r.first.toLowerCase());
    let k = 1;
    while (k < r.last.length && same.some(o => o.last.slice(0, k).toLowerCase() === r.last.slice(0, k).toLowerCase())) k++;
    out[r.id] = r.last ? `${r.first} ${r.last.slice(0, k)}` : r.first;
  }
  return out;
}
function setOnline(on) { if (app.online !== on) { app.online = on; render(); } }
async function boot() {
  app.be = await Backends.pick(accept, setOnline);
  app.be.start();
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
}
async function act(area, type, args, okMsg) {
  const j = await send(type, args);
  app.err[area] = j.ok ? "" : j.message;
  if (j.ok && okMsg) toast(okMsg);
  render();
  return j;
}

/* ---------- selectors ---------- */
const P = id => app.st.players[id] || { name: "?", seed: 0, active: false };
const nm = id => P(id).name;
const sn = id => (app.st.league.nameStyle === "full" ? nm(id) : app.short[id] || nm(id));   // name as shown on match screens
const rating = id => app.st.ratings.current[id] ?? P(id).seed;
const openSess = () => app.st.sessions.find(s => s.status !== "closed");
const closedSess = () => app.st.sessions.filter(s => s.status === "closed").sort((a, b) => (a.date + a.id < b.date + b.id ? -1 : 1));
const sessById = id => app.st.sessions.find(s => s.id === id);
const poolGames = (s, pool) => (pool.rounds || []).flat().map(id => s.games[id]);
const team = ids => ids.map(id => `<span>${esc(sn(id))}</span>`).join("");
const teamLine = ids => ids.map(sn).map(esc).join(" / ");
const niceDate = d => new Date(d + "T00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const shortDate = d => new Date(d + "T00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/* Where a pool is up to: the round on court, the one after, and whether the scores are all in. */
function roundInfo(s, pool) {
  const total = pool.rounds.length, at = Math.min(pool.confirmed || 0, total);
  const all = poolGames(s, pool), games = at < total ? pool.rounds[at].map(id => s.games[id]) : [];
  const next = at + 1 < total ? pool.rounds[at + 1].map(id => s.games[id]) : [];
  const off = list => { const on = new Set(list.flatMap(g => [...g.t1, ...g.t2])); return list.length ? pool.players.filter(p => !on.has(p)) : []; };
  return { total, at, finished: at >= total, games, next, sitting: off(games), sittingNext: off(next),
    ready: games.length > 0 && games.every(g => g.status !== "pending"), waiting: games.filter(g => g.status === "pending").length,
    done: all.filter(g => g.status === "done").length, playable: all.filter(g => g.status !== "skipped").length };
}
const pct = r => (r.playable ? Math.round(100 * r.done / r.playable) : 0);
function poolTable(s, pool) {
  const rows = new Map(pool.players.map(p => [p, { p, w: 0, l: 0, pf: 0, pa: 0 }]));
  for (const g of poolGames(s, pool)) {
    if (g.status !== "done") continue;
    const add = (ids, mine, theirs) => ids.forEach(p => {
      const r = rows.get(p) || rows.set(p, { p, w: 0, l: 0, pf: 0, pa: 0 }).get(p);
      r.pf += mine; r.pa += theirs; mine > theirs ? r.w++ : r.l++;
    });
    add(g.t1, g.s1, g.s2); add(g.t2, g.s2, g.s1);
  }
  return [...rows.values()].sort((a, b) => b.w - a.w || (b.pf - b.pa) - (a.pf - a.pa) || nm(a.p).localeCompare(nm(b.p)));
}

/* ---------- shared pieces ---------- */
function shell(body) {
  const s = openSess(), route = location.hash.split("/")[1] || "";
  const link = (href, key, ico, label) => `<a href="${href}" ${route === key ? 'aria-current="page"' : ""}><span class="ico" aria-hidden="true">${ico}</span>${label}</a>`;
  return `
  <header class="top"><div class="top-in">
    <div class="brand">${esc(app.st.league.name)}</div>
    ${s && s.status === "live" ? '<span class="live-dot">Live</span>' : ""}
    <nav class="nav" aria-label="Main">
      ${link("#/", "", "●", "Tonight")}${link("#/board", "board", "▦", "All courts")}${link("#/standings", "standings", "≡", "Standings")}${link("#/org", "org", "⚙", "Organiser")}
    </nav>
  </div></header>
  ${app.online ? "" : '<div class="offline">No connection. Scores will not save until it is back.</div>'}
  ${app.be.kind === "local" ? '<div class="demo">Single-device mode: everything is saved in this browser only.</div>' : ""}
  <main>${body}</main>`;
}
const errLine = area => (app.err[area] ? `<p class="err" role="alert">${esc(app.err[area])}</p>` : "");
/* One game as a scoreboard: a row per pair, names on the left, score on the right. */
function matchCard(s, g, opts = {}) {
  const done = g.status === "done", skipped = g.status === "skipped";
  const side = (ids, pts, won) => `<div class="side ${done ? (won ? "won" : "lost") : ""}"><div class="names">${team(ids)}</div>${opts.preview ? "" : `<div class="pts">${done ? pts : ""}</div>`}</div>`;
  const tag = opts.label ? `<span class="ct">${opts.label}</span>` : "";
  const button = opts.preview ? "" : skipped ? `<p class="muted np">${tag}Not played</p>`
    : `<button class="btn huge ${done ? "quiet" : "primary"}" data-act="flow" data-sid="${s.id}" data-gid="${g.id}">${tag}<span>${done ? "Change score" : "Enter score"}</span></button>`;
  return `<div class="match ${done ? "is-done" : skipped ? "is-skipped" : opts.preview ? "is-preview" : "is-live"}">
    ${side(g.t1, g.s1, g.s1 > g.s2)}${side(g.t2, g.s2, g.s2 > g.s1)}${button}</div>`;
}
function roundCards(s, pool, r) {
  let waiting = 0;
  return r.games.map((g, i) => matchCard(s, g, { label: pool.courts > 1 ? `Court ${i + 1}` : g.status !== "pending" ? "" : waiting++ === 0 ? "Now" : "Next" })).join("");
}
/* Type sizes for the wide screens (board and draw) that keep every name and every pair on one line, whatever the names are. */
const emCache = new Map();
function emWidth(text, weight) {
  const key = weight + text;
  if (!emCache.has(key)) {
    emWidth.ctx = emWidth.ctx || document.createElement("canvas").getContext("2d");
    emWidth.ctx.font = `${weight} 100px ${getComputedStyle(document.body).fontFamily}`;
    emCache.set(key, emWidth.ctx.measureText(text).width / 100);
  }
  return emCache.get(key);
}
function fit(s) {
  const vw = document.documentElement.clientWidth, n = s.pools.length;
  if (vw < 900 || !n) return "";
  const col = (Math.min(1400, vw) - 24 - 10 * (n - 1)) / n, cap = (lo, v, hi) => Math.max(lo, Math.min(hi, Math.floor(v * 10) / 10));
  const names = s.pools.flatMap(p => p.players).map(sn), pairs = Object.values(s.games).flatMap(g => [g.t1, g.t2]).map(t => t.map(sn).join(" / "));
  const name = Math.max(...names.map(x => emWidth(x, 800))), pair = Math.max(...pairs.map(x => emWidth(x, 700)));
  const pts = Math.min(62, Math.max(44, vw * 0.048)) * 1.15;
  return `--n:${n};--fit-name:${cap(16, (col - 30 - pts) / name, 34)}px;--fit-pair:${cap(13, (col - 42) / pair, 23)}px;--fit-draw:${cap(12, (col - 68) / pair, 18)}px`;
}
/* Tonight: one pool's whole draw. Every round, both courts, scores as they come in. */
function drawPool(s, p) {
  const r = roundInfo(s, p);
  return `<section class="dpool">
    <a class="dp-head" href="#/court/${p.id}"><h2>${esc(p.name)}</h2><span class="round">${r.finished ? "Finished" : `Round ${r.at + 1} of ${r.total}`}</span></a>
    ${p.rounds.map((ids, i) => {
      const games = ids.map(id => s.games[id]), on = new Set(games.flatMap(g => [...g.t1, ...g.t2])), sit = p.players.filter(x => !on.has(x));
      return `<div class="drd ${i < r.at ? "past" : i === r.at ? "now" : ""}"><span class="drd-n" aria-label="Round ${i + 1}"><small>R</small>${i + 1}</span><div class="drd-g">
        ${games.map((g, k) => {
          const done = g.status === "done", w1 = done && g.s1 > g.s2, w2 = done && g.s2 > g.s1;
          const court = `<span class="dc">${p.courts > 1 ? "C" : ""}${k + 1}</span>`;
          return `<div class="dg${g.status === "skipped" ? " skip" : ""}">
            <span class="dpair${w1 ? " w" : ""}">${teamLine(g.t1)}</span>${done ? `<span class="ds${w1 ? " w" : ""}">${g.s1}</span>` : court}
            <span class="dpair${w2 ? " w" : ""}">${teamLine(g.t2)}</span>${done ? `<span class="ds${w2 ? " w" : ""}">${g.s2}</span>` : ""}</div>`;
        }).join("")}
        ${sit.length ? `<p class="dsit">Sitting out: ${namesList(sit)}</p>` : ""}</div></div>`;
    }).join("")}</section>`;
}
/* One slot under a round's games: either how many scores are missing, or the confirm button. Same size either way. */
function confirmBlock(s, pool, r, brief) {
  if (r.finished) return "";
  const label = r.at + 1 < r.total ? `Confirm and start ${brief ? "R" : "round "}${r.at + 2}` : "Confirm and finish";
  return r.ready ? `<button class="slot go" data-act="confirmRound" data-sid="${s.id}" data-pool="${pool.id}" data-round="${r.at}">${label}</button>`
    : `<div class="slot wait">${r.waiting === 1 ? "1 score to go" : `${r.waiting} scores to go`}</div>`;
}
/* The round after this one, in one box: who plays whom, in order, and who sits out. */
function nextBox(pool, r, compact) {
  if (!r.next.length) return "";
  return `<section class="nextbox ${compact ? "compact" : ""}">
    <h2><span>Next round</span>${compact ? "" : `<span class="num">Round ${r.at + 2} of ${r.total}</span>`}</h2>
    ${r.next.map((g, i) => compact
      ? `<div class="nx side-tag"><span class="nx-tag">${i + 1}</span><div class="nx-lines"><b>${teamLine(g.t1)}</b><b>${teamLine(g.t2)}</b></div></div>`
      : `<div class="nx"><span class="nx-tag">${pool.courts > 1 ? "Court " + (i + 1) : i === 0 ? "First on court" : "Then"}</span>
        <div class="nx-teams"><div class="names">${team(g.t1)}</div><span class="v">v</span><div class="names r">${team(g.t2)}</div></div></div>`).join("")}
    ${r.sittingNext.length ? `<p class="sit"><b>Sitting out</b> ${namesList(r.sittingNext)}</p>` : ""}</section>`;
}
/* Organiser only: step a pool back a round after a confirm made too early. */
function backBlock(s, pool, r) {
  if (!isOrg() || r.at === 0) return "";
  const key = "back-" + pool.id;
  return app.confirm === key
    ? `<div class="row orgrow"><span class="muted">Go back to round ${r.at}? Scores are kept.</span><button class="btn small" data-act="backRound" data-sid="${s.id}" data-pool="${pool.id}">Yes, go back</button><button class="btn small" data-act="cancel">No</button></div>`
    : `<div class="row orgrow"><button class="btn small quiet" data-act="ask" data-key="${key}">‹ Back to round ${r.at}</button></div>`;
}
const namesList = ids => ids.map(sn).map(esc).join(", ");
function standingsTable(s, pool) {
  const rows = poolTable(s, pool);
  return `<div class="scroll"><table>
    <thead><tr><th>#</th><th>Player</th><th class="r">W</th><th class="r">L</th><th class="r">PF</th><th class="r">PA</th><th class="r">+/-</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(sn(r.p))}</td><td class="r">${r.w}</td><td class="r">${r.l}</td><td class="r">${r.pf}</td><td class="r">${r.pa}</td><td class="r">${r.pf - r.pa > 0 ? "+" : ""}${r.pf - r.pa}</td></tr>`).join("")}</tbody>
  </table></div>`;
}
function resultRows(s, pool, canEdit, upto) {
  const rows = poolGames(s, pool).filter(g => (g.status !== "pending" || canEdit === "all") && (upto == null || g.round < upto));
  if (!rows.length) return '<p class="muted">No results yet.</p>';
  return `<div class="results">${rows.map(g => {
    const w1 = g.status === "done" && g.s1 > g.s2, w2 = g.status === "done" && g.s2 > g.s1;
    const mark = g.status === "done" ? null : g.status === "skipped" ? "not played" : "to play";
    const line = (ids, pts, won) => `<span class="ln ${won ? "w" : ""}"><span>${teamLine(ids)}</span><span class="sc">${mark ? "" : pts}</span></span>`;
    const btn = canEdit ? `<button class="btn small" data-act="flow" data-sid="${s.id}" data-gid="${g.id}">${g.status === "done" ? "Change" : "Enter"}</button>` : "";
    return `<div class="res"><span class="rd">R${g.round + 1}</span>
      <span class="who lines">${line(g.t1, g.s1, w1)}${line(g.t2, g.s2, w2)}${mark ? `<span class="muted">${mark}</span>` : ""}</span>${btn}</div>`;
  }).join("")}</div>`;
}

/* ---------- Tonight ---------- */
function viewHome() {
  const s = openSess(), last = closedSess().pop();
  const join = app.be.kind === "server" ? (app.urls.length ? `<p class="note">Players on this Wi-Fi open <b>${esc(app.urls[0])}</b> on their phone.</p>` : "")
    : app.be.kind === "firebase" ? `<p class="note">Players open <b>${esc(location.origin + location.pathname)}</b> on their phone.</p>` : "";
  if (!s) {
    return `<div class="head"><h1>No session running</h1><p class="muted">${last ? "Last session: " + niceDate(last.date) + "." : "No sessions played yet."}</p></div>
      <div class="row"><a class="btn primary" href="#/standings">See standings</a><a class="btn" href="#/org">Organiser: set up a session</a></div>${join}`;
  }
  if (s.status === "setup") {
    const pools = s.pools.filter(p => p.players.length);
    return `<div class="head"><h1>${niceDate(s.date)}</h1><p class="muted">The organiser is setting up this session. ${s.attending.length} players so far.</p></div>
      ${pools.length ? `<div class="pools">${pools.map(p => `<div class="pool"><h2>${esc(p.name)}</h2><ol>${p.players.map((id, i) => `<li class="pl"><span class="rk">${i + 1}</span><span class="nm">${esc(nm(id))}</span><span class="rt">${fmt(rating(id))}</span></li>`).join("")}</ol></div>`).join("")}</div>` : ""}
      ${join}`;
  }
  return `<div class="dhead"><h1>${niceDate(s.date)}</h1><p class="muted">The full draw. Tap a pool to enter scores.</p></div>
    <div class="draw" style="${fit(s)}">${s.pools.map(p => drawPool(s, p)).join("")}</div>${join}`;
}

/* ---------- Court ---------- */
function viewCourt(pid) {
  const s = openSess(), pool = s && s.pools.find(p => p.id === pid);
  if (!s || s.status !== "live" || !pool) return `<a class="back" href="#/">‹ All pools</a><div class="head"><h1>No live games here</h1><p class="muted">This pool is not playing right now.</p></div>`;
  const r = roundInfo(s, pool);
  return `<div class="court"><a class="back" href="#/">‹ All pools</a>
    <div class="head"><div class="row spread"><h1>${esc(pool.name)}</h1><span class="round">${r.finished ? "Finished" : `Round ${r.at + 1} of ${r.total}`}</span></div>
      <span class="bar on-surface"><i style="width:${pct(r)}%"></i></span></div>
    ${r.finished ? '<div class="note"><b>All rounds finished.</b> Thanks for playing. Final standings are below.</div>' + backBlock(s, pool, r) : `
      <section class="stack">${roundCards(s, pool, r)}
        ${r.sitting.length ? `<p class="sit"><b>Sitting out</b> ${namesList(r.sitting)}</p>` : ""}
        ${errLine("court")}${confirmBlock(s, pool, r)}${backBlock(s, pool, r)}</section>`}
    ${nextBox(pool, r)}
    ${r.at > 0 ? `<div class="card"><h2>Earlier rounds</h2>${resultRows(s, pool, true, r.at)}</div>` : ""}
    <div class="card"><h2>${esc(pool.name)} standings</h2>${standingsTable(s, pool)}</div></div>`;
}

/* ---------- Board ---------- */
function viewBoard() {
  const s = openSess();
  if (!s || s.status !== "live") return `<div class="head"><h1>All courts</h1><p class="muted">No session is live. Current games appear here once the organiser starts one.</p></div>`;
  return `${errLine("court")}
    <div class="board" style="${fit(s)}">${s.pools.map(p => {
      const r = roundInfo(s, p);
      return `<div class="stack">
        <div class="row spread bhead"><h2><a href="#/court/${p.id}">${esc(p.name)}</a></h2><span class="round">${r.finished ? "Finished" : `Round ${r.at + 1} of ${r.total}`}</span></div>
        ${r.finished ? '<div class="note">All rounds finished.</div>' : roundCards(s, p, r) + confirmBlock(s, p, r, true)}
        ${nextBox(p, r, true)}${backBlock(s, p, r)}
      </div>`;
    }).join("")}</div>`;
}

/* ---------- Standings ---------- */
function viewStandings() {
  const closed = closedSess(), last = closed[closed.length - 1], s = openSess();
  const live = s && s.status === "live" ? s : null, shown = live || last;
  const tab = app.tab === "session" && shown ? "session" : "ratings";
  const lastRec = last ? app.st.ratings.sessions[last.id] || {} : {};
  const ids = Object.keys(app.st.players).sort((a, b) => rating(b) - rating(a) || nm(a).localeCompare(nm(b)));
  const hist = tab === "ratings" ? ratingHistory() : null, charted = new Set(hist ? hist.series.map(x => x.id) : []);
  const slot = Object.fromEntries((hist ? hlList(hist) : []).map(h => [h.id, h.slot]));
  const ratings = `${hist ? ratingChart(hist) : ""}<div class="card"><div class="scroll"><table>
    <thead><tr><th>#</th><th>Player</th><th class="r">Rating</th><th class="r">Last week</th><th class="r">W-L</th></tr></thead>
    <tbody>${ids.map((id, i) => {
      const t = app.st.ratings.totals[id] || { w: 0, l: 0 }, rec = lastRec[id], ch = rec ? rec.end - rec.start : null;
      return `<tr class="${P(id).active ? "" : "off"}${charted.has(id) ? " pickable" : ""}" ${charted.has(id) ? `data-act="hl" data-pid="${id}"` : ""}><td>${i + 1}</td><td>${slot[id] ? `<i class="sw" style="background:var(--s${slot[id]})"></i>` : ""}${esc(nm(id))}${P(id).active ? "" : "<small>dropped out</small>"}</td>
        <td class="r"><b>${fmt(rating(id))}</b></td><td class="r">${ch === null ? '<span class="muted">did not play</span>' : `<span class="${ch < 0 ? "dn" : "up"}">${sgn(ch)}</span>`}</td><td class="r">${t.w}-${t.l}</td></tr>`;
    }).join("")}</tbody></table></div></div>
    <p class="muted">Ratings update when the organiser finishes a session. Every game in a session counts the same, whatever order it was played in.</p>`;
  const session = shown ? `<p class="muted">${niceDate(shown.date)}${live ? ", live" : ""}</p>
    <div class="pools">${shown.pools.map(p => `<div class="card"><h2>${esc(p.name)}</h2>${standingsTable(shown, p)}</div>`).join("")}</div>` : "";
  return `<div class="head"><h1>Standings</h1></div>
    <div class="seg" role="group" aria-label="View">
      <button data-act="tab" data-tab="ratings" aria-pressed="${tab === "ratings"}">League ratings</button>
      ${shown ? `<button data-act="tab" data-tab="session" aria-pressed="${tab === "session"}">${live ? "Tonight" : "Last session"}</button>` : ""}
    </div>
    ${tab === "ratings" ? ratings : session}`;
}

/* ---------- Ratings chart ---------- */
/* Rating after each finished session, per player. A missed week carries the rating forward. */
function ratingHistory() {
  const closed = closedSess(), recs = app.st.ratings.sessions;
  const labels = ["Start"].concat(closed.map(s => new Date(s.date + "T00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" })));
  const series = Object.keys(app.st.players).map(id => {
    let v = P(id).seed, any = false;
    const vals = [v], played = [false];
    closed.forEach(s => { const r = (recs[s.id] || {})[id]; if (r) { v = r.end; any = true; } vals.push(v); played.push(!!r); });
    return { id, vals, played, any };
  }).filter(x => x.any);
  return { labels, series };
}
/* Highlighted players. Until someone picks, the top three. A colour stays with its player while they are picked. */
function hlList(hist) {
  const ok = new Set(hist.series.map(x => x.id));
  if (!app.hl) app.hl = hist.series.slice().sort((a, b) => b.vals[b.vals.length - 1] - a.vals[a.vals.length - 1]).slice(0, 3).map((x, i) => ({ id: x.id, slot: i + 1 }));
  return app.hl.filter(h => ok.has(h.id));
}
function toggleHl(pid) {
  const list = app.hl || [], at = list.findIndex(h => h.id === pid);
  if (at >= 0) list.splice(at, 1);
  else {
    const gone = list.length >= 4 ? list.shift() : null;                    // a fifth pick takes over from the oldest
    const used = new Set(list.map(h => h.slot));
    list.push({ id: pid, slot: gone ? gone.slot : [1, 2, 3, 4].find(k => !used.has(k)) });
  }
  app.hl = list;
  render();
}
function ratingChart(hist) {
  const n = hist.labels.length;
  if (n < 2 || !hist.series.length) return "";
  const W = Math.max(280, Math.min(1400, document.documentElement.clientWidth) - 54), narrow = W < 560, H = narrow ? 300 : 380;
  const m = { l: 40, r: narrow ? 112 : 132, t: 12, b: 28 };
  const all = hist.series.flatMap(x => x.vals), lo = Math.floor((Math.min(...all) - 15) / 100) * 100, hi = Math.ceil((Math.max(...all) + 15) / 100) * 100;
  const X = i => m.l + (W - m.l - m.r) * i / (n - 1), Y = v => m.t + (H - m.t - m.b) * (hi - v) / (hi - lo), f = v => v.toFixed(1);
  const step = hi - lo > 900 ? 200 : 100, ticks = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  const picked = hlList(hist), slot = Object.fromEntries(picked.map(h => [h.id, h.slot]));
  const path = x => x.vals.map((v, i) => `${i ? "L" : "M"}${f(X(i))} ${f(Y(v))}`).join("");
  const byId = Object.fromEntries(hist.series.map(x => [x.id, x]));
  /* direct labels at the line ends, pushed apart so they never overlap */
  const ends = picked.map(h => ({ h, y: Y(byId[h.id].vals[n - 1]) })).sort((a, b) => a.y - b.y);
  ends.forEach((e, i) => { e.ly = i ? Math.max(e.y, ends[i - 1].ly + 19) : e.y; });
  for (let i = ends.length - 1; i >= 0; i--) { const cap = i === ends.length - 1 ? H - m.b : ends[i + 1].ly - 19; if (ends[i].ly > cap) ends[i].ly = cap; }
  app.chart = { xs: hist.labels.map((_, i) => X(i)), lo, hi, top: m.t, bottom: H - m.b, hist };
  return `<div class="card chartcard"><div class="row spread"><h2>Rating after each session</h2><span class="muted small">Tap a player or a line to highlight, up to four</span></div>
    <div class="legend">${picked.length ? picked.map(h => `<button class="lg" data-act="hl" data-pid="${h.id}" aria-label="Remove ${esc(nm(h.id))}"><i class="sw" style="background:var(--s${h.slot})"></i>${esc(sn(h.id))}<b>${fmt(rating(h.id))}</b><span aria-hidden="true">✕</span></button>`).join("") : '<span class="muted">No player highlighted.</span>'}</div>
    <div class="chartbox"><svg class="rchart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart of every player's rating after each session. The table below has the same numbers.">
      ${ticks.map(v => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${f(Y(v))}" y2="${f(Y(v))}"/><text class="ax" x="${m.l - 8}" y="${f(Y(v) + 4)}" text-anchor="end">${(v / 1000).toFixed(1)}</text>`).join("")}
      ${hist.labels.map((l, i) => `<text class="ax" x="${f(X(i))}" y="${H - 8}" text-anchor="${i === 0 ? "start" : "middle"}">${esc(l)}</text>`).join("")}
      <line class="xh" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>
      ${hist.series.filter(x => !slot[x.id]).map(x => `<path class="ln" d="${path(x)}"/>`).join("")}
      ${picked.map(h => `<path class="ln on" style="stroke:var(--s${h.slot})" d="${path(byId[h.id])}"/>${byId[h.id].vals.map((v, i) => `<circle class="pt" style="fill:var(--s${h.slot})" cx="${f(X(i))}" cy="${f(Y(v))}" r="4.5"/>`).join("")}`).join("")}
      ${ends.map(e => `${Math.abs(e.ly - e.y) > 3 ? `<line class="lead" x1="${f(X(n - 1) + 6)}" y1="${f(e.y)}" x2="${f(X(n - 1) + 11)}" y2="${f(e.ly)}"/>` : ""}<text class="el" x="${f(X(n - 1) + 14)}" y="${f(e.ly + 5)}">${esc(sn(e.h.id))} <tspan class="ev">${fmt(byId[e.h.id].vals[n - 1])}</tspan></text>`).join("")}
    </svg><div class="tip" hidden></div></div></div>`;
}
/* Hover and tap on the chart: a crosshair at the nearest session, the highlighted players' ratings there, and the line under the pointer. */
function chartProbe(e) {
  const svg = e.target.closest ? e.target.closest(".rchart") : null, c = app.chart;
  if (!svg || !c) return null;
  const box = svg.getBoundingClientRect(), px = e.clientX - box.left, py = e.clientY - box.top, xs = c.xs, last = xs.length - 1;
  if (px < xs[0] - 24 || px > xs[last] + 24 || py < c.top - 10 || py > c.bottom + 10) return null;
  let i = 0;
  xs.forEach((x, k) => { if (Math.abs(x - px) < Math.abs(xs[i] - px)) i = k; });
  const k = Math.max(0, Math.min(last - 1, xs.findIndex((x, j) => j < last && px <= xs[j + 1]))), t = Math.max(0, Math.min(1, (px - xs[k]) / (xs[k + 1] - xs[k])));
  const Y = v => c.top + (c.bottom - c.top) * (c.hi - v) / (c.hi - c.lo);
  let near = null, best = 14;
  for (const x of c.hist.series) { const d = Math.abs(Y(x.vals[k] + (x.vals[k + 1] - x.vals[k]) * t) - py); if (d < best) { best = d; near = x.id; } }
  return { svg, i, near, px, py, width: box.width };
}
function chartTip(e) {
  const p = chartProbe(e), old = $(".chartbox .tip");
  if (!p) { if (old && !old.hidden) { old.hidden = true; $(".rchart .xh").setAttribute("visibility", "hidden"); } return; }
  const c = app.chart, tip = $(".tip", p.svg.parentNode), xh = $(".xh", p.svg), slot = Object.fromEntries((app.hl || []).map(h => [h.id, h.slot]));
  const ids = (app.hl || []).map(h => h.id).filter(id => c.hist.series.some(x => x.id === id));
  if (p.near && !ids.includes(p.near)) ids.push(p.near);
  const row = id => {
    const x = c.hist.series.find(q => q.id === id), v = x.vals[p.i], ch = p.i ? (x.played[p.i] ? sgn(v - x.vals[p.i - 1]) : "did not play") : "seed";
    return `<span class="tr"><i class="sw" style="background:${slot[id] ? `var(--s${slot[id]})` : "var(--line-2)"}"></i><span>${esc(sn(id))}</span><b>${fmt(v)}</b><em>${ch}</em></span>`;
  };
  ids.sort((a, b) => c.hist.series.find(q => q.id === b).vals[p.i] - c.hist.series.find(q => q.id === a).vals[p.i]);
  tip.innerHTML = `<strong>${p.i ? "After " : ""}${esc(c.hist.labels[p.i])}</strong>${ids.map(row).join("") || '<span class="muted">Point at a line</span>'}`;
  tip.hidden = false;
  xh.setAttribute("x1", c.xs[p.i]); xh.setAttribute("x2", c.xs[p.i]); xh.setAttribute("visibility", "visible");
  const left = p.px > p.width / 2;
  tip.style.left = left ? "" : `${p.px + 14}px`; tip.style.right = left ? `${p.width - p.px + 14}px` : "";
  tip.style.top = `${Math.max(0, p.py - 20)}px`;
}

/* ---------- Organiser ---------- */
function viewOrg(sub, arg) {
  if (!isOrg()) return orgGate();
  const tabs = [["", "Session"], ["players", "Players"], ["history", "History"], ["settings", "Settings"]];
  const head = `<div class="row spread"><h1>Organiser</h1>${app.be.orgMode === "open" ? "" : `<button class="btn small" data-act="lock">${app.be.orgMode === "pin" ? "Lock" : "Sign out"}</button>`}</div>
    ${app.be.orgMode === "open" && app.be.kind !== "local" ? '<p class="note"><b>No login for now.</b> Anyone with the link can use the organiser tools on this page. An organiser login can be added later.</p>' : ""}
    <div class="tabs">${tabs.map(([k, l]) => `<a class="btn small ${(sub || "") === k ? "primary" : ""}" href="#/org${k ? "/" + k : ""}">${l}</a>`).join("")}</div>`;
  const body = sub === "players" ? orgPlayers() : sub === "history" ? orgHistory(arg) : sub === "settings" ? orgSettings() : orgSession();
  return head + body;
}

function orgGate() {
  const be = app.be;
  if (be.orgMode === "pin") {
    return `<div class="head"><h1>Organiser</h1><p class="muted">Enter the organiser PIN to manage players, pools and sessions.</p></div>
      <form class="card" data-form="pin" style="max-width:420px">
        <label class="field">PIN<input id="pin" type="password" inputmode="numeric" autocomplete="off" value="${esc(app.form.pin || "")}"></label>
        ${errLine("pin")}
        <button class="btn primary" type="submit">Unlock</button>
      </form>`;
  }
  if (be.signedInNotOrganiser()) {
    return `<div class="head"><h1>Organiser</h1><p class="muted">This account is not the organiser of this league.</p></div><div class="row"><button class="btn" data-act="lock">Sign out</button></div>`;
  }
  const create = !be.hasOrganiser();
  return `<div class="head"><h1>Organiser</h1><p class="muted">${create ? "Create the organiser account for this league. Only this account can manage players, pools and sessions." : "Sign in to manage players, pools and sessions."}</p></div>
    <form class="card" data-form="${create ? "createorg" : "signin"}" style="max-width:420px">
      <label class="field">Email<input id="email" type="email" autocomplete="username" value="${esc(app.form.email || "")}"></label>
      <label class="field">Password<input id="password" type="password" autocomplete="${create ? "new-password" : "current-password"}" value="${esc(app.form.password || "")}"></label>
      ${errLine("pin")}
      <button class="btn primary" type="submit">${create ? "Create organiser account" : "Sign in"}</button>
    </form>`;
}

function seedOptions(id) {
  const seeds = app.st.league.seeds, cur = app.form[id] ?? String(seeds[seeds.length - 1] / 1000);
  return `<select id="${id}">${seeds.map((v, i) => `<option value="${v / 1000}" ${String(v / 1000) === cur ? "selected" : ""}>Pool ${String.fromCharCode(65 + i)} level (${(v / 1000).toFixed(1)})</option>`).join("")}</select>`;
}

function orgSession() {
  const s = openSess();
  if (!s) {
    const last = closedSess().pop();
    let d = new Date();
    if (last) { d = new Date(last.date + "T00:00"); d.setDate(d.getDate() + 7); }
    const def = app.form.newdate || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return `<form class="card" data-form="create"><h2>New session</h2>
      <p class="muted">Starts with the players who came last time. You can change who is playing next.</p>
      <div class="row"><label class="field">Date<input id="newdate" type="date" value="${esc(def)}"></label></div>
      ${errLine("session")}<button class="btn primary" type="submit">Create session</button></form>`;
  }
  return s.status === "setup" ? orgSetup(s) : orgLive(s);
}

function orgSetup(s) {
  const q = (app.form.q || "").toLowerCase();
  const active = Object.values(app.st.players).filter(p => p.active).sort((a, b) => a.name.localeCompare(b.name));
  const inSet = new Set(s.attending), placed = new Set(s.pools.flatMap(p => p.players));
  const loose = s.attending.filter(p => !placed.has(p));
  const sel = app.sel && inSet.has(app.sel) ? app.sel : null;
  const games = n => (n >= 4 && n <= 12 ? null : "needs 4 to 12 players");
  const pl = (id, i) => `<li><button class="pl" draggable="true" data-act="pick" data-pid="${id}" aria-pressed="${sel === id}"><span class="rk">${i === null ? "" : i + 1}</span><span class="nm">${esc(nm(id))}</span><span class="rt">${fmt(rating(id))}</span></button></li>`;
  return `
  <div class="row spread"><h2>${niceDate(s.date)}</h2>
    ${app.confirm === "delete" ? `<span class="row"><button class="btn small danger" data-act="delete" data-sid="${s.id}">Yes, delete it</button><button class="btn small" data-act="cancel">Keep</button></span>` : `<button class="btn small" data-act="ask" data-key="delete">Delete session</button>`}</div>

  <div class="card"><div class="row spread"><h2>1. Who is playing <span class="muted num">(${s.attending.length})</span></h2>
      <span class="row"><button class="btn small" data-act="attendAll" data-sid="${s.id}" data-on="1">Everyone</button><button class="btn small" data-act="attendAll" data-sid="${s.id}" data-on="">No one</button></span></div>
    <input id="q" type="search" placeholder="Find a player" value="${esc(app.form.q || "")}" aria-label="Find a player">
    <div class="chips">${active.filter(p => !q || p.name.toLowerCase().includes(q)).map(p => `<button class="chip" data-act="attend" data-sid="${s.id}" data-pid="${p.id}" aria-pressed="${inSet.has(p.id)}"><i>✓</i><span>${esc(p.name)}</span></button>`).join("") || '<p class="muted">No player matches.</p>'}</div>
    <form class="row" data-form="addplayer" data-sid="${s.id}" style="align-items:flex-end">
      <label class="field">New player's name<input id="newname" type="text" autocomplete="off" value="${esc(app.form.newname || "")}"></label>
      <label class="field">Starting level${seedOptions("newseed")}</label>
      <button class="btn" type="submit">Add player</button>
    </form>${errLine("attend")}</div>

  <div class="card"><div class="row spread"><h2>2. Pools</h2>
      <span class="row">${s.pools.length ? `<button class="btn small" data-act="assign" data-sid="${s.id}" data-pools="${Math.max(1, s.pools.length - 1)}" aria-label="One pool fewer">−</button><span class="num">${s.pools.length} pools</span><button class="btn small" data-act="assign" data-sid="${s.id}" data-pools="${s.pools.length + 1}" aria-label="One pool more">+</button>` : ""}
      <button class="btn ${s.pools.length ? "small" : "primary"}" data-act="assign" data-sid="${s.id}">${s.pools.length ? "Re-assign by rating" : "Assign pools by rating"}</button></span></div>
    <p class="muted">${s.pools.length ? "Tap a player, then choose where to move them. Dragging works too." : "Players are ranked by rating and split into pools of about eight. You can move anyone afterwards."}</p>
    ${loose.length ? `<div class="pool warn" data-drop="none"><h3>Not in a pool yet (${loose.length})</h3><ol>${loose.map(id => pl(id, null)).join("")}</ol></div>` : ""}
    <div class="pools">${s.pools.map(p => {
      const n = p.players.length, bad = games(n);
      return `<div class="pool ${bad ? "warn" : ""}" data-drop="${p.id}">
        <div class="row spread"><h3>${esc(p.name)} <span class="muted num">(${n})</span></h3>
          <span class="seg" role="group" aria-label="${esc(p.name)} courts">${[1, 2].map(k => `<button data-act="courts" data-sid="${s.id}" data-pool="${p.id}" data-courts="${k}" aria-pressed="${p.courts === k}">${k} court${k > 1 ? "s" : ""}</button>`).join("")}</span></div>
        ${bad ? `<p class="err">${bad}</p>` : ""}
        <ol>${p.players.map((id, i) => pl(id, i)).join("")}</ol></div>`;
    }).join("")}</div>
    ${errLine("pools")}</div>

  ${sel ? `<div class="movebar" role="group" aria-label="Move player"><b>Move ${esc(nm(sel))} to</b>
    <div class="row">${s.pools.map(p => `<button class="btn" data-act="move" data-sid="${s.id}" data-pid="${sel}" data-to="${p.id}" ${p.players.includes(sel) ? "disabled" : ""}>${esc(p.name)}</button>`).join("")}
      <button class="btn" data-act="attend" data-sid="${s.id}" data-pid="${sel}" data-off="1">Not playing</button><button class="btn" data-act="cancel">Cancel</button></div></div>` : ""}

  <div class="card"><h2>3. Start</h2>
    <p class="muted">Starting creates each pool's schedule. A pool of eight plays 7 rounds: everyone partners everyone once.</p>
    ${errLine("start")}
    <button class="btn huge primary" data-act="start" data-sid="${s.id}" ${s.pools.length ? "" : "disabled"}>Start session</button></div>`;
}

function orgLive(s) {
  const pend = Object.values(s.games).filter(g => g.status === "pending").length;
  const done = Object.values(s.games).filter(g => g.status === "done").length;
  const inPools = s.pools.flatMap(p => p.players);
  const bench = Object.values(app.st.players).filter(p => p.active && !inPools.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  const opt = (id, cur) => `<option value="${id}" ${cur === id ? "selected" : ""}>${esc(nm(id))}</option>`;
  return `<div class="row spread"><h2>${niceDate(s.date)} <span class="live-dot">Live</span></h2><a class="btn small" href="#/board">Open all courts</a></div>
  <div class="card"><h2>Progress</h2>
    ${s.pools.map(p => { const r = roundInfo(s, p);
      return `<div class="row spread"><a href="#/court/${p.id}" class="back" style="min-height:0">${esc(p.name)}</a><span class="num muted">${r.finished ? "Finished" : `Round ${r.at + 1} of ${r.total}`} · ${r.done} of ${r.playable} games</span></div><span class="bar on-surface"><i style="width:${pct(r)}%"></i></span>`; }).join("")}</div>

  <div class="card"><h2>Finish the session</h2>
    <p class="muted">Finishing locks the scores and updates every rating. ${pend ? `<b>${pend} games have no score</b> and will be recorded as not played.` : "All games have a score."}</p>
    ${errLine("live")}
    ${app.confirm === "close" ? `<div class="row"><button class="btn primary" data-act="close" data-sid="${s.id}">Yes, finish and update ratings</button><button class="btn" data-act="cancel">Not yet</button></div>` : `<button class="btn primary" data-act="ask" data-key="close">Finish session</button>`}
    ${done ? "" : `<button class="btn" data-act="unstart" data-sid="${s.id}">Back to setup (no scores entered yet)</button>`}</div>

  <form class="card" data-form="sub" data-sid="${s.id}"><h2>Substitute a player</h2>
    <p class="muted">The replacement takes over every game the first player has not played yet.</p>
    <div class="row" style="align-items:flex-end">
      <label class="field">Player leaving<select id="subout"><option value="">Choose</option>${inPools.slice().sort((a, b) => nm(a).localeCompare(nm(b))).map(id => opt(id, app.form.subout)).join("")}</select></label>
      <label class="field">Replacement<select id="subin"><option value="">Choose</option>${bench.map(p => opt(p.id, app.form.subin)).join("")}</select></label>
      <button class="btn" type="submit">Substitute</button></div>
    <p class="muted">Replacement not listed? Add them under Players first.</p>${errLine("sub")}</form>

  <div class="card"><h2>Games not played</h2><p class="muted">Mark a game as not played if it will not happen tonight.</p>
    ${s.pools.map(p => { const gs = poolGames(s, p).filter(g => g.status !== "done");
      return gs.length ? `<h3>${esc(p.name)}</h3><div class="results">${gs.map(g => `<div class="res"><span class="rd">R${g.round + 1}</span><span class="who">${teamLine(g.t1)} v ${teamLine(g.t2)}${g.status === "skipped" ? ' <span class="sc muted">not played</span>' : ""}</span>
        <button class="btn small" data-act="skip" data-sid="${s.id}" data-gid="${g.id}" data-skip="${g.status === "skipped" ? "" : "1"}">${g.status === "skipped" ? "Restore" : "Not played"}</button></div>`).join("")}</div>` : ""; }).join("") || '<p class="muted">Every game has a score.</p>'}</div>`;
}

function orgPlayers() {
  const list = Object.values(app.st.players).sort((a, b) => a.name.localeCompare(b.name));
  return `<form class="card" data-form="addplayer"><h2>Add a player</h2>
      <div class="row" style="align-items:flex-end"><label class="field">Name<input id="newname" type="text" autocomplete="off" value="${esc(app.form.newname || "")}"></label>
      <label class="field">Starting level${seedOptions("newseed")}</label><button class="btn primary" type="submit">Add player</button></div>${errLine("attend")}</form>
    <div class="card"><h2>Players <span class="muted num">(${list.filter(p => p.active).length} active)</span></h2>${errLine("players")}
      <div class="results">${list.map(p => {
        const t = app.st.ratings.totals[p.id] || { w: 0, l: 0 };
        if (app.edit === p.id) return `<form class="res" data-form="rename" data-pid="${p.id}" style="grid-template-columns:1fr auto auto"><input id="rename" type="text" value="${esc(app.form.rename ?? p.name)}" aria-label="Name"><button class="btn small primary" type="submit">Save</button><button class="btn small" type="button" data-act="cancel">Cancel</button></form>`;
        return `<div class="res" style="grid-template-columns:1fr auto"><span class="who"><b>${esc(p.name)}</b> <span class="muted num">${fmt(rating(p.id))} · ${t.w}-${t.l}${p.active ? "" : " · dropped out"}</span></span>
          <span class="row"><button class="btn small" data-act="edit" data-pid="${p.id}">Rename</button><button class="btn small ${p.active ? "" : "primary"}" data-act="active" data-pid="${p.id}" data-on="${p.active ? "" : "1"}">${p.active ? "Dropped out" : "Restore"}</button></span></div>`;
      }).join("")}</div></div>`;
}

function orgHistory(sid) {
  const closed = closedSess();
  const s = sid && sessById(sid);
  if (s && s.status === "closed") {
    const latest = closed[closed.length - 1] === s;
    return `<a class="back" href="#/org/history">‹ All sessions</a><div class="row spread"><h2>${niceDate(s.date)}</h2>
      ${latest && !openSess() ? (app.confirm === "reopen" ? `<span class="row"><button class="btn small primary" data-act="reopen" data-sid="${s.id}">Yes, reopen</button><button class="btn small" data-act="cancel">Cancel</button></span>` : `<button class="btn small" data-act="ask" data-key="reopen">Reopen session</button>`) : ""}</div>
      <p class="muted">Changing a score here re-runs the ratings for this and every later session.</p>${errLine("history")}
      ${s.pools.map(p => `<div class="card"><h2>${esc(p.name)}</h2>${resultRows(s, p, "all")}</div>`).join("")}`;
  }
  return `<div class="card"><h2>Finished sessions</h2>${closed.length ? `<div class="results">${closed.slice().reverse().map(x => {
    const n = Object.values(x.games).filter(g => g.status === "done").length;
    return `<div class="res" style="grid-template-columns:1fr auto"><span class="who"><b>${shortDate(x.date)}</b> <span class="muted">${x.attending.length} players · ${n} games</span></span><a class="btn small" href="#/org/history/${x.id}">Open</a></div>`;
  }).join("")}</div>` : '<p class="muted">No finished sessions yet.</p>'}</div>`;
}

function orgSettings() {
  const lg = app.st.league;
  return `<form class="card" data-form="league"><h2>League</h2>
      <div class="row" style="align-items:flex-end"><label class="field">League name<input id="lname" type="text" value="${esc(app.form.lname ?? lg.name)}"></label>
      <label class="field">Points to win a game<input id="lpts" type="number" min="5" max="21" value="${esc(app.form.lpts ?? lg.pointsToWin)}"></label>
      <button class="btn primary" type="submit">Save</button></div>${errLine("league")}
      <div class="row spread"><span><b>Names on match screens</b><br><span class="muted">Standings and the roster always show full names.</span></span>
        <span class="seg" role="group" aria-label="Names on match screens">${[["short", "First name + initial"], ["full", "Full names"]].map(([k, l]) => `<button type="button" data-act="nameStyle" data-style="${k}" aria-pressed="${(lg.nameStyle || "short") === k}">${l}</button>`).join("")}</span></div></form>
    <div class="card"><h2>Connecting</h2>
      ${app.be.kind === "firebase" ? `<p>Everyone opens <b>${esc(location.origin + location.pathname)}</b>. Scores sync live between all phones and tablets.</p>
          ${app.be.orgMode === "open" ? '<p class="muted">Organiser login is switched off, so save a copy below before each session. The login can be switched back on later.</p>' : ""}`
        : app.be.kind === "server" ? `<p>${app.urls.length ? `Phones and tablets on the same Wi-Fi or hotspot open <b>${esc(app.urls[0])}</b>.` : "This computer has no network address right now. Connect it to Wi-Fi or a phone hotspot so other devices can join."}</p>
          <p class="muted">${app.be.orgMode === "open" ? 'The organiser PIN is switched off. To require it again, set "open" to false in data/config.json on the computer running the league.' : "The organiser PIN is stored in the file data/config.json on the computer running the league."}</p>`
        : `<p>Single-device mode. Everything is saved in this browser only, so other phones cannot see it. Add the Firebase details to config.js to share it live.</p>`}
      <p class="muted">Starting seeds are ${lg.seeds.map(v => (v / 1000).toFixed(1)).join(", ")}.</p></div>
    <div class="card"><h2>League data</h2>
      <p class="muted">Save a copy of everything, or load a league file. Loading replaces all players, sessions and scores.</p>
      <div class="row"><button class="btn" data-act="export">Save a copy</button>
        ${app.be.replaceAll ? `<label class="btn">Load a league file<input id="importfile" type="file" accept="application/json,.json" style="position:absolute;opacity:0;width:1px;height:1px"></label>` : ""}</div>
      ${app.importDoc ? `<div class="note"><b>${esc(app.importDoc.name)}</b>: ${app.importDoc.players} players, ${app.importDoc.sessions} sessions. This replaces everything in the league now.
        <div class="row" style="margin-top:10px"><button class="btn primary" data-act="import">Replace the league with this file</button><button class="btn" data-act="cancel">Cancel</button></div></div>` : ""}
      ${errLine("data")}</div>`;
}

/* ---------- score entry ---------- */
function openFlow(sid, gid) {
  const s = sessById(sid), g = s && s.games[gid];
  if (!g) return;
  app.flow = { sid, gid, step: "win", win: null, ws: app.st.league.pointsToWin, ls: null, err: "", clash: null, busy: false, wasDone: g.status === "done" };
  render();
}
function viewFlow() {
  const f = app.flow, s = sessById(f.sid), g = s && s.games[f.gid];
  if (!g) { app.flow = null; return ""; }
  const pool = s.pools.find(p => p.id === g.pool), pts = app.st.league.pointsToWin;
  const winners = f.win === 1 ? g.t1 : g.t2, losers = f.win === 1 ? g.t2 : g.t1;
  let body = "";
  if (f.step === "win") {
    body = `<h2>Who won?</h2>
      ${g.status === "done" ? `<p class="note">Currently entered as <b>${teamLine(g.t1)} ${g.s1} – ${g.s2} ${teamLine(g.t2)}</b>.</p>` : ""}
      <div class="picks"><button class="pick" data-act="fwin" data-win="1">${team(g.t1)}</button>
      <button class="pick" data-act="fwin" data-win="2">${team(g.t2)}</button></div>
      ${g.status === "done" ? `<button class="btn danger" data-act="fclear">Clear this score</button>` : ""}`;
  } else if (f.step === "score") {
    body = `<h2>Tap the <span class="hl">losing</span> score</h2>
      <div class="match is-done slim"><div class="side won"><div class="names"><em>Won</em>${team(winners)}</div><div class="pts">${pts}</div></div>
        <div class="side lost"><div class="names"><em>Lost</em>${team(losers)}</div><div class="pts ask">?</div></div></div>
      <p class="lead">First to ${pts}, win by 1. What did <b>${teamLine(losers)}</b> finish on?</p>
      <div class="keys">${Array.from({ length: pts }, (_, i) => `<button class="key" data-act="fscore" data-ls="${i}">${i}</button>`).join("")}
        <button class="key other" data-act="fother">Other score</button></div>`;
  } else if (f.step === "other") {
    const stepper = (label, key, v) => `<div class="step"><b>${label}</b><button class="key" data-act="fstep" data-key="${key}" data-d="-1" aria-label="Less">−</button><span class="val">${v}</span><button class="key" data-act="fstep" data-key="${key}" data-d="1" aria-label="More">+</button></div>`;
    body = `<h2>Set the score</h2>${stepper(teamLine(winners) + " (won)", "ws", f.ws)}${stepper(teamLine(losers), "ls", f.ls)}
      <button class="btn huge primary" data-act="fconfirm" ${f.ws > f.ls ? "" : "disabled"}>Continue</button>`;
  } else {
    body = `<h2>Save this score?</h2>
      <div class="match is-done"><div class="side won"><div class="names"><em>Won</em>${team(winners)}</div><div class="pts">${f.ws}</div></div>
        <div class="side lost"><div class="names"><em>Lost</em>${team(losers)}</div><div class="pts">${f.ls}</div></div></div>
      ${f.clash ? `<p class="err" role="alert">This game was already entered as ${teamLine(g.t1)} ${f.clash.s1} – ${f.clash.s2} ${teamLine(g.t2)}. Replace it?</p>
        <button class="btn huge primary" data-act="fsave" data-replace="1" ${f.busy ? "disabled" : ""}>Replace the score</button><button class="btn" data-act="fclose">Keep ${f.clash.s1} – ${f.clash.s2}</button>`
        : `<button class="btn huge primary" data-act="fsave" ${f.busy ? "disabled" : ""}>${f.busy ? "Saving…" : "Save score"}</button>`}`;
  }
  const back = f.step === "win" ? "" : `<button class="btn" data-act="fback">‹ Back</button>`;
  return `<div class="flow" role="dialog" aria-modal="true" aria-label="Enter score">
    <div class="flow-top">${back || "<span></span>"}<span class="where">${esc(pool ? pool.name : "")} · round ${g.round + 1}</span><button class="xbtn" data-act="fclose" aria-label="Close">✕</button></div>
    <div class="flow-body">${body}${f.err ? `<p class="err" role="alert">${esc(f.err)}</p>` : ""}</div></div>`;
}

/* ---------- render ---------- */
function render() {
  if (!app.st) return;
  const [, route, a, b] = location.hash.split("/");
  const view = route === "court" ? viewCourt(a) : route === "board" ? viewBoard() : route === "standings" ? viewStandings() : route === "org" ? viewOrg(a, b) : viewHome();
  const focused = document.activeElement && document.activeElement.id, selStart = focused && document.activeElement.selectionStart;
  $("#app").innerHTML = shell(view);
  $("#overlay").innerHTML = app.flow ? viewFlow() : "";
  document.body.style.overflow = app.flow ? "hidden" : "";
  document.title = app.st.league.name;
  if (focused && !app.flow) {
    const el = document.getElementById(focused);
    if (el) { el.focus(); try { if (selStart != null) el.setSelectionRange(selStart, selStart); } catch (e) { /* not a text input */ } }
  }
}

/* ---------- actions ---------- */
const A = {
  flow: d => openFlow(d.sid, d.gid),
  fclose: () => { app.flow = null; render(); },
  fwin: d => { const f = app.flow; f.win = +d.win; f.ws = app.st.league.pointsToWin; f.ls = null; f.step = "score"; render(); },
  fscore: d => { const f = app.flow; f.ls = +d.ls; f.ws = app.st.league.pointsToWin; f.step = "confirm"; render(); },
  fother: () => { const f = app.flow, pts = app.st.league.pointsToWin; f.ws = pts + 1; f.ls = pts - 1; f.step = "other"; render(); },
  fstep: d => { const f = app.flow; f[d.key] = Math.max(0, Math.min(60, f[d.key] + (+d.d))); render(); },
  fconfirm: () => { app.flow.step = "confirm"; render(); },
  fback: () => { const f = app.flow; f.err = ""; f.clash = null; f.step = f.step === "confirm" ? (f.ws === app.st.league.pointsToWin && f.ls < f.ws ? "score" : "other") : "win"; render(); },
  fsave: async d => {
    const f = app.flow; if (f.busy) return;
    f.busy = true; f.err = ""; render();
    const s1 = f.win === 1 ? f.ws : f.ls, s2 = f.win === 1 ? f.ls : f.ws;
    const j = await send("game.score", { sid: f.sid, gid: f.gid, s1, s2, replace: !!d.replace || f.wasDone });
    if (!app.flow) return;
    f.busy = false;
    if (j.ok) { app.flow = null; toast("Score saved"); }
    else if (j.code === "exists") f.clash = { s1: j.s1, s2: j.s2 };
    else f.err = j.message;
    render();
  },
  fclear: async () => {
    const f = app.flow, j = await send("game.clear", { sid: f.sid, gid: f.gid });
    if (j.ok) { app.flow = null; toast("Score cleared"); } else f.err = j.message;
    render();
  },
  confirmRound: d => act("court", "round.confirm", { sid: d.sid, pool: d.pool, round: +d.round }, "Round confirmed"),
  backRound: d => { app.confirm = null; return act("court", "round.back", { sid: d.sid, pool: d.pool }, "Back one round"); },
  nameStyle: d => act("league", "league.update", { nameStyle: d.style }),
  tab: d => { app.tab = d.tab; render(); },
  hl: d => toggleHl(d.pid),
  lock: async () => { await app.be.signOut(); app.form.password = ""; render(); },
  export: () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(app.st)], { type: "application/json" }));
    a.download = "league-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  import: async () => {
    const doc = app.importDoc; app.importDoc = null;
    const j = await app.be.replaceAll(doc.data);
    app.err.data = j.ok ? "" : j.message;
    if (j.ok) toast("League loaded");
    render();
  },
  ask: d => { app.confirm = d.key; render(); },
  cancel: () => { app.confirm = null; app.sel = null; app.edit = null; app.importDoc = null; render(); },
  attend: d => { if (d.off) app.sel = null; return act("attend", "session.attend", { sid: d.sid, pid: d.pid, on: d.off ? false : $(`[data-act=attend][data-pid="${d.pid}"]`)?.getAttribute("aria-pressed") !== "true" }); },
  attendAll: d => act("attend", "session.attendAll", { sid: d.sid, on: !!d.on }),
  assign: d => { app.sel = null; return act("pools", "session.assign", d.pools ? { sid: d.sid, pools: +d.pools } : { sid: d.sid }); },
  pick: d => { app.sel = app.sel === d.pid ? null : d.pid; render(); },
  move: d => { app.sel = null; return act("pools", "session.move", { sid: d.sid, pid: d.pid, to: d.to }); },
  courts: d => act("pools", "session.pool", { sid: d.sid, pool: d.pool, courts: +d.courts }),
  start: async d => { const j = await act("start", "session.start", { sid: d.sid }, "Session started"); if (j.ok) location.hash = "#/board"; },
  unstart: d => act("live", "session.unstart", { sid: d.sid }),
  delete: d => { app.confirm = null; return act("session", "session.delete", { sid: d.sid }, "Session deleted"); },
  close: async d => { app.confirm = null; const j = await act("live", "session.close", { sid: d.sid }, "Session finished. Ratings updated."); if (j.ok) { app.tab = "ratings"; location.hash = "#/standings"; } },
  reopen: async d => { app.confirm = null; const j = await act("history", "session.reopen", { sid: d.sid }, "Session reopened"); if (j.ok) location.hash = "#/org"; },
  skip: d => act("live", "game.skip", { sid: d.sid, gid: d.gid, skip: !!d.skip }),
  edit: d => { app.edit = d.pid; app.form.rename = nm(d.pid); render(); },
  active: d => act("players", "player.update", { id: d.pid, active: !!d.on }),
};

async function account(method) {
  const j = await app.be[method]({ email: (app.form.email || "").trim(), password: app.form.password || "" });
  app.err.pin = j.ok ? "" : j.message;
  if (j.ok) app.form.password = "";
  render();
}

const FORMS = {
  pin: async () => {
    const j = await app.be.signIn({ pin: (app.form.pin || "").trim() });
    app.err.pin = j.ok ? "" : j.message;
    if (j.ok) app.form.pin = "";
    render();
  },
  signin: () => account("signIn"),
  createorg: () => account("createOrganiser"),
  create: () => act("session", "session.create", { date: app.form.newdate || $("#newdate").value }),
  addplayer: async form => {
    const j = await act("attend", "player.add", { name: app.form.newname || "", seed: app.form.newseed || $("#newseed").value, sid: form.dataset.sid || undefined }, "Player added");
    if (j.ok) { app.form.newname = ""; render(); }
  },
  rename: async form => { const j = await act("players", "player.update", { id: form.dataset.pid, name: app.form.rename }); if (j.ok) { app.edit = null; render(); } },
  sub: async form => {
    if (!app.form.subout || !app.form.subin) { app.err.sub = "Choose both players."; return render(); }
    const j = await act("sub", "session.substitute", { sid: form.dataset.sid, out: app.form.subout, in: app.form.subin });
    if (j.ok) { toast(`Substituted into ${j.result.games} games`); app.form.subout = app.form.subin = ""; render(); }
  },
  league: () => act("league", "league.update", { name: app.form.lname ?? app.st.league.name, pointsToWin: app.form.lpts ?? app.st.league.pointsToWin }, "Saved"),
};

document.addEventListener("pointermove", chartTip);
document.addEventListener("click", e => {
  const p = chartProbe(e);
  if (p) { if (p.near) toggleHl(p.near); else chartTip(e); return; }
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const fn = A[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});
document.addEventListener("submit", e => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  FORMS[form.dataset.form]?.(form);
});
document.addEventListener("input", e => {
  if (!e.target.id) return;
  app.form[e.target.id] = e.target.value;
  if (e.target.id === "q") render();
});
document.addEventListener("change", async e => {
  if (e.target.id === "importfile") {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.players !== "object" || !data.sessions) throw new Error("not a league file");
      app.importDoc = { name: file.name, data, players: Object.keys(data.players).length, sessions: Object.keys(data.sessions).length };
      app.err.data = "";
    } catch (err) { app.importDoc = null; app.err.data = "That file is not a league file saved from this app."; }
    return render();
  }
  if (e.target.id) app.form[e.target.id] = e.target.value;
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && app.flow) { app.flow = null; render(); } });
document.addEventListener("dragstart", e => { const el = e.target.closest("[data-pid][draggable]"); if (el) { e.dataTransfer.setData("text/plain", el.dataset.pid); e.dataTransfer.effectAllowed = "move"; } });
document.addEventListener("dragover", e => { const z = e.target.closest("[data-drop]"); if (z) { e.preventDefault(); z.classList.add("drop"); } });
document.addEventListener("dragleave", e => { const z = e.target.closest("[data-drop]"); if (z && !z.contains(e.relatedTarget)) z.classList.remove("drop"); });
document.addEventListener("drop", e => {
  const z = e.target.closest("[data-drop]"), pid = e.dataTransfer.getData("text/plain"), s = openSess();
  if (!z || !pid || !s) return;
  e.preventDefault(); app.sel = null;
  act("pools", "session.move", { sid: s.id, pid, to: z.dataset.drop });
});
let resizeTimer = 0;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!app.flow) render(); }, 150); });
window.addEventListener("hashchange", () => { app.confirm = null; app.sel = null; app.edit = null; window.scrollTo(0, 0); render(); });

boot();
