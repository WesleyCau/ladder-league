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
  flow: null,        // score entry overlay
  sel: null,         // player picked up for a move (organiser)
  confirm: null,     // key of the action waiting for a second tap
  edit: null,        // player id being renamed
  form: {},          // values of inputs with an id, kept across re-renders
  err: {},           // message per area
  tab: "ratings",
};

/* ---------- backend ---------- */
async function send(type, args = {}) {
  if (!app.be) return { ok: false, code: "offline", message: "Still loading. Try again in a moment." };
  return app.be.send(type, args);
}
const isOrg = () => !!app.be && app.be.isOrg();
function accept(j) { app.st = j.state; app.urls = j.urls || []; render(); }
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
const rating = id => app.st.ratings.current[id] ?? P(id).seed;
const openSess = () => app.st.sessions.find(s => s.status !== "closed");
const closedSess = () => app.st.sessions.filter(s => s.status === "closed").sort((a, b) => (a.date + a.id < b.date + b.id ? -1 : 1));
const sessById = id => app.st.sessions.find(s => s.id === id);
const poolGames = (s, pool) => (pool.rounds || []).flat().map(id => s.games[id]);
const team = ids => ids.map(id => `<span>${esc(nm(id))}</span>`).join("");
const teamLine = ids => ids.map(nm).map(esc).join(" / ");
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
  const button = opts.preview ? "" : skipped ? '<p class="muted">Marked as not played.</p>'
    : `<button class="btn ${done ? "" : "huge primary"}" data-act="flow" data-sid="${s.id}" data-gid="${g.id}">${done ? "Change this score" : "Enter score"}</button>`;
  return `<div class="match ${done ? "is-done" : skipped ? "is-skipped" : opts.preview ? "is-preview" : "is-live"}">
    ${opts.label ? `<span class="tag">${opts.label}</span>` : ""}
    ${side(g.t1, g.s1, g.s1 > g.s2)}${side(g.t2, g.s2, g.s2 > g.s1)}${button}</div>`;
}
function roundCards(s, pool, r) {
  let waiting = 0;
  return r.games.map((g, i) => {
    const label = g.status === "done" ? "Score entered" : g.status === "skipped" ? "Not played"
      : pool.courts > 1 ? `Court ${i + 1}` : waiting++ === 0 ? "On court now" : "On court next";
    return matchCard(s, g, { label });
  }).join("");
}
function confirmBlock(s, pool, r) {
  if (r.finished) return "";
  const label = r.at + 1 < r.total ? `Confirm scores and start round ${r.at + 2}` : "Confirm scores and finish";
  return r.ready ? `<button class="btn huge primary" data-act="confirmRound" data-sid="${s.id}" data-pool="${pool.id}" data-round="${r.at}">${label}</button>`
    : `<p class="hint">${r.waiting === 1 ? "One score to go." : `${r.waiting} scores to go.`} Scores stay here until the round is confirmed.</p>`;
}
/* Organiser only: step a pool back a round after a confirm made too early. */
function backBlock(s, pool, r) {
  if (!isOrg() || r.at === 0) return "";
  const key = "back-" + pool.id;
  return app.confirm === key
    ? `<div class="row orgrow"><span class="muted">Go back to round ${r.at}? Scores are kept.</span><button class="btn small" data-act="backRound" data-sid="${s.id}" data-pool="${pool.id}">Yes, go back</button><button class="btn small" data-act="cancel">No</button></div>`
    : `<div class="row orgrow"><button class="btn small" data-act="ask" data-key="${key}">Organiser: back to round ${r.at}</button></div>`;
}
const namesList = ids => ids.map(nm).map(esc).join(", ");
function standingsTable(s, pool) {
  const rows = poolTable(s, pool);
  return `<div class="scroll"><table>
    <thead><tr><th>#</th><th>Player</th><th class="r">W</th><th class="r">L</th><th class="r">PF</th><th class="r">PA</th><th class="r">+/-</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(nm(r.p))}</td><td class="r">${r.w}</td><td class="r">${r.l}</td><td class="r">${r.pf}</td><td class="r">${r.pa}</td><td class="r">${r.pf - r.pa > 0 ? "+" : ""}${r.pf - r.pa}</td></tr>`).join("")}</tbody>
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
  return `<div class="head"><h1>${niceDate(s.date)}</h1><p class="muted">Tap your pool to see who is on court and enter scores.</p></div>
    <div class="tiles">${s.pools.map(p => {
      const r = roundInfo(s, p), waiting = r.games.filter(g => g.status === "pending");
      return `<a class="tile ${r.finished ? "done" : ""}" href="#/court/${p.id}">
        <span class="t-name">${esc(p.name)}</span>
        <span class="t-sub">${r.finished ? "Finished" : `Round ${r.at + 1} of ${r.total}`} · ${r.done} of ${r.playable} games</span>
        <span class="bar"><i style="width:${pct(r)}%"></i></span>
        <span class="t-now">${r.finished ? "All rounds played" : waiting.length ? waiting.map(g => `<span>${teamLine(g.t1)} <i>v</i> ${teamLine(g.t2)}</span>`).join("") : "Scores are in. Waiting for the round to be confirmed."}</span>
      </a>`;
    }).join("")}</div>
    <div class="row"><a class="btn" href="#/board">All courts on one screen</a><a class="btn" href="#/standings">Standings</a></div>${join}`;
}

