/**
 * Sunday Slip — picks API (Cloudflare Worker + KV).
 *
 * Owns three jobs:
 *   1. Freeze the week's board. A cron trigger fires 5am ET every Sunday,
 *      pulls the lines once, keeps only that day's games, and stores them.
 *      Nothing re-reads odds after that, so all three of us play identical
 *      numbers no matter when we pick.
 *   2. Hold one sealed entry per person. Nobody sees anyone else's picks
 *      until their own are locked — enforced here, on the server, so it
 *      can't be stepped around from a browser console.
 *   3. Report final scores for grading.
 *
 * Needs one KV namespace bound as PICKS, and cron triggers 0 9 * * 0 and
 * 0 10 * * 0 (09:00 UTC is 5am ET in summer, 4am in winter; the second is
 * a harmless retry — whichever lands first wins and the other no-ops).
 */

const FEED = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

async function getFeed(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`feed HTTP ${r.status}`);
  return r.json();
}

/** Sunday games only, still to be played, with a spread posted. */
function boardFromFeed(feed) {
  const games = [];
  for (const e of feed.events || []) {
    const c = (e.competitions || [])[0];
    if (!c) continue;
    if (easternDay(e.date) !== "Sun") continue;
    const state = ((c.status || {}).type || {}).state;
    if (state && state !== "pre") continue;

    const odds = (c.odds || [])[0];
    if (!odds || odds.spread === undefined || odds.spread === null) continue;
    const favAbbr = String(odds.details || "").split(" ")[0];
    const mag = Math.abs(Number(odds.spread));

    const byHome = {};
    for (const t of c.competitors || []) {
      const tm = t.team || {};
      byHome[t.homeAway] = {
        abbr: tm.abbreviation || "",
        nick: tm.shortDisplayName || tm.name || tm.displayName || "",
        city: tm.location || "",
        color: tm.color ? `#${String(tm.color).replace(/^#/, "")}` : "",
        spread: mag ? (tm.abbreviation === favAbbr ? -mag : mag) : 0,
      };
    }
    if (!byHome.home || !byHome.away) continue;

    const bc = (c.broadcasts || [])[0];
    games.push({
      id: String(e.id),
      date: e.date,
      net: (bc && bc.names && bc.names[0]) || "",
      total: odds.overUnder === undefined || odds.overUnder === null ? null : Number(odds.overUnder),
      sides: [byHome.away, byHome.home],
    });
  }
  games.sort((a, b) => new Date(a.date) - new Date(b.date));
  return games;
}

/** Freeze this week's lines. First write wins; later calls are no-ops. */
async function freezeBoard(env) {
  const feed = await getFeed(FEED);
  const season = ((feed.season || {}).year) || new Date().getUTCFullYear();
  const week = ((feed.week || {}).number) || 0;
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

/* ---------------- state ---------------- */

/** Everything a client may know, given who is asking. */
async function weekState(env, season, week, name, secret) {
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

  const id = slug(name);
  const mine = id ? all.find((e) => e.id === id) : null;
  // A locked entry reads back only to the device that wrote it.
  const you =
    mine && mine.secret && mine.secret === secret
      ? { name: mine.name, lockedAt: mine.lockedAt, picks: mine.picks }
      : null;

  // The seal.
  const entries = you
    ? all.map((e) => ({ name: e.name, lockedAt: e.lockedAt, picks: e.picks }))
    : [];

  return { board, you, entries, roster, locked: !!you, nameTaken: !!(mine && !you) };
}

/* ---------------- routes ---------------- */

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const q = url.searchParams;

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (path === "/" || path === "/api") {
    return json({ ok: true, service: "sunday-slip", endpoints: ["/api/week", "/api/board", "/api/scores", "/api/lock"] });
  }

  /* GET /api/week?season=&week=&name=&secret=
     Omit season/week to get whichever week is currently frozen. */
  if (path === "/api/week" && request.method === "GET") {
    let season = q.get("season"), week = q.get("week");
    if (!season || !week) {
      const cur = await env.PICKS.get("current", "json");
      if (!cur) return json({ board: null, you: null, entries: [], roster: [], locked: false, pending: true });
      season = cur.season; week = cur.week;
    }
    if (badWeek(season, week)) return json({ error: "bad season or week" }, 400);
    return json(await weekState(env, season, week, q.get("name"), q.get("secret")));
  }

  /* POST /api/board — freeze now. Safe to call any number of times; only
     the first call in a week writes anything. */
  if (path === "/api/board" && request.method === "POST") {
    try {
      const res = await freezeBoard(env);
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
      const feed = await getFeed(`${FEED}?dates=${parseInt(season, 10)}&seasontype=2&week=${parseInt(week, 10)}`);
      const scores = {};
      for (const e of feed.events || []) {
        const c = (e.competitions || [])[0];
        if (!c) continue;
        const st = (c.status || {}).type || {};
        const by = {};
        for (const t of c.competitors || []) by[t.homeAway] = Number(t.score);
        scores[String(e.id)] = {
          completed: !!st.completed,
          state: st.state || "",
          away: Number.isFinite(by.away) ? by.away : null,
          home: Number.isFinite(by.home) ? by.home : null,
        };
      }
      return json({ scores });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502);
    }
  }

  /* POST /api/lock — seal one person's entry. */
  if (path === "/api/lock" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad JSON" }, 400); }
    const { season, week, name, secret, picks } = body || {};
    if (badWeek(season, week)) return json({ error: "bad season or week" }, 400);

    const id = slug(name);
    if (!id) return json({ error: "Enter a name before locking in." }, 400);
    if (!secret || String(secret).length < 8) return json({ error: "missing device key" }, 400);

    const key = weekKey(season, week);
    const board = await env.PICKS.get(`board:${key}`, "json");
    if (!board) return json({ error: "This week's board isn't open yet." }, 409);

    const prior = await env.PICKS.get(`entry:${key}:${id}`, "json");
    if (prior) {
      return json(
        prior.secret === secret
          ? { error: "You're already locked in for this week." }
          : { error: `"${prior.name}" is already locked in. Use a different name.` },
        409
      );
    }

    // Every game on the frozen board, or it isn't an entry.
    const clean = {};
    for (const g of board.games) {
      const p = (picks || {})[g.id];
      if (!p || (p.side !== 0 && p.side !== 1)) {
        return json({ error: "Every game needs a side picked." }, 400);
      }
      const needsTotal = g.total !== null && g.total !== undefined;
      if (needsTotal && p.total !== "over" && p.total !== "under") {
        return json({ error: "Every game needs an over or under." }, 400);
      }
      clean[g.id] = { side: p.side, total: needsTotal ? p.total : null };
    }

    await env.PICKS.put(
      `entry:${key}:${id}`,
      JSON.stringify({
        id,
        name: String(name).trim().slice(0, 40),
        secret: String(secret),
        lockedAt: new Date().toISOString(),
        picks: clean,
      })
    );

    return json(await weekState(env, season, week, name, secret));
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

  /** 5am ET Sunday: pull the lines once and freeze them for the week. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const res = await freezeBoard(env);
        await env.PICKS.put("current", JSON.stringify({ season: res.board.season, week: res.board.week }));
      })()
    );
  },
};
