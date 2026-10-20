/**
 * Sunday Slip — picks API (Cloudflare Worker + KV).
 *
 * Owns three jobs:
 *   1. Freeze the week's board. A cron trigger fires late Friday night ET,
 *      pulls the lines once, keeps only Sunday's games, and stores them.
 *      Nothing re-reads odds after that, so all three of us play identical
 *      numbers no matter when we pick.
 *   2. Hold one sealed entry per person. Nobody sees anyone else's picks
 *      until their own are locked — enforced here, on the server, so it
 *      can't be stepped around from a browser console.
 *   3. Report final scores for grading.
 *
 * Nightly Slip, the NBA version, runs the same game every day under
 * /api/nba/: its board freezes at 8am ET each morning instead.
 *
 * Needs one KV namespace bound as PICKS, and cron triggers 59 3 * * SAT and
 * 59 4 * * SAT for the NFL (the second is a harmless retry — whichever lands
 * first wins and the other no-ops), plus 0 12,13,14 * * * for the NBA.
 */

/* ESPN answers some hosts and not others depending on where the request
   comes from — the main host returns 403 to Cloudflare's network even
   though it is fine from a browser. So try each known host in turn and
   take the first that answers. cdn.espn.com nests the same data one
   level deeper, hence the shape tag. */
const FEEDS = [
  { base: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", shape: "site" },
  { base: "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", shape: "site" },
  { base: "https://cdn.espn.com/core/nfl/scoreboard", shape: "cdn" },
];

const NBA_FEEDS = [
  { base: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard", shape: "site" },
  { base: "https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard", shape: "site" },
  { base: "https://cdn.espn.com/core/nba/scoreboard", shape: "cdn" },
];

const UAS = [
  "curl/8.7.1",
  "Mozilla/5.0 (compatible; SundaySlip/1.0; +https://github.com/tonycorrales/Picker)",
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

const slug = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

const weekKey = (season, week) => `${parseInt(season, 10)}-${parseInt(week, 10)}`;

function badWeek(season, week) {
  const s = parseInt(season, 10), w = parseInt(week, 10);
  return !(s >= 2000 && s <= 2100 && w >= 1 && w <= 25);
}

/** Weekday in US Eastern, which is the clock the NFL schedule is written in. */
function easternDay(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    });
  } catch {
    return "";
  }
}

/* ---------------- the feed ---------------- */

function feedUrl(feed, query) {
  const u = new URL(feed.base);
  if (feed.shape === "cdn") u.searchParams.set("xhr", "1");
  if (query) for (const k of Object.keys(query)) u.searchParams.set(k, String(query[k]));
  return u.toString();
}

/** Pull the same three things out of either response shape. */
function unwrap(feed, body) {
  if (feed.shape === "cdn") {
    const sb = (body.content && body.content.sbData) || {};
    return { events: sb.events || [], season: sb.season || body.season, week: sb.week || body.week };
  }
  return { events: body.events || [], season: body.season, week: body.week };
}

/** First host to answer with games wins. emptyOk lets a host that answered
 *  with no games count as an answer — an NBA off day is a real empty
 *  slate, where an empty NFL week has only ever meant a host misbehaving. */
async function getFeed(query, feeds = FEEDS, emptyOk = false) {
  const tried = [];
  let empty = null;
  for (const feed of feeds) {
    for (const ua of UAS) {
      try {
        const r = await fetch(feedUrl(feed, query), {
          headers: { "User-Agent": ua, "Accept": "application/json" },
          cf: { cacheTtl: 0 },
        });
        if (!r.ok) { tried.push(`${new URL(feed.base).host} ${r.status}`); continue; }
        const got = unwrap(feed, await r.json());
        if (got.events.length) return got;
        empty = got;
        tried.push(`${new URL(feed.base).host} empty`);
      } catch (e) {
        tried.push(`${new URL(feed.base).host} ${String((e && e.message) || e)}`);
      }
    }
  }
  if (emptyOk && empty) return empty;
  throw new Error("no feed host answered — " + tried.join("; "));
}

/** One game as it goes on a board — both sides with their spread, the
 *  total, start time and network — or null if it has already started or
 *  has no spread posted. Shared by both leagues; the feeds are the same
 *  shape. */
function lineFromEvent(e) {
  const c = (e.competitions || [])[0];
  if (!c) return null;
  const state = ((c.status || {}).type || {}).state;
  if (state && state !== "pre") return null;

  const odds = (c.odds || [])[0];
  if (!odds || odds.spread === undefined || odds.spread === null) return null;
  const mag = Math.abs(Number(odds.spread));

  // "BOS -1.5" names the favorite. If that abbreviation matches neither
  // team, fall back to the feed's own favorite flags rather than handing
  // both sides the points.
  const favAbbr = String(odds.details || "").split(" ")[0];
  const comps = c.competitors || [];
  let favSide = (comps.find((t) => (t.team || {}).abbreviation === favAbbr) || {}).homeAway;
  if (!favSide) {
    if ((odds.homeTeamOdds || {}).favorite) favSide = "home";
    else if ((odds.awayTeamOdds || {}).favorite) favSide = "away";
  }

  const byHome = {};
  for (const t of comps) {
    const tm = t.team || {};
    byHome[t.homeAway] = {
      abbr: tm.abbreviation || "",
      nick: tm.shortDisplayName || tm.name || tm.displayName || "",
      city: tm.location || "",
      color: tm.color ? `#${String(tm.color).replace(/^#/, "")}` : "",
      spread: mag ? (t.homeAway === favSide ? -mag : mag) : 0,
    };
  }
  if (!byHome.home || !byHome.away) return null;

  const bc = (c.broadcasts || [])[0];
  return {
    id: String(e.id),
    date: e.date,
    net: (bc && bc.names && bc.names[0]) || "",
    total: odds.overUnder === undefined || odds.overUnder === null ? null : Number(odds.overUnder),
    sides: [byHome.away, byHome.home],
  };
}

