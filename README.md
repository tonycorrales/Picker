# Sunday Slip

A one-page NFL pick'em. Your friend opens a link and makes two calls per game —
who covers the spread, and whether the combined score goes over or under the
total — then gets a summary he can copy, text, or email to you.

No accounts, no server, no build step, no API key. `index.html` is the whole app.

## Where the lines come from

The board builds itself from ESPN's public scoreboard endpoint:

```
https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
```

It needs no key and no signup, it sends `Access-Control-Allow-Origin: *` so the
browser can read it directly, and it carries everything the page needs: the
week's matchups, kickoff times, the TV network, the spread, and the over/under.
Spreads and totals are DraftKings' numbers as ESPN publishes them.

Games that have already kicked off are dropped automatically, so the board
shrinks through the day and is correct whenever it's opened. Kickoff times
render in the viewer's own timezone.

### When the fetch can't run

The page ships with a snapshot of the current week baked in. It renders
instantly from that, then swaps in live lines the moment the fetch returns — so
there's no spinner and no empty shell. A small strip under the header always
says which you're looking at:

- `WEEK 1 · LIVE LINES` — fetched just now
- `WEEK 1 · SAVED LINES FROM SEP 13 · LIVE LINES UNREACHABLE` — fell back

The fallback matters in one place in particular: inside a Claude artifact frame,
outbound requests are blocked by the content security policy, so the artifact
always shows the baked snapshot. **Host the file somewhere to get live lines.**

To refresh the baked snapshot, replace the `SNAPSHOT` object in `index.html`
with a fresh capture in the same shape.

## Hosting it

Anywhere that serves a static file. GitHub Pages: repo Settings → Pages → deploy
from the branch root, then the page is at `https://<user>.github.io/Picker/`.

Opening `index.html` off disk works too, live fetch included.

## Editing lines by hand

Only needed if the live board is wrong or missing a game. Click **Edit lines**,
where the current board is already written out in a plain text format:

```
Bills -1.5 vs Texans | 44.5 | Sun 1:00 PM
```

Matchup, then the total, then kickoff — the last two optional. Put the spread on
the favorite and the other side flips automatically; `PK` works for a pick'em.
**Copy link to send** packs those lines into a `?g=` URL, so whoever opens it
gets exactly that board instead of the live one. (That button is hidden inside
an artifact frame, where the page can't read the URL you're actually on.)

## Config

Two constants at the top of the `<script>`:

- `SEND_TO` — the address **Email picks** opens a draft to. Set it to `""` to
  drop that button.
- `FEED` — the scoreboard endpoint.
