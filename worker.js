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

/** One entry against the frozen lines and the final scores.
 *  A dead-even result is a push: it counts for nobody and is left out of
 *  the percentages rather than scored as a loss. */
function gradeEntry(board, picks, scores) {
  const out = { spread: { w: 0, l: 0, p: 0 }, total: { w: 0, l: 0, p: 0 }, graded: 0 };
  for (const g of board.games) {
    const sc = scores[g.id];
    if (!sc || !sc.completed || sc.away === null || sc.home === null) continue;
    const pick = picks[g.id];
    if (!pick) continue;
    out.graded++;

    const mine = pick.side === 0 ? sc.away : sc.home;
    const theirs = pick.side === 0 ? sc.home : sc.away;
    const margin = mine - theirs + g.sides[pick.side].spread;
    out.spread[margin > 0 ? "w" : margin < 0 ? "l" : "p"]++;

    if (g.total !== null && g.total !== undefined && pick.total) {
      const comb = sc.away + sc.home;
      out.total[
        comb > g.total ? (pick.total === "over" ? "w" : "l")
        : comb < g.total ? (pick.total === "under" ? "w" : "l")
        : "p"
      ]++;
    }
  }
  out.combined = {
    w: out.spread.w + out.total.w,
    l: out.spread.l + out.total.l,
    p: out.spread.p + out.total.p,
  };
  return out;
}

async function scoresFor(season, week) {
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
  return scores;
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

  const open = openGames(board);
  return {
    board, you, entries, roster,
    locked: !!you,
    nameTaken: !!(mine && !you),
    openIds: open.map((g) => g.id),
    closesAt: nextClose(open),
    closed: !!(board && !open.length),
  };
}

/* ---------------- routes ---------------- */

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const q = url.searchParams;

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (path === "/" || path === "/api") {
    return json({ ok: true, service: "sunday-slip", endpoints: ["/api/week", "/api/board", "/api/scores", "/api/lock", "/api/leaderboard"] });
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
    const players = {};
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
        rows = [];
        for (const ek of listed.keys) {
          const e = await env.PICKS.get(ek.name, "json");
          if (!e) continue;
          rows.push({ name: e.name, ...gradeEntry(board, e.picks, scores) });
        }
        if (allFinal && rows.length) {
          await env.PICKS.put(`graded:${season}-${week}`, JSON.stringify({ rows }));
        }
      }

      if (!rows.length) continue;
      weeks.push({ week, final: allFinal, players: rows });
      for (const r of rows) {
        const p = players[r.name] || (players[r.name] = {
          name: r.name, weeks: 0,
          spread: { w: 0, l: 0, p: 0 }, total: { w: 0, l: 0, p: 0 }, combined: { w: 0, l: 0, p: 0 },
        });
        p.weeks++;
        for (const bucket of ["spread", "total", "combined"]) {
          for (const res of ["w", "l", "p"]) p[bucket][res] += r[bucket][res];
        }
      }
    }

    weeks.sort((a, b) => a.week - b.week);
    const table = Object.values(players).sort((a, b) => {
      const ra = a.combined.w + a.combined.l, rb = b.combined.w + b.combined.l;
      return (rb ? b.combined.w / rb : -1) - (ra ? a.combined.w / ra : -1);
    });
    return json({ season, players: table, weeks });
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

    // You can join late, but only for games that haven't started. Nobody
    // picks a game with its score already on the screen.
    const open = openGames(board);
    if (!open.length) {
      return json({ error: "Every game has kicked off. Nothing left to pick this week." }, 409);
    }

    const prior = await env.PICKS.get(`entry:${key}:${id}`, "json");
    if (prior) {
      return json(
        prior.secret === secret
          ? { error: "You're already locked in for this week." }
          : { error: `"${prior.name}" is already locked in. Use a different name.` },
        409
      );
    }

    // Every game still open, or it isn't an entry. Games already under way
    // are dropped rather than rejected — they simply aren't yours to pick.
    const clean = {};
    for (const g of open) {
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
        // How many games were on the table when they locked, so a late
        // entry reads as late rather than as someone who skipped games.
        eligible: open.length,
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