/** Sunday games only, still to be played, with a spread posted. */
function boardFromFeed(feed) {
  const games = [];
  for (const e of feed.events) {
    if (easternDay(e.date) !== "Sun") continue;
    const g = lineFromEvent(e);
    if (g) games.push(g);
  }
  games.sort((a, b) => new Date(a.date) - new Date(b.date));
  return games;
}

/** Freeze this week's lines. First write wins; later calls are no-ops. */
async function freezeBoard(env, pushed) {
  // A board handed to us directly wins — it lets the week be opened even
  // when no feed host will talk to us.
  if (pushed && Array.isArray(pushed.games) && pushed.games.length) {
    const key = `board:${weekKey(pushed.season, pushed.week)}`;
    const existing = await env.PICKS.get(key, "json");
    if (existing) return { board: existing, frozen: false };
    const board = {
      season: parseInt(pushed.season, 10),
      week: parseInt(pushed.week, 10),
      games: pushed.games,
      frozenAt: new Date().toISOString(),
    };
    await env.PICKS.put(key, JSON.stringify(board));
    return { board, frozen: true };
  }

  const feed = await getFeed(null);
  const season = ((feed.season || {}).year) || feed.season || new Date().getUTCFullYear();
  const week = ((feed.week || {}).number) || feed.week || 0;
  if (badWeek(season, week)) throw new Error("feed gave no usable week");

  const key = `board:${weekKey(season, week)}`;
  const existing = await env.PICKS.get(key, "json");
  if (existing) return { board: existing, frozen: false };

  const games = boardFromFeed(feed);
  if (!games.length) throw new Error("no Sunday games with lines in the feed");

  const board = {
    season,
    week,
    games,
    frozenAt: new Date().toISOString(),
  };
  await env.PICKS.put(key, JSON.stringify(board));
  return { board, frozen: true };
}

/** Games that haven't kicked off yet — the only ones still pickable.
 *  Each game shuts on its own clock, so missing the early window costs
 *  you those games and nothing else. */
function openGames(board) {
  if (!board || !board.games) return [];
  const now = Date.now();
  return board.games.filter((g) => {
    const t = new Date(g.date).getTime();
    return Number.isFinite(t) ? t > now : true;
  });
}

/** When the next still-open game shuts. */
function nextClose(open) {
  let first = Infinity;
  for (const g of open) {
    const t = new Date(g.date).getTime();
    if (Number.isFinite(t) && t < first) first = t;
  }
  return Number.isFinite(first) ? new Date(first).toISOString() : null;
}

/* ---------------- grading ---------------- */

/** One pick against the frozen line and the final score: "w", "l", "p",
 *  or null while the game isn't final. A dead-even result is a push: it
 *  counts for nobody and is left out of percentages rather than scored as
 *  a loss. kind is "spread" (choice = side 0/1) or "total" (choice =
 *  "over"/"under"). */
function resultFor(g, kind, choice, sc) {
  if (!sc || !sc.completed || sc.away === null || sc.home === null) return null;
  if (kind === "spread") {
    if (choice !== 0 && choice !== 1) return null;
    const mine = choice === 0 ? sc.away : sc.home;
    const theirs = choice === 0 ? sc.home : sc.away;
    const margin = mine - theirs + g.sides[choice].spread;
    return margin > 0 ? "w" : margin < 0 ? "l" : "p";
  }
  if (g.total === null || g.total === undefined || (choice !== "over" && choice !== "under")) return null;
  const comb = sc.away + sc.home;
  if (comb === g.total) return "p";
  return (comb > g.total) === (choice === "over") ? "w" : "l";
}

/** A whole entry against the final scores. */
function gradeEntry(board, picks, scores) {
  const out = { spread: { w: 0, l: 0, p: 0 }, total: { w: 0, l: 0, p: 0 }, graded: 0 };
  for (const g of board.games) {
    const pick = picks[g.id];
    if (!pick) continue;
    const s = resultFor(g, "spread", pick.side, scores[g.id]);
    if (!s) continue;
    out.graded++;
    out.spread[s]++;
    const t = resultFor(g, "total", pick.total, scores[g.id]);
    if (t) out.total[t]++;
  }
  out.combined = {
    w: out.spread.w + out.total.w,
    l: out.spread.l + out.total.l,
    p: out.spread.p + out.total.p,
  };
  return out;
}

/** Score and status of every game in a feed, by game id. detail is ESPN's
 *  own one-liner — "Final", "Q3 4:12", "Halftime" — for showing live. */
function scoresFromFeed(feed) {
  const scores = {};
  for (const e of feed.events) {
    const c = (e.competitions || [])[0];
    if (!c) continue;
    const st = (c.status || {}).type || {};
    const by = {};
    for (const t of c.competitors || []) by[t.homeAway] = Number(t.score);
    scores[String(e.id)] = {
      completed: !!st.completed,
      state: st.state || "",
      detail: st.shortDetail || "",
      away: Number.isFinite(by.away) ? by.away : null,
      home: Number.isFinite(by.home) ? by.home : null,
    };
  }
  return scores;
}

async function scoresFor(season, week) {
  return scoresFromFeed(await getFeed({
    dates: parseInt(season, 10),
    seasontype: 2,
    week: parseInt(week, 10),
  }));
}

/** Season totals from graded groups — weeks or days — ranked on overall %,
 *  plus the mortal-lock table ranked on its own. unit names the counter of
 *  groups each player actually had something graded in. */