/* ---------- Court ---------- */
function viewCourt(pid) {
  const s = openSess(), pool = s && s.pools.find(p => p.id === pid);
  if (!s || s.status !== "live" || !pool) return `<a class="back" href="#/">‹ All pools</a><div class="head"><h1>No live games here</h1><p class="muted">This pool is not playing right now.</p></div>`;
  const r = roundInfo(s, pool);
  return `<div class="court"><a class="back" href="#/">‹ All pools</a>
    <div class="head"><div class="row spread"><h1>${esc(pool.name)}</h1><span class="round">${r.finished ? "Finished" : `Round ${r.at + 1} of ${r.total}`}</span></div>
      <span class="bar on-surface"><i style="width:${pct(r)}%"></i></span>
      <p class="muted">${r.done} of ${r.playable} games played</p></div>
    ${r.finished ? '<div class="note"><b>All rounds finished.</b> Thanks for playing. Final standings are below.</div>' + backBlock(s, pool, r) : `
      <section class="stack">${roundCards(s, pool, r)}
        ${r.sitting.length ? `<p class="sit"><b>Sitting out</b> ${namesList(r.sitting)}</p>` : ""}
        ${errLine("court")}${confirmBlock(s, pool, r)}${backBlock(s, pool, r)}</section>`}
    ${r.next.length ? `<section class="stack"><h2 class="sub">Next: round ${r.at + 2}</h2>
        ${r.next.map(g => matchCard(s, g, { preview: true })).join("")}
        ${r.sittingNext.length ? `<p class="sit"><b>Sitting out</b> ${namesList(r.sittingNext)}</p>` : ""}</section>` : ""}
    ${r.at > 0 ? `<div class="card"><h2>Earlier rounds</h2>${resultRows(s, pool, true, r.at)}</div>` : ""}
    <div class="card"><h2>${esc(pool.name)} standings</h2>${standingsTable(s, pool)}</div></div>`;
}

