# Where's Lange?

A one-screen, login-protected page for family and close friends: where Lange is today, what's coming up, and when he's back in SF. See [SPEC.md](SPEC.md).

## Status

Build steps 1–2 of SPEC §7 are done: parsing + merge logic with tests, and the page design ("Window Seat Postcard": A + C combined). Nothing is deployed and no cloud resources exist yet.

Naming: everything people see says **Where's Lange?**. The repo/folder and package name stay `wheres-langey`.

## Layout

```
apps-script/src/core.js   Parsing + merge (pure functions). Runs in Apps Script and in Node for tests.
web/format.js             Status payload -> plain-language page text (shared by templates and the real page).
test/                     Vitest tests + fixtures (real Navan/Gmail formats, fake codes).
templates/lange.html      The chosen design: sky follows the time where Lange is; cards are postcards.
templates/assets/         Lange waving (animated SVG).
templates/index.html      Preview of lange.html at three moments side by side.
scripts/make-demo-data.js Regenerates templates/demo-data.js from the fixtures using the real merge code.
viewers.example.json      Shape of the VIEWERS config (real one is a Worker secret, never committed).
```

## Run

Needs Node 20+.

```bash
npm install
npm test
npm run templates   # regenerate demo data, then serve on http://localhost:8765/templates/
```

## Animated Lange

[templates/assets/lange-waving.svg](templates/assets/lange-waving.svg) waves from behind the Today postcard. The animation is built into the SVG itself, and it holds still for viewers whose phone has reduce-motion turned on. To swap the drawing, replace that file. The slot (`#avatar-slot` in [templates/render.js](templates/render.js)) has a `data-state` of `home`, `away`, `travel-day` or `in-air`, in case a future version should change with the trip.

## How the merge works (apps-script/src/core.js)

Builds a continuous timeline, then reads "today", "home on" and trips off it.

- **Flights** (Navan calendar events) give exact movement. Gmail's duplicate events (`Flight to Washington (UA 2386)`) are ignored, since the Navan event covers the same flight. Navan emails are the backstop: for each date + route the newest email wins (confirmed vs canceled), so rebooking after a cancellation works. Email-only flights have a date but no times, so they show the destination for that day with no "in transit" note.
- **Lookback**: the Apps Script wrapper should read events from about 2 weeks back, so a trip that's already underway shows up.
- **Connections** under 6 hours are one journey: no layover city, and the travel-day note names the final stop.
- **After landing** somewhere other than home, Lange is there until the next flight out. If the next flight leaves from somewhere else, or there is none, he's there only for the arrival day; after that the default (home) applies.
- **Hotel stays and manual markers** set the place for their dates, trimmed to start when a flight lands and end when one leaves. Priority: in the air > manual marker > hotel > flight arrival > home.
- **Trips** are runs of away time. A trip runs from the departure date to the landing date, in Pacific time. A 3+ city trip within one foreign country shows just the country (e.g. "Germany").
- **Home on**: the trip's landing date if he lands before 6 pm Pacific, otherwise the next day.
- **Work star**: Navan bookings are work, a `[work]` marker adds the star, and a `[personal]` marker removes it from any trip it overlaps. Markers have no other tags.

## Open questions / spec deviations

- `today.transit` has a `departs` field in addition to the spec's `to` and `lands`. The page needs it to tell "flying home tonight" apart from "in the air".
- Navan's all-day Stay events are treated as end-exclusive (check-in date to check-out date). Check this against a real event; flight times override it either way.
- Cancellations match on date + route only. Navan's cancellation subjects don't include a confirmation code, so the spec's code match isn't used.
- No `[private]` tag (dropped from the spec's §4 and §5). Every trip shows its city.
- Fonts load from Google Fonts. The final page can self-host them.
