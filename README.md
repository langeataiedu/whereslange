# Where's Lange?

A one-screen, login-protected page for family and close friends: where Lange is today, what's coming up, and when he's back in SF. See [SPEC.md](SPEC.md).

## How this was built

Lange isn't a software engineer. He built this with [Claude Code](https://claude.com/claude-code), working from a written spec.

1. **Spec first.** [SPEC.md](SPEC.md) (Oct 7, 2026) describes what the page shows, where the data comes from, the privacy rules, the architecture, and a build plan for Claude Code to follow. It's the original, with viewer emails swapped for placeholders.
2. **Build in steps.** Over Oct 9–13, Claude Code followed the spec's build plan: parsing and merge logic with tests, three style templates for Lange to pick from, the Cloudflare Worker, then the Apps Script that feeds it. Lange did the account steps himself (Cloudflare, Access login, Apps Script properties) and typed every secret himself.
3. **Check, then change.** Each design change was checked in screenshots at phone width before it shipped. Lange's feedback reshaped a lot along the way: the name, the postcard design, a briefcase instead of a star, and dropping features he didn't need.
4. **Keep a record.** Every change from the spec, and the reason for it, is logged in [Changes from the Spec](https://claude.ai/code/artifact/5f0ea771-6940-4fad-88c9-b4c44ca7019a). The git history shows the code behind each one.

Good places to start reading: the spec, then [apps-script/src/core.js](apps-script/src/core.js) (how calendar events become "where is he today"), then [public/page.js](public/page.js) (how the page is drawn).

## Status

**v1 is live at https://whereslange.com** (Cloudflare Access email-PIN login; 24 viewers). All four build steps of SPEC §7 are done: parsing and merge logic, the page design ("Window Seat Postcard"), the Cloudflare Worker, and the Apps Script that feeds it every 30 minutes. 96 Vitest tests.

**Where changes from SPEC.md are tracked:** the Claude doc ["Where's Lange? — Changes from the Spec"](https://claude.ai/code/artifact/5f0ea771-6940-4fad-88c9-b4c44ca7019a) (every deviation, why, and a checklist of spec sections to update). SPEC.md is the original spec with viewer emails swapped for placeholders; the unedited original (`SPEC.private.md`) stays local and out of git. Code history is in git.

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

## Live setup

| Piece | Where |
|---|---|
| Site | https://whereslange.com and www (Worker `wheres-lange` on Lange's Cloudflare account, signed in as lange@aiedu.org). The workers.dev address is off. |
| Login | Cloudflare Zero Trust team `crimson-cake-6b80`, application "Where's Lange App": "Trusted emails" (Allow, one-time PIN, 24 emails) + "Apps Script" (Service Auth, token `apps-script`). AUD and team domain are in `wrangler.jsonc`. |
| Secrets | Worker secrets `VIEWERS` (from local `viewers.json`, gitignored) and `UPDATE_SECRET`. Apps Script properties: `WORKER_URL`, `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `UPDATE_SECRET`, `MARKER_CALENDAR_ID`. |
| Code | Private GitHub repo https://github.com/langeataiedu/whereslange (Lange's account, lange@aiedu.org); peers are added as collaborators. |
| Data | Apps Script project "Where's Lange" on lange@aiedu.org (`.clasp.json`, gitignored), trigger every 30 min. Marker calendar "Where's Langey" (langeluntao@gmail.com, shared to lange@aiedu.org). |

## Shipping a change

```bash
npm test && npm run typecheck
npx wrangler deploy        # page (public/) and Worker
npx clasp push --force     # Apps Script (core.js, Code.js, config.js)
```

- **Schema changes:** deploy the Worker first if it must accept new fields, then push the Apps Script. Run `updateStatus` in the Apps Script editor to refresh the live status right away.
- **Viewer list:** edit `viewers.json`, then `npx wrangler secret put VIEWERS < viewers.json`. Add or remove the same email in the Access "Trusted emails" policy.
- **Gotchas:** `clasp` sign-in expires under aiEDU's Workspace policy (`invalid_rapt` → `npx clasp login`). Listing `routes` in `wrangler.jsonc` turns off workers.dev unless `workers_dev` is set explicitly (it's `false` on purpose now).

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
- **Work trips (💼)**: Navan bookings count as work, a `[work]` marker adds the briefcase, and a `[personal]` marker removes it from any trip it overlaps. Markers have no other tags.
- **Markers**: every event on the "Where's Langey" calendar is a location ("Boise, ID"; the 📍 is optional there, required on the aiEDU calendar). Its Location field, if filled, is "where I'm sleeping tonight".
- **Sleeping tonight**: wherever the timeline puts him at 3 am local: hotel name, marker Location, "At home" or "Overnight flight".
- **Fun fact** (Apps Script, not core.js): a sentence from the city's Wikipedia introduction, census lines skipped, rotating daily, cached 6 hours. A failed lookup never blocks the update.

## Open questions

- Navan's all-day Stay events are treated as end-exclusive (check-in date to check-out date). Not yet checked against a real event; flight times override it either way.
- Fonts load from Google Fonts. The page could self-host them.
- All deviations from SPEC.md: see the changes doc linked under Status.
