# Where's Lange?

A one-screen, login-protected page for family and close friends: where Lange is today, what's coming up, and when he's back in SF. See [SPEC.md](SPEC.md).

## Status

Build steps 1–4 of SPEC §7 are done and tested: parsing and merge logic, the page design ("Window Seat Postcard"), the Cloudflare Worker, and the Apps Script that feeds it. Everything runs locally. Nothing is deployed and no cloud resources exist yet. Next: going live (below).

Naming: everything people see says **Where's Lange?**. The repo/folder and package name stay `wheres-langey`; the Worker is named `wheres-lange`.

## Layout

```
apps-script/src/core.js   Parsing + merge (pure functions). Runs in Apps Script and in Node for tests.
apps-script/src/Code.js   Apps Script entry points: read calendars + Navan emails, POST the status.
apps-script/src/config.js Home and metro definitions for trip tagging (no personal data).
worker/src/               Cloudflare Worker: login check, /api/status, /api/update, schema check.
public/                   The page the Worker serves: index.html, style.css, format.js (page text),
                          page.js (drawing), app.js (loads /api/status), icons, manifest, assets/.
preview/                  Design preview: the real page drawn from fixture data at chosen moments.
test/                     Vitest tests + fixtures (real Navan/Gmail formats, fake codes).
scripts/                  make-demo-data.js (preview data), post-status.js (send a status to a local Worker).
wrangler.jsonc            Worker config (no secrets).
viewers.example.json      Shape of the VIEWERS config (the real one is a Worker secret, never committed).
.dev.vars.example         Local-only settings for `npm run dev`.
```

## Run locally

Needs Node 20+.

```bash
npm install
npm test             # parsing, merge, page text and Worker tests
npm run typecheck    # Worker TypeScript
```

The whole site, as Mom would see it, at http://127.0.0.1:8787:

```bash
cp .dev.vars.example .dev.vars   # once
npm run dev                      # in one terminal
npm run post-status              # in another: sends a status built from the fixtures, as of now
```

Locally you're signed in as `DEV_USER_EMAIL` from `.dev.vars`; change it to `friend@example.com` to see a viewer with no your-city badges. The shortcut only works on localhost.

The design preview (fixture moments side by side): `npm run preview`, then open http://localhost:8765/preview/.

## Going live (Lange's steps, when ready)

1. **Cloudflare (aiEDU account):** `npx wrangler login`, then `npx wrangler kv namespace create STATUS` and paste the ID into `wrangler.jsonc`.
2. **Secrets:** `npx wrangler secret put VIEWERS` (real emails, in the shape of `viewers.example.json`) and `npx wrangler secret put UPDATE_SECRET` (a long random string; the Apps Script gets the same one).
3. **Deploy:** `npx wrangler deploy`. Until Access is on (next step), every request gets "forbidden": the Worker refuses anyone without a valid Access login.
4. **Access:** in Zero Trust, add a self-hosted application for the workers.dev hostname with a one-time-PIN policy listing the viewer emails, sessions up to 1 month. Add a service token for the Apps Script and a Service Auth policy for it. Put the team domain (`https://<team>.cloudflareaccess.com`) and the application's AUD tag into `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` in `wrangler.jsonc`, and deploy again.
5. **Check:** open the URL from a viewer email (page loads after the PIN) and from an email not on the list (blocked).
6. **Apps Script (lange@aiedu.org):** `npx clasp login`, then `npx clasp create --type standalone --title "Where's Lange" --rootDir apps-script` (writes `.clasp.json`, kept out of git). `clasp create` may replace `apps-script/appsscript.json` with a default, so restore ours with `git checkout apps-script/appsscript.json`, then `npm run gas:push`.
7. **Script properties** (Apps Script editor → Project Settings): `WORKER_URL`, `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` (the service token from step 4), `UPDATE_SECRET` (same as step 2), and `MARKER_CALENDAR_ID` once the "Where's Langey" calendar exists and is shared with lange@aiedu.org.
8. **First run:** in the editor, run `dryRun` and approve the permissions it asks for: read-only Calendar, read-only Gmail, connecting to an outside service, and managing its own triggers. Check the logged status looks right, then run `installTrigger` (updates every 30 minutes). Under Triggers, set failure notifications to "immediately" so you hear right away if an update fails.

## Animated Lange

[public/assets/lange-waving.svg](public/assets/lange-waving.svg) waves from behind the Today postcard. The animation is built into the SVG itself, and it holds still for viewers whose phone has reduce-motion turned on. To swap the drawing, replace that file. The slot (`#avatar-slot` in [public/page.js](public/page.js)) has a `data-state` of `home`, `away`, `travel-day` or `in-air`, in case a future version should change with the trip.

## How the merge works (apps-script/src/core.js)

Builds a continuous timeline, then reads "today", "home on" and trips off it.

- **Flights** (Navan calendar events) give exact movement. Gmail's duplicate events (`Flight to Washington (UA 2386)`) are ignored, since the Navan event covers the same flight. Navan emails are the backstop: for each date + route the newest email wins (confirmed vs canceled), so rebooking after a cancellation works. Email-only flights have a date but no times, so they show the destination for that day with no "in transit" note.
- **Lookback**: the Apps Script wrapper should read events from about 2 weeks back, so a trip that's already underway shows up.
- **Connections** under 6 hours are one journey: no layover city, and the travel-day note names the final stop.
- **After landing** somewhere other than home, Lange is there until the next flight out. If the next flight leaves from somewhere else, or there is none, he's there only for the arrival day; after that the default (home) applies.
- **Hotel stays and manual markers** set the place for their dates, trimmed to start when a flight lands nearby (same time zone) and end when any flight leaves. Priority: in the air > manual marker > hotel > flight arrival > home.
- **Trips** ("Coming up" rows) run from the departure date to the landing date, in Pacific time. Back-to-back travel is split into a row per US state, while everywhere abroad stays together ("Hungary, Germany & Morocco"). A changeover day shows on both rows. "Back in SF" uses the whole stretch away.
- **Home on**: the trip's landing date if he lands before 6 pm Pacific, otherwise the next day.
- **Work star**: Navan bookings are work, a `[work]` marker adds the star, and a `[personal]` marker removes it from any trip it overlaps. Markers have no other tags.

## Open questions / spec deviations

- `today.transit` has a `departs` field in addition to the spec's `to` and `lands`. The page needs it to tell "flying home tonight" apart from "in the air".
- Navan's all-day Stay events are treated as end-exclusive (check-in date to check-out date). Check this against a real event; flight times override it either way.
- Cancellations match on date + route only. Navan's cancellation subjects don't include a confirmation code, so the spec's code match isn't used.
- No `[private]` tag (dropped from the spec's §4 and §5). Every trip shows its city.
- Fonts load from Google Fonts. The final page can self-host them.