function standings(groups, unit) {
  const players = {};
  for (const grp of groups) {
    for (const r of grp.players) {
      const p = players[r.name] || (players[r.name] = {
        name: r.name, [unit]: 0,
        spread: { w: 0, l: 0, p: 0 }, total: { w: 0, l: 0, p: 0 }, combined: { w: 0, l: 0, p: 0 },
        mortal: { w: 0, l: 0, p: 0 },
      });
      // A group counts once something in it has actually been graded.
      if (r.graded > 0) p[unit]++;
      // Weeks graded before mortal locks existed have no mortal field.
      const rm = r.mortal || { w: 0, l: 0, p: 0 };
      for (const res of ["w", "l", "p"]) p.mortal[res] += rm[res];
      for (const bucket of ["spread", "total", "combined"]) {
        for (const res of ["w", "l", "p"]) p[bucket][res] += r[bucket][res];
      }
    }
  }

  const table = Object.values(players).sort((a, b) => {
    const ra = a.combined.w + a.combined.l, rb = b.combined.w + b.combined.l;
    return (rb ? b.combined.w / rb : -1) - (ra ? a.combined.w / ra : -1);
  });
  // Mortal locks rank on their own: best record first, more wins breaking
  // ties, and anyone yet to have one graded at the bottom.
  const mortal = Object.values(players)
    .map((p) => ({ name: p.name, ...p.mortal }))
    .sort((a, b) => {
      const ra = a.w + a.l, rb = b.w + b.l;
      const pa = ra ? a.w / ra : -1, pb = rb ? b.w / rb : -1;
      return pb - pa || b.w - a.w;
    });
  return { players: table, mortal };
}

/** Every pick still open, checked and trimmed to what gets stored, or an
 *  error message. Games already under way are dropped rather than
 *  rejected — they simply aren't yours to pick. */
function cleanPicks(open, picks) {
  const clean = {};
  for (const g of open) {
    const p = (picks || {})[g.id];
    if (!p || (p.side !== 0 && p.side !== 1)) return { error: "Every game needs a side picked." };
    const needsTotal = g.total !== null && g.total !== undefined;
    if (needsTotal && p.total !== "over" && p.total !== "under") {
      return { error: "Every game needs an over or under." };
    }
    clean[g.id] = { side: p.side, total: needsTotal ? p.total : null };
  }
  return { clean };
}


/* ---------------- accounts ---------------- */

/* Identity is an account, not a device. A user's id is the slug of their
   name, which is also how entries have always been keyed — so signing up
   as the name you played under last week picks your history straight up.
   Set a SIGNUP_CODE secret on the Worker to stop strangers claiming a
   name; without one, registration is open. */

const SESSION_DAYS = 180;
const PBKDF2_ITERS = 100000;
const MAX_USERS = 12;

const toHex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

function fromHex(s) {
  const a = new Uint8Array(s.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return a;
}

async function derive(password, saltHex) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromHex(saltHex), iterations: PBKDF2_ITERS, hash: "SHA-256" },
    key, 256
  );
  return toHex(bits);
}

/** Compare without leaking where two hashes diverge. */
function sameHash(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function startSession(env, userId) {
  const token = randomHex(32);
  const ttl = SESSION_DAYS * 86400;
  await env.PICKS.put(
    `session:${token}`,
    JSON.stringify({ userId, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }),
    { expirationTtl: ttl }
  );
  return token;
}

/** The signed-in user for this request, or null. */
async function whoIs(env, request, url) {
  const header = request.headers.get("Authorization") || "";
  let token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) token = url.searchParams.get("token") || "";
  if (!token) return null;

  const s = await env.PICKS.get(`session:${token}`, "json");
  if (!s || !s.userId) return null;
  if (s.expiresAt && Date.now() > new Date(s.expiresAt).getTime()) return null;

  const u = await env.PICKS.get(`user:${s.userId}`, "json");
  return u ? { id: u.id, name: u.name } : null;
}

const needAuth = () => json({ error: "Sign in first." }, 401);

