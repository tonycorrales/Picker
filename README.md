# Sunday Slip

A three-person NFL pick'em for the Sunday slate. Everyone makes two calls per
game — who covers the spread, and whether the combined score goes over or under
the total — then locks in. Nobody sees anyone else's picks until their own are
sealed. When the games finish, every entry is graded automatically.

Two pieces:

- **`index.html`** — the page. Static; lives on GitHub Pages.
- **`worker.js`** — the picks server. A Cloudflare Worker with one KV namespace.

## Accounts

Everyone signs in with a name and password. Identity lives on the account, not
the browser, so your picks and your record follow you to any phone or laptop —
clearing your browser no longer loses your week.

A user's id is the slug of their name, which is also how entries have always
been keyed. Signing up under the name you already played as picks up your
history automatically; no migration step.

Passwords are stored as PBKDF2-SHA256 over a per-user random salt, 100k
iterations, and compared without leaking where two hashes diverge. Sessions are
opaque random tokens in KV with a 180-day TTL, sent as a bearer token.

Set a **SIGNUP_CODE** secret on the Worker (Settings → Variables and Secrets) to
require a code when registering. Without one, anybody who finds the URL can
claim a name — including a name that carries someone's history.

## How a week runs

1. **Friday 11:59pm ET**, a cron trigger wakes the Worker. It pulls the lines
   once, keeps only Sunday's games, and writes them to KV. Nothing re-reads odds
   after that, so all three of you play identical numbers no matter when you
   pick, and a line that moves Saturday changes nothing.
2. Each person signs in, picks all the games, and locks in. The entry is sealed
   server-side.
3. **Until your own picks are locked you see nobody else's.** You can see *who*
   has locked in and when — just never what they took. This is enforced in the
   Worker, not the page, so it can't be stepped around with devtools.
4. Once you're locked, everyone else's locked entries appear side by side.
5. As games go final, the page grades every entry: **% correct on spreads, %
   correct on totals, and combined**, with won-lost records underneath. It
   re-checks every 60 seconds while you have it open, so a 1:00 game grades
   while the 4:25s are still running, and stops once everything is final.
6. The **Leaderboard** ranks everyone by overall percentage, season to date.

### Deadlines are per game, not per slate

A game shuts at its own kickoff. Miss the early window and you can still pick
everything that hasn't started — you just don't get the ones already under way,
and they count 0-0 rather than as losses. You still see nobody else's picks
until you've locked your own in, so joining late never means picking with
someone else's card in front of you.

That per-game deadline is also what keeps the leaderboard honest. If picks
stayed open, someone could read a rival's percentage against known results and
work backwards to their card.

A tie against the number is a push. It counts for nobody and is left out of the
percentages rather than scored as a loss, so a 6-5-2 week reads as 55%, not 46%.

Scope is Sunday only — Thursday, Friday, Saturday and Monday games are filtered
out, using US Eastern dates so Sunday night football counts and Monday night
doesn't.

## Daily Planner

A separate little app lives in **`planner/index.html`** — a weekly routine you
check off day by day. On GitHub Pages it's at
`https://<your-github-username>.github.io/Picker/planner/`.

- **Weekly routine.** Each weekday (Mon–Sun) has its own list of tasks with a
  start time, a duration and a bucket. Every day starts from its weekday's
  routine. "Copy from…" clones one day's routine into another.
- **Days.** Check tasks off, add notes ("Leg day"), add one-off tasks, or move
  and resize them — in the editor (with *push later tasks by the same amount*
  for when the gym runs long) or by dragging on the Timeline. Edits to a day
  stay on that date; "Make this my Tuesday routine" promotes them.
- **Buckets and goals.** Buckets (Faith, Career, Diet, Indoor/Outside exercise…)
  color the tasks. A goal adds up the *checked-off* tasks in one or more buckets,
  as minutes or as a count — e.g. Exercise = 1h across both exercise buckets,
  Meals = 4 Diet tasks. The goal bars show done over planned.

Everything is stored in the browser's localStorage, per device. Use
**Export / Import** (the sliders button) to back up or move to another device.

## Setup

### 1. The Worker (about five minutes, free, no card)

1. Sign up at [cloudflare.com](https://cloudflare.com).
2. **Storage & Databases → KV → Create a namespace.** Call it `sunday-slip`.
3. **Compute (Workers) → Create → start from "Hello World"**, name it
   `sunday-slip`, deploy it.
4. **Edit code**, replace everything with the contents of `worker.js`, deploy.
5. **Settings → Bindings → Add → KV namespace.** Variable name must be exactly
   `PICKS`; pick the namespace from step 2. Deploy again.
6. **Settings → Triggers → Cron Triggers → Add.** Add `59 3 * * SAT`, then add
   `59 4 * * SAT`. Friday 11:59pm ET is Saturday in UTC, hence SAT. (Cloudflare's
   weekday field runs 1-7 with 1 = Sunday, not the usual 0-6, so a plain number
   is easy to get wrong; the abbreviation sidesteps it.) In winter the first one
   lands at 10:59pm ET rather than 11:59 — an hour early on a Friday night,
   which costs nothing.
7. Copy the Worker's URL — `https://sunday-slip.<something>.workers.dev`.

Visiting that URL in a browser should return `{"ok":true,...}`. If it says
`KV namespace PICKS is not bound`, step 5 didn't take.

### 2. The page

1. Put the Worker URL into `API_BASE` near the top of the `<script>` in
   `index.html`. While it's blank the page runs as a read-only preview and
   nothing can be locked in.
2. **Settings → Pages** on this repo → Source: *Deploy from a branch* → branch
   `claude/nfl-picks-picker-v63p8o`, folder `/ (root)` → Save.
3. Send your friends `https://<your-github-username>.github.io/Picker/`.

### 3. Trying it before Sunday

The board only opens when the cron runs. To force it early for a test:

```
curl -X POST https://sunday-slip.<something>.workers.dev/api/board
```

That freezes **whatever the lines are right now**, and the first write wins — so
if you do this midweek, delete the `board:<season>-<week>` key in the KV
namespace afterward, or Sunday's cron will have nothing to do and you'll all
play stale numbers.

## Notes

- Names are claimed once, by account. Sign in from as many devices as you like.
- Entries can't be changed once locked, and you get one entry per week — you
  can't lock the early games and top up later.
- Storage is tiny — one board and three entries per week, well inside KV's free
  tier.

## API

| Route | What it does |
|---|---|
| `GET /api/week?season&week&name&secret` | Board, your entry, the roster, and — only if you're locked — everyone's entries |
| `POST /api/board` | Freeze this week's lines. First call wins; later calls no-op |
| `GET /api/scores?season&week` | Final scores for grading |
| `POST /api/register` · `/api/login` · `/api/logout` · `/api/me` | Accounts and sessions |
| `POST /api/lock` | Seal the signed-in user's entry (games already kicked off are dropped) |
| `GET /api/leaderboard?season` | Season-to-date standings, ranked on overall % |

Lines and scores come from ESPN's public scoreboard endpoint, which needs no key
and no signup. Spreads and totals are DraftKings' numbers as ESPN publishes them.
Note that ESPN drops the odds from a game once it finishes, which is exactly why
the board is frozen at pick time rather than re-read later.