/* ---------- Board ---------- */
function viewBoard() {
  const s = openSess();
  if (!s || s.status !== "live") return `<div class="head"><h1>All courts</h1><p class="muted">No session is live. Current games appear here once the organiser starts one.</p></div>`;
  return `<div class="head"><h1>All courts</h1><p class="muted">${niceDate(s.date)}. Tap a game to enter its score.</p></div>${errLine("court")}
    <div class="board">${s.pools.map(p => {
      const r = roundInfo(s, p);
      return `<div class="stack">
        <div class="row spread"><h2><a href="#/court/${p.id}">${esc(p.name)}</a></h2><span class="round">${r.finished ? "Finished" : `Round ${r.at + 1} of ${r.total}`}</span></div>
        <span class="bar on-surface"><i style="width:${pct(r)}%"></i></span>
        ${r.finished ? '<div class="note">All rounds finished.</div>' : roundCards(s, p, r) + confirmBlock(s, p, r)}${backBlock(s, p, r)}
        ${r.next.length ? `<div class="nextlist"><b>Next round</b>${r.next.map(g => `<span>${teamLine(g.t1)} <i>v</i> ${teamLine(g.t2)}</span>`).join("")}</div>` : ""}
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
  const ratings = `<div class="card"><div class="scroll"><table>
    <thead><tr><th>#</th><th>Player</th><th class="r">Rating</th><th class="r">Last week</th><th class="r">W-L</th></tr></thead>
    <tbody>${ids.map((id, i) => {
      const t = app.st.ratings.totals[id] || { w: 0, l: 0 }, rec = lastRec[id], ch = rec ? rec.end - rec.start : null;
      return `<tr class="${P(id).active ? "" : "off"}"><td>${i + 1}</td><td>${esc(nm(id))}${P(id).active ? "" : "<small>dropped out</small>"}</td>
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

/* ---------- Organiser ---------- */
function viewOrg(sub, arg) {
  if (!isOrg()) return orgGate();
  const tabs = [["", "Session"], ["players", "Players"], ["history", "History"], ["settings", "Settings"]];
  const head = `<div class="row spread"><h1>Organiser</h1>${app.be.orgMode === "open" ? "" : `<button class="btn small" data-act="lock">${app.be.orgMode === "pin" ? "Lock" : "Sign out"}</button>`}</div>
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
      <button class="btn primary" type="submit">Save</button></div>${errLine("league")}</form>
    <div class="card"><h2>Connecting</h2>
      ${app.be.kind === "firebase" ? `<p>Everyone opens <b>${esc(location.origin + location.pathname)}</b>. Scores sync live between all phones and tablets.</p>`
        : app.be.kind === "server" ? `<p>${app.urls.length ? `Phones and tablets on the same Wi-Fi or hotspot open <b>${esc(app.urls[0])}</b>.` : "This computer has no network address right now. Connect it to Wi-Fi or a phone hotspot so other devices can join."}</p>
          <p class="muted">The organiser PIN is stored in the file data/config.json on the computer running the league.</p>`
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
    body = `<h2>What did the other pair score?</h2><p class="muted"><b>${teamLine(losers)}</b> lost to ${teamLine(winners)}, who scored ${pts}.</p>
      <div class="keys">${Array.from({ length: pts }, (_, i) => `<button class="key" data-act="fscore" data-ls="${i}">${i}</button>`).join("")}
        <button class="key other" data-act="fother">Other</button></div>`;
  } else if (f.step === "other") {
    const stepper = (label, key, v) => `<div class="step"><b>${label}</b><button class="key" data-act="fstep" data-key="${key}" data-d="-1" aria-label="Less">−</button><span class="val">${v}</span><button class="key" data-act="fstep" data-key="${key}" data-d="1" aria-label="More">+</button></div>`;
    body = `<h2>Set the score</h2>${stepper(teamLine(winners) + " (won)", "ws", f.ws)}${stepper(teamLine(losers), "ls", f.ls)}
      <button class="btn huge primary" data-act="fconfirm" ${f.ws > f.ls ? "" : "disabled"}>Continue</button>`;
  } else {
    body = `<h2>Save this score?</h2>
      <div class="match is-done"><div class="side won"><div class="names">${team(winners)}</div><div class="pts">${f.ws}</div></div>
        <div class="side lost"><div class="names">${team(losers)}</div><div class="pts">${f.ls}</div></div></div>
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
  tab: d => { app.tab = d.tab; render(); },
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

document.addEventListener("click", e => {
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
window.addEventListener("hashchange", () => { app.confirm = null; app.sel = null; app.edit = null; window.scrollTo(0, 0); render(); });

boot();