async function listKeys(env, prefix) {
  const names = [];
  let cursor;
  do {
    const r = await env.PICKS.list(cursor ? { prefix, cursor } : { prefix });
    for (const k of r.keys) names.push(k.name);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return names;
}

/* Everyone with an account, as one list of ids. A day's NBA entries are
   read by key for each of these rather than found by listing KV: the free
   plan allows 1,000 list operations a day, and a page re-checking scores
   every minute through a night of games would spend that on its own.
   Built from a listing the first time it's needed, kept current on
   registration, and topped up on every NBA lock in case a write was lost. */
async function userIds(env) {
  const ids = await env.PICKS.get("users", "json");
  if (Array.isArray(ids)) return ids;
  const built = (await listKeys(env, "user:")).map((k) => k.slice("user:".length));
  await env.PICKS.put("users", JSON.stringify(built));
  return built;
}

async function addUserId(env, id) {
  const ids = await userIds(env);
  if (ids.includes(id)) return;
  ids.push(id);
  await env.PICKS.put("users", JSON.stringify(ids));
}

/* ---------------- state ---------------- */

/** Everything a client may know, given who is asking. */
async function weekState(env, season, week, user) {
  const key = weekKey(season, week);
  const board = await env.PICKS.get(`board:${key}`, "json");

  const listed = await env.PICKS.list({ prefix: `entry:${key}:` });
  const all = [];
  for (const k of listed.keys) {
    const e = await env.PICKS.get(k.name, "json");
    if (e) all.push(e);
  }
  all.sort((a, b) => String(a.lockedAt).localeCompare(String(b.lockedAt)));

  // Visible to everyone: who is in, and when. Never what they picked.
  const roster = all.map((e) => ({ name: e.name, lockedAt: e.lockedAt }));

  // A locked entry reads back to its owner's account, from any device.
  const mine = user ? all.find((e) => e.id === user.id) : null;
  const you = mine
    ? { name: mine.name, lockedAt: mine.lockedAt, picks: mine.picks }
    : null;

  // The seal.
  const entries = you
    ? all.map((e) => ({ name: e.name, lockedAt: e.lockedAt, picks: e.picks }))
    : [];

  const open = openGames(board);

  // Mortal locks: one pick per person, chosen from their own slate. Who has
  // set one is public; what they chose stays sealed until you've set yours,
  // or until the board is shut and nobody can act on it anymore.
  const ml = await env.PICKS.list({ prefix: `mortal:${key}:` });
  const mortals = [];
  for (const k of ml.keys) {
    const m = await env.PICKS.get(k.name, "json");
    if (m) mortals.push(m);
  }
  mortals.sort((a, b) => String(a.lockedAt).localeCompare(String(b.lockedAt)));
  const myMortal = user ? mortals.find((m) => m.id === user.id) || null : null;
  const strip = (m) => ({ name: m.name, gameId: m.gameId, kind: m.kind, choice: m.choice, lockedAt: m.lockedAt });
  const mortalsOpen = !!myMortal || (!!you && !!board && !open.length);

  return {
    board, you, entries, roster,
    mortal: myMortal ? strip(myMortal) : null,
    mortals: mortalsOpen ? mortals.map(strip) : [],
    mortalRoster: mortals.map((m) => ({ name: m.name, lockedAt: m.lockedAt })),
    locked: !!you,
    signedInAs: user ? user.name : null,
    openIds: open.map((g) => g.id),
    closesAt: nextClose(open),
    closed: !!(board && !open.length),
  };
}

/* ---------------- Nightly Slip (NBA) ---------------- */

/* The same game, every night of the NBA season. Boards are keyed by date
   rather than week: at 8am ET the day's lines are pulled once and frozen,
   and from there it runs like a Sunday — each game shuts at its own tip,
   entries stay sealed until yours is in, one mortal lock a day. Everything
   lives under nba: keys, so the two games never touch. */

const NBA_LINES_HOUR = 8; // ET

/** A moment's date and hour on the US Eastern clock — the one the NBA
 *  schedule is written in, and the one ESPN's dates= files games under
 *  (a 10:30pm tip belongs to that evening, not to the next UTC day). */
function eastern(when) {
  const p = {};
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(when));
  for (const x of parts) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24 };
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !isNaN(Date.parse(s));

function dayBefore(date) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The season a date falls in, named the way ESPN names it: 2026-27 is 2027. */
function nbaSeason(date) {
  const [y, m] = date.split("-").map(Number);
  return m >= 8 ? y + 1 : y;
}

/** That day's games, still to tip, with a spread posted. Preseason is left out. */
function nbaBoardFromFeed(feed, date) {
  const games = [];
  for (const e of feed.events) {
    if (eastern(e.date).date !== date) continue;
    if (e.season && e.season.type === 1) continue;
    const g = lineFromEvent(e);
    if (g) games.push(g);
  }
  games.sort((a, b) => new Date(a.date) - new Date(b.date));
  return games;
}

async function nbaScoresFor(date) {
  return scoresFromFeed(await getFeed({ dates: date.replace(/-/g, "") }, NBA_FEEDS, true));
}

/** Freeze one day's lines. First write wins; later calls are no-ops. games,
 *  if given, is stored as-is — the escape hatch for when no feed host will
 *  talk to us. Callers decide whether it's late enough in the day. */
async function freezeNbaDay(env, date, games) {
  const key = `nba:board:${date}`;
  const existing = await env.PICKS.get(key, "json");
  if (existing) return { board: existing, frozen: false };

  if (!Array.isArray(games) || !games.length) {
    const feed = await getFeed({ dates: date.replace(/-/g, "") }, NBA_FEEDS, true);
    games = nbaBoardFromFeed(feed, date);
    if (!games.length) throw new Error(`No NBA games with lines on ${date}.`);
  }

  const board = { season: nbaSeason(date), date, games, frozenAt: new Date().toISOString() };
  await env.PICKS.put(key, JSON.stringify(board));
  // The page opens on the newest board.
  const cur = await env.PICKS.get("nba:current", "json");
  if (!cur || String(cur.date) < date) await env.PICKS.put("nba:current", JSON.stringify({ date }));
  return { board, frozen: true };
}

/** Today's date if its board exists, freezing it first if it's due and
 *  nobody has — the morning trigger missed, or was never set up. Null on
 *  an off day, or when the feed won't answer; either leaves a marker for
 *  15 minutes so every page load doesn't go back to ESPN to hear it again. */
async function nbaCatchUp(env, now) {
  if (await env.PICKS.get(`nba:board:${now.date}`)) return now.date;
  if (now.hour < NBA_LINES_HOUR) return null;
  if (await env.PICKS.get(`nba:quiet:${now.date}`)) return null;
  try {
    await freezeNbaDay(env, now.date);
    return now.date;
  } catch {
    await env.PICKS.put(`nba:quiet:${now.date}`, "1", { expirationTtl: 900 });
    return null;
  }
}

/** Everyone's entry for a day, oldest lock first. */
async function nbaEntries(env, date) {
  const ids = await userIds(env);
  const got = await Promise.all(ids.map((id) => env.PICKS.get(`nba:entry:${date}:${id}`, "json")));
  return got.filter(Boolean).sort((a, b) => String(a.lockedAt).localeCompare(String(b.lockedAt)));
}

