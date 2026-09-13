# Sunday Slip

A three-person NFL pick'em for the Sunday slate. Everyone makes two calls per
game — who covers the spread, and whether the combined score goes over or under
the total — then locks in. Nobody sees anyone else's picks until their own are
sealed. When the games finish, every entry is graded automatically.

Two pieces:

- **`index.html`** — the page. Static; lives on GitHub Pages.
- **`worker.js`** — the picks server. A Cloudflare Worker with one KV namespace.

## How a week runs

1. **5am ET Sunday**, a cron trigger wakes the Worker. It pulls the lines once,
   keeps only that day's games, and writes them to KV. Nothing re-reads odds
   after that, so all three of you play identical numbers no matter when you
   pick, and a line that moves at noon changes nothing.
2. Each person opens the page, enters their name, picks all the games, and locks
   in. The entry is sealed server-side.
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

## Setup

### 1. The Worker (about five minutes, free, no card)

1. Sign up at [cloudflare.com](https://cloudflare.com).
2. **Storage & Databases → KV → Create a namespace.** Call it `sunday-slip`.
3. **Compute (Workers) → Create → start from "Hello World"**, name it
   `sunday-slip`, deploy it.
4. **Edit code**, replace everything with the contents of `worker.js`, deploy.
5. **Settings → Bindings → Add → KV namespace.** Variable name must be exactly
   `PICKS`; pick the namespace from step 2. Deploy again.
6. **Settings → Triggers → Cron Triggers → Add.** Add `0 9 * * SUN`, then add
   `0 10 * * SUN`. (Cloudflare's weekday field runs 1-7 with 1 = Sunday, not
   the usual 0-6, so a plain `0` is rejected. The abbreviation sidesteps it.)
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

- Names are free text and claimed per device. The first device to lock in under
  a name owns it for that week; another device using the same name is turned
  away rather than allowed to overwrite or peek. Clearing browser data gives up
  that claim, so pick a name and stay on one device.
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
| `POST /api/lock` | Seal one person's entry (games already kicked off are dropped) |
| `GET /api/leaderboard?season` | Season-to-date standings, ranked on overall % |

Lines and scores come from ESPN's public scoreboard endpoint, which needs no key
and no signup. Spreads and totals are DraftKings' numbers as ESPN publishes them.
Note that ESPN drops the odds from a game once it finishes, which is exactly why
the board is frozen at pick time rather than re-read later.
