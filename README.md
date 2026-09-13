# Sunday Slip

A one-page NFL pick'em against the spread. Your friend opens a link, taps a side
for each game, and gets a summary he can copy, text, or email to you.

No accounts, no server, no build step — `index.html` is the whole app.

## Sending it to someone

1. Open the page and click **Set the lines**.
2. Put this week's games in the box, one per line:

   ```
   Bills -1.5 vs Texans, Sun 1:00 PM ET
   Falcons vs Steelers -6.5, Sun 1:00 PM ET
   ```

   Put the spread on the favorite — the other side flips to `+` automatically.
   The kickoff note after the comma is optional. `PK` works for a pick'em.
3. Click **Copy link to send** and text him the link. The lines ride along in
   the URL, so he sees exactly the board you built.

## Hosting it

Anywhere that serves a static file. GitHub Pages: repo Settings → Pages → deploy
from the branch root, then the page is at
`https://<user>.github.io/Picker/`.

Opening `index.html` straight off disk works too, but the share link is only
useful once the file lives at a URL.

## Config

Two constants at the top of the `<script>` in `index.html`:

- `SEND_TO` — the address the **Email picks** button opens a draft to. Set it to
  `""` to drop that button.
- `DEFAULT_SLATE` — the board shown when no `?g=` link is used.