/** Everything a client may know about one day, given who is asking. */
async function nbaDayState(env, date, user) {
  const board = await env.PICKS.get(`nba:board:${date}`, "json");
  const all = board ? await nbaEntries(env, date) : [];
  const open = openGames(board);
  const closed = !!(board && !open.length);

  const mine = user ? all.find((e) => e.id === user.id) : null;
  const you = mine ? { name: mine.name, lockedAt: mine.lockedAt, picks: mine.picks } : null;

  // The seal. It lifts once your own entry is in — or once every game has
  // tipped, when nobody can act on what they'd see.
  const seen = !!you || closed;

  // Mortal locks ride on the entry. Who has set one is public; what they
  // chose stays sealed until you've set yours, or the slate is shut.
  const withMortal = all.filter((e) => e.mortal);
  const strip = (e) => ({
    name: e.name, gameId: e.mortal.gameId, kind: e.mortal.kind,
    choice: e.mortal.choice, lockedAt: e.mortal.lockedAt,
  });

  return {
    date, board, you,
    entries: seen ? all.map((e) => ({ name: e.name, lockedAt: e.lockedAt, picks: e.picks })) : [],
    roster: all.map((e) => ({ name: e.name, lockedAt: e.lockedAt })),
    mortal: mine && mine.mortal ? strip(mine) : null,
    mortals: (mine && mine.mortal) || closed ? withMortal.map(strip) : [],
    mortalRoster: withMortal.map((e) => ({ name: e.name, lockedAt: e.mortal.lockedAt })),
    locked: !!you,
    signedInAs: user ? user.name : null,
    openIds: open.map((g) => g.id),
    closesAt: nextClose(open),
    closed,
  };
}

/** A day is settled once every game on its board is final or called off
 *  (a postponed game never goes final; it just doesn't count), or once
 *  it's two days back — a game still missing by then was moved to
 *  another date and isn't coming back to this one. */
function nbaSettled(board, scores, date, today) {
  if (date < dayBefore(today)) return true;
  return board.games.every((g) => {
    const s = scores[g.id];
    return !!s && (s.completed || s.state === "post");
  });
}

/** One day graded for the leaderboard, or null if there's nothing to grade
 *  or the scores can't be had right now. */
async function gradeNbaDay(env, date, today) {
  const board = await env.PICKS.get(`nba:board:${date}`, "json");
  if (!board || !board.games || !board.games.length) return null;
  let scores;
  try { scores = await nbaScoresFor(date); }
  catch { return null; }

  const byGame = Object.fromEntries(board.games.map((g) => [g.id, g]));
  const rows = (await nbaEntries(env, date)).map((e) => {
    const mortal = { w: 0, l: 0, p: 0 };
    const m = e.mortal;
    const r = m && byGame[m.gameId] ? resultFor(byGame[m.gameId], m.kind, m.choice, scores[m.gameId]) : null;
    if (r) mortal[r]++;
    return { name: e.name, ...gradeEntry(board, e.picks, scores), mortal };
  });
  return { final: nbaSettled(board, scores, date, today), rows };
}

/** The season's days, graded. A settled day never changes, so it's graded
 *  once and kept in a single season document. Each day not yet kept costs
 *  a feed call, so at most `budget` are graded per run, newest first; the
 *  morning trigger keeps that backlog to last night, so it's rarely more
 *  than one. behind counts the days left for a later run. */
async function nbaSeasonDays(env, season, budget) {
  const today = eastern(Date.now()).date;
  const key = `nba:graded:${season}`;
  const kept = (await env.PICKS.get(key, "json")) || { days: {} };
  const dates = (await listKeys(env, "nba:board:"))
    .map((k) => k.slice("nba:board:".length))
    .filter((d) => isDate(d) && nbaSeason(d) === season)
    .sort()
    .reverse();

  const days = [];
  let dirty = false, behind = 0;
  for (const date of dates) {
    let day = kept.days[date];
    if (!day) {
      if (budget <= 0) { behind++; continue; }
      budget--;
      day = await gradeNbaDay(env, date, today);
      if (!day) continue;
      if (day.final) { kept.days[date] = day; dirty = true; }
    }
    if (day.rows.length) days.push({ date, final: day.final, players: day.rows });
  }
  if (dirty) await env.PICKS.put(key, JSON.stringify(kept));
  return { days: days.reverse(), behind };
}

/** The morning trigger: fold last night into the season, then freeze
 *  today's lines. It fires at 12:00, 13:00 and 14:00 UTC so that one of
 *  them is 8am ET whether or not daylight time is on; a run before 8am is
 *  skipped, and any after the one that froze the board is a no-op. */
async function nbaMorning(env, when) {
  const now = eastern(when);
  if (now.hour < NBA_LINES_HOUR) return;
  try { await nbaSeasonDays(env, nbaSeason(now.date), 3); } catch { /* the leaderboard catches up */ }
  await freezeNbaDay(env, now.date);
}

async function handleNba(request, env, url, path) {
  const q = url.searchParams;
  const now = eastern(Date.now());
  // The page's clock: what today is in ET, and whether its lines are due yet.
  const clock = { today: now.date, beforeLines: now.hour < NBA_LINES_HOUR, linesHour: NBA_LINES_HOUR };

  /* GET /api/nba/day?date=YYYY-MM-DD
     Omit date for the newest board: today's once its lines are set, last
     night's until then. */
  if (path === "/api/nba/day" && request.method === "GET") {
    const user = await whoIs(env, request, url);
    let date = q.get("date");
    if (date && !isDate(date)) return json({ error: "bad date" }, 400);
    if (!date) {
      const cur = await env.PICKS.get("nba:current", "json");
      date = cur && cur.date === now.date ? cur.date : (await nbaCatchUp(env, now)) || (cur && cur.date);
      if (!date) {
        return json({ board: null, you: null, entries: [], roster: [], locked: false, pending: true, signedInAs: user ? user.name : null, ...clock });
      }
    }
    return json({ ...(await nbaDayState(env, date, user)), ...clock });
  }

  /* GET /api/nba/days — every date with a board, oldest first. */
  if (path === "/api/nba/days" && request.method === "GET") {
    const dates = (await listKeys(env, "nba:board:"))
      .map((k) => k.slice("nba:board:".length))
      .filter(isDate)
      .sort();
    return json({ dates, ...clock });
  }

  /* POST /api/nba/board — freeze a day now. Body, all optional:
     { date, force, games }. date defaults to today; today's lines can't
     be frozen before 8am ET without force; games freezes a board handed
     over directly. First write wins either way. */
  if (path === "/api/nba/board" && request.method === "POST") {
    let body = null;
    try { body = await request.json(); } catch { body = null; }
    const date = (body && body.date) || now.date;
    if (!isDate(date)) return json({ error: "bad date" }, 400);
    const pushed = body && Array.isArray(body.games) && body.games.length ? body.games : null;
    const early = date > now.date || (date === now.date && now.hour < NBA_LINES_HOUR);
    if (!pushed && early && !(body && body.force)) {
      return json({ error: `Lines are set at ${NBA_LINES_HOUR}am ET.` }, 409);
    }
    try {
      return json(await freezeNbaDay(env, date, pushed));
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  }

  /* GET /api/nba/scores?date= — live and final scores for grading. */
  if (path === "/api/nba/scores" && request.method === "GET") {
    const date = q.get("date");
    if (!isDate(date)) return json({ error: "bad date" }, 400);
    try {
      return json({ scores: await nbaScoresFor(date) });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  }

  /* GET /api/nba/leaderboard?season= — season to date, every day combined.
     season defaults to the current one (2026-27 is 2027). */
  if (path === "/api/nba/leaderboard" && request.method === "GET") {
    const season = parseInt(q.get("season") || "", 10) || nbaSeason(now.date);
    if (!(season >= 2000 && season <= 2100)) return json({ error: "bad season" }, 400);
    const { days, behind } = await nbaSeasonDays(env, season, 5);
    return json({ season, ...standings(days, "days"), days, behind });
  }

  /* POST /api/nba/lock — seal the signed-in user's entry for a day. */
  if (path === "/api/nba/lock" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
    const { date, picks } = body || {};
    if (!isDate(date)) return json({ error: "bad date" }, 400);

    const user = await whoIs(env, request, url);
    if (!user) return needAuth();

    const board = await env.PICKS.get(`nba:board:${date}`, "json");
    if (!board) return json({ error: "This slate isn't open yet." }, 409);
    const open = openGames(board);
    if (!open.length) return json({ error: "Every game has tipped off. Nothing left to pick." }, 409);

    const key = `nba:entry:${date}:${user.id}`;
    if (await env.PICKS.get(key)) return json({ error: "You're already locked in for this slate." }, 409);

    const { clean, error } = cleanPicks(open, picks);
    if (error) return json({ error }, 400);

    await env.PICKS.put(key, JSON.stringify({
      id: user.id,
      name: user.name,
      lockedAt: new Date().toISOString(),
      picks: clean,
      eligible: open.length,
    }));
    await addUserId(env, user.id);
    return json({ ...(await nbaDayState(env, date, user)), ...clock });
  }

  /* POST /api/nba/mortal — one pick from your locked slate, set once. */
  if (path === "/api/nba/mortal" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
    const { date, gameId, kind } = body || {};
    if (!isDate(date)) return json({ error: "bad date" }, 400);

    const user = await whoIs(env, request, url);
    if (!user) return needAuth();

    const key = `nba:entry:${date}:${user.id}`;
    const entry = await env.PICKS.get(key, "json");
    if (!entry) return json({ error: "Lock in your slate first, then pick your mortal lock from it." }, 409);
    if (entry.mortal) return json({ error: "Your mortal lock is already set for this slate." }, 409);

    const board = await env.PICKS.get(`nba:board:${date}`, "json");
    const g = board && board.games.find((x) => x.id === String(gameId));
    if (!g) return json({ error: "That game isn't on this slate." }, 400);
    if (!openGames(board).some((x) => x.id === g.id)) {
      return json({ error: "That game has already tipped off." }, 409);
    }

    const pick = entry.picks[g.id];
    if (!pick) return json({ error: "You don't have a pick in that game." }, 400);
    let choice;
    if (kind === "spread") choice = pick.side;
    else if (kind === "total" && (pick.total === "over" || pick.total === "under")) choice = pick.total;
    else return json({ error: "Choose your spread pick or your total pick." }, 400);

    entry.mortal = { gameId: g.id, kind, choice, lockedAt: new Date().toISOString() };
    await env.PICKS.put(key, JSON.stringify(entry));
    return json({ ...(await nbaDayState(env, date, user)), ...clock });
  }

  return json({ error: "not found" }, 404);
}

/* ---------------- routes ---------------- */

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const q = url.searchParams;

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (path === "/" || path === "/api") {
    return json({ ok: true, service: "sunday-slip", endpoints: ["/api/register", "/api/login", "/api/logout", "/api/me", "/api/password", "/api/week", "/api/board", "/api/scores", "/api/lock", "/api/mortal", "/api/leaderboard", "/api/planner", "/api/nba/day", "/api/nba/days", "/api/nba/board", "/api/nba/scores", "/api/nba/lock", "/api/nba/mortal", "/api/nba/leaderboard"] });
  }

  if (path.startsWith("/api/nba/")) return handleNba(request, env, url, path);

  /* ---- accounts ---- */

  if (path === "/api/register" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
    const { username, password, code } = body || {};

    if (env.SIGNUP_CODE && String(code || "") !== String(env.SIGNUP_CODE)) {
      return json({ error: "Wrong signup code." }, 403);
    }

    const name = String(username || "").trim().slice(0, 24);
    const id = slug(name);
    if (!id) return json({ error: "Pick a name using letters or numbers." }, 400);
    if (String(password || "").length < 4) {
      return json({ error: "Password needs at least 4 characters." }, 400);
    }

    if (await env.PICKS.get(`user:${id}`)) {
      return json({ error: `"${name}" is taken. Sign in instead, or pick another name.` }, 409);
    }
    const existing = await env.PICKS.list({ prefix: "user:" });
    if (existing.keys.length >= MAX_USERS) {
      return json({ error: "This pool is full." }, 403);
    }

    const salt = randomHex(16);
    await env.PICKS.put(`user:${id}`, JSON.stringify({
      id, name, salt, hash: await derive(password, salt), createdAt: new Date().toISOString(),
    }));
    await addUserId(env, id);

    return json({ token: await startSession(env, id), user: { id, name } });
  }

  if (path === "/api/login" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
    const id = slug(body && body.username);
    const u = id ? await env.PICKS.get(`user:${id}`, "json") : null;

    // Same answer whether the name or the password was wrong.
    const fail = json({ error: "That name and password don't match." }, 401);
    if (!u) { await derive(String((body && body.password) || ""), randomHex(16)); return fail; }
    if (!sameHash(await derive(String((body && body.password) || ""), u.salt), u.hash)) return fail;

    return json({ token: await startSession(env, u.id), user: { id: u.id, name: u.name } });
  }

  if (path === "/api/logout" && request.method === "POST") {
    const header = request.headers.get("Authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : q.get("token");
    if (token) await env.PICKS.delete(`session:${token}`);
    return json({ ok: true });
  }

  if (path === "/api/me" && request.method === "GET") {
    const user = await whoIs(env, request, url);
    return json({ user, signupCodeRequired: !!env.SIGNUP_CODE });
  }

  /* POST /api/password — change your own password. Needs the current one,
     so a session left open on someone's phone can't be used to lock its
     owner out. Other signed-in devices stay signed in. */
  if (path === "/api/password" && request.method === "POST") {
    const user = await whoIs(env, request, url);
    if (!user) return needAuth();
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
    const current = String((body && body.current) || "");
    const next = String((body && body.next) || "");

    const u = await env.PICKS.get(`user:${user.id}`, "json");
    if (!u || !sameHash(await derive(current, u.salt), u.hash)) {
      return json({ error: "Current password is wrong." }, 403);
    }
    if (next.length < 4) return json({ error: "Password needs at least 4 characters." }, 400);

    const salt = randomHex(16);
    await env.PICKS.put(`user:${u.id}`, JSON.stringify({ ...u, salt, hash: await derive(next, salt) }));
    return json({ ok: true });
  }

  /* ---- Live Hard planner sync ----
     One JSON document per account: { rev, at, data }. A save names the rev
     it was based on; if another device saved in between, the save is refused
     with the current copy (409) so the client can merge and try again rather
     than silently overwriting the other device's day. */
  if (path === "/api/planner") {
    const user = await whoIs(env, request, url);
    if (!user) return needAuth();
    const key = `planner:${user.id}`;

    if (request.method === "GET") {
      return json((await env.PICKS.get(key, "json")) || { rev: 0, at: null, data: null });
    }

    if (request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
      const data = body && body.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) return json({ error: "bad planner data" }, 400);
      if (JSON.stringify(data).length > 5000000) return json({ error: "Planner data is too large to sync." }, 413);

      const cur = await env.PICKS.get(key, "json");
      const rev = cur ? cur.rev : 0;
      if (Number(body.baseRev) !== rev) {
        return json({ conflict: true, ...(cur || { rev: 0, at: null, data: null }) }, 409);
      }
      const doc = { rev: rev + 1, at: new Date().toISOString(), data };
      await env.PICKS.put(key, JSON.stringify(doc));
      return json({ rev: doc.rev, at: doc.at });
    }
  }

  /* GET /api/week?season=&week=
     Omit season/week to get whichever week is currently frozen. */
  if (path === "/api/week" && request.method === "GET") {
    const user = await whoIs(env, request, url);
    let season = q.get("season"), week = q.get("week");
    if (!season || !week) {
      const cur = await env.PICKS.get("current", "json");
      if (!cur) return json({ board: null, you: null, entries: [], roster: [], locked: false, pending: true, signedInAs: user ? user.name : null });
      season = cur.season; week = cur.week;
    }
    if (badWeek(season, week)) return json({ error: "bad season or week" }, 400);
    return json(await weekState(env, season, week, user));
  }

  /* POST /api/board — freeze now. Safe to call any number of times; only
     the first call in a week writes anything. */
  if (path === "/api/board" && request.method === "POST") {
    let pushed = null;
    try { pushed = await request.json(); } catch { pushed = null; }
    try {
      const res = await freezeBoard(env, pushed);
      await env.PICKS.put("current", JSON.stringify({ season: res.board.season, week: res.board.week }));
      return json(res);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  }

  /* GET /api/scores?season=&week= — finals for grading. */
  if (path === "/api/scores" && request.method === "GET") {
    const season = q.get("season"), week = q.get("week");
    if (badWeek(season, week)) return json({ error: "bad season or week" }, 400);
    try {
      return json({ scores: await scoresFor(season, week) });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  }

  /* GET /api/leaderboard?season= — season-to-date, every week combined. */
  if (path === "/api/leaderboard" && request.method === "GET") {
    const season = parseInt(q.get("season") || "", 10);
    if (!(season >= 2000 && season <= 2100)) return json({ error: "bad season" }, 400);

    const boards = await env.PICKS.list({ prefix: `board:${season}-` });
    const weeks = [];

    for (const k of boards.keys) {
      const week = parseInt(k.name.split("-").pop(), 10);
      const board = await env.PICKS.get(k.name, "json");
      if (!board || !board.games || !board.games.length) continue;

      // A finished week never changes, so grade it once and keep it.
      let cached = await env.PICKS.get(`graded:${season}-${week}`, "json");
      let rows, allFinal;
      if (cached) {
        rows = cached.rows;
        allFinal = true;
      } else {
        let scores;
        try { scores = await scoresFor(season, week); }
        catch { continue; }
        allFinal = board.games.every((g) => scores[g.id] && scores[g.id].completed);

        const listed = await env.PICKS.list({ prefix: `entry:${season}-${week}:` });
        const byGame = Object.fromEntries(board.games.map((g) => [g.id, g]));
        const ml = await env.PICKS.list({ prefix: `mortal:${season}-${week}:` });
        const mortalBy = {};
        for (const mk of ml.keys) {
          const m = await env.PICKS.get(mk.name, "json");
          if (m) mortalBy[m.id] = m;
        }

        rows = [];
        for (const ek of listed.keys) {
          const e = await env.PICKS.get(ek.name, "json");
          if (!e) continue;
          const mortal = { w: 0, l: 0, p: 0 };
          const m = mortalBy[e.id];
          const mr = m && byGame[m.gameId] ? resultFor(byGame[m.gameId], m.kind, m.choice, scores[m.gameId]) : null;
          if (mr) mortal[mr]++;
          rows.push({ name: e.name, ...gradeEntry(board, e.picks, scores), mortal });
        }
        if (allFinal && rows.length) {
          await env.PICKS.put(`graded:${season}-${week}`, JSON.stringify({ rows }));
        }
      }

      if (!rows.length) continue;
      weeks.push({ week, final: allFinal, players: rows });
    }

    weeks.sort((a, b) => a.week - b.week);
    return json({ season, ...standings(weeks, "weeks"), weeks });
  }

  /* POST /api/mortal — one pick from your locked slate, set once. */
  if (path === "/api/mortal" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
    const { season, week, gameId, kind } = body || {};
    if (badWeek(season, week)) return json({ error: "bad season or week" }, 400);

    const user = await whoIs(env, request, url);
    if (!user) return needAuth();

    const key = weekKey(season, week);
    const entry = await env.PICKS.get(`entry:${key}:${user.id}`, "json");
    if (!entry) return json({ error: "Lock in your slate first, then pick your mortal lock from it." }, 409);
    if (await env.PICKS.get(`mortal:${key}:${user.id}`)) {
      return json({ error: "Your mortal lock is already set for this week." }, 409);
    }

    const board = await env.PICKS.get(`board:${key}`, "json");
    const g = board && board.games.find((x) => x.id === String(gameId));
    if (!g) return json({ error: "That game isn't on this week's board." }, 400);
    if (!openGames(board).some((x) => x.id === g.id)) {
      return json({ error: "That game has already kicked off." }, 409);
    }

    const pick = entry.picks[g.id];
    if (!pick) return json({ error: "You don't have a pick in that game." }, 400);
    let choice;
    if (kind === "spread") choice = pick.side;
    else if (kind === "total" && (pick.total === "over" || pick.total === "under")) choice = pick.total;
    else return json({ error: "Choose your spread pick or your total pick." }, 400);

    await env.PICKS.put(`mortal:${key}:${user.id}`, JSON.stringify({
      id: user.id, name: user.name, gameId: g.id, kind, choice,
      lockedAt: new Date().toISOString(),
    }));
    return json(await weekState(env, season, week, user));
  }

  /* POST /api/lock — seal one person's entry. */
  if (path === "/api/lock" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
    const { season, week, picks } = body || {};
    if (badWeek(season, week)) return json({ error: "bad season or week" }, 400);

    const user = await whoIs(env, request, url);
    if (!user) return needAuth();
    const id = user.id;

    const key = weekKey(season, week);
    const board = await env.PICKS.get(`board:${key}`, "json");
    if (!board) return json({ error: "This week's board isn't open yet." }, 409);

    // You can join late, but only for games that haven't started. Nobody
    // picks a game with its score already on the screen.
    const open = openGames(board);
    if (!open.length) {
      return json({ error: "Every game has kicked off. Nothing left to pick this week." }, 409);
    }

    if (await env.PICKS.get(`entry:${key}:${id}`)) {
      return json({ error: "You're already locked in for this week." }, 409);
    }

    // Every game still open, or it isn't an entry.
    const { clean, error } = cleanPicks(open, picks);
    if (error) return json({ error }, 400);

    await env.PICKS.put(
      `entry:${key}:${id}`,
      JSON.stringify({
        id,
        name: user.name,
        lockedAt: new Date().toISOString(),
        picks: clean,
        // How many games were on the table when they locked, so a late
        // entry reads as late rather than as someone who skipped games.
        eligible: open.length,
      })
    );

    return json(await weekState(env, season, week, user));
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    try {
      if (!env || !env.PICKS) {
        return json({ error: "KV namespace PICKS is not bound to this Worker." }, 500);
      }
      return await handle(request, env);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },

  /** Two triggers share this Worker: Sunday Slip's fires late Friday night
   *  ET to freeze the week, Nightly Slip's each morning to freeze the day.
   *  They're told apart by the Eastern clock rather than the cron string,
   *  so however a trigger was typed into the dashboard, a morning run can
   *  never freeze an NFL week days early. The NBA's runs land between 7
   *  and 10am ET; nothing the NFL has ever used comes near that. */
  async scheduled(event, env, ctx) {
    const { hour } = eastern(event.scheduledTime);
    if (hour >= 6 && hour < 12) {
      ctx.waitUntil(nbaMorning(env, event.scheduledTime));
      return;
    }
    ctx.waitUntil(
      (async () => {
        const res = await freezeBoard(env);
        await env.PICKS.put("current", JSON.stringify({ season: res.board.season, week: res.board.week }));
      })()
    );
  },
};
