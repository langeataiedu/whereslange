# Where's Langey? — App Spec

Owner: Lange Luntao · Last updated: Oct 7, 2026

> This is the original spec the build started from, with viewer emails replaced by placeholders. It hasn't been updated since. What changed during the build is tracked in [Changes from the Spec](https://claude.ai/code/artifact/5f0ea771-6940-4fad-88c9-b4c44ca7019a).
Source doc: https://claude.ai/code/artifact/11643868-bb00-4625-ae02-71e18559effe

## 1. Summary

Build a one-screen, login-protected web page called **"Where's Langey?"** that answers three questions: where Lange is today, where he's going next, and when he's back in San Francisco. It updates itself from Lange's Google Calendar (Navan flight/hotel events plus occasional manual city markers) with Navan emails as a backstop. Upkeep: ~10 seconds per non-Navan trip.

**Audience:** Mom and Dad in Stockton (primary), plus ~10 close friends.

**Goals**
- Today: city and state (or city and country), or "in transit" on travel days.
- Next: upcoming trips for the next 60 days, highlighted when headed to the viewer's metro.
- Home: the date Lange is back in San Francisco.
- Near-zero maintenance.

**Non-goals**
- Live GPS.
- Hotels, venues, meetings, flight numbers, or who Lange is meeting.
- A public page. Login is required (travel dates + "away from home" is a burglary risk).
- Email features (digest, alerts, "landed safely") are a later build. v1 is the web page only.

## 2. What the page shows

Everyone on the allowlist sees the **same information**. The only per-person difference is the your-city highlight, set from the viewer's login email.

| Element | Example |
| --- | --- |
| Today | "Langey is in Washington, DC" |
| Travel-day status | "Flying home tonight, lands SFO about 10 pm" |
| Back in SF | "Home Thu, Oct 8 (tomorrow)" |
| Coming up (next 60 days) | "Nov 10–20 · Germany ★" |
| Work-trip star | ★ = work trip, so Langey is less free to meet up (one-line key on page) |
| Your-city highlight | "Near Mom & Dad" / "Your city" badge on matching trips, per viewer |
| Local time there | "4:12 pm in DC" |
| Last updated | "Updated 6:00 am today"; if >3 hours old, "may be out of date" |
| Buttons | "Text Lange" (sms: link) and "Call" (tel: link); on a your-city trip, "Let's get dinner" opens a pre-filled text |

**Rules**
- **Default:** if nothing says otherwise, Lange is home in San Francisco, CA.
- **Travel days:** "in transit" between departure and landing time; after landing, he's in the arrival city until the next flight out.
- **Work trips:** marked ★. Navan bookings are work by default. Manual tags override (see §4).
- **Metro matching:** each watched metro covers nearby airports and cities (see config, §7).
- **International:** show city + country, or country alone if no city is known.
- **Granularity:** city level only, for everyone.

## 3. Design

One scrolling phone screen, readable at arm's length, no menus. Feels like a warm postcard from "Langey" (family nickname; used in the page title and headline), not a dashboard. Most visits are a 5-second glance from a parent's phone.

**Layout (top to bottom)** — mockup with example data from Oct 7, 2026:

```
+--------------------------------------+
|           Where's Langey?            |
| +----------------------------------+ |
| | TODAY                            | |  <- biggest type, accent card
| | Washington, DC                   | |
| | 4:12 pm there                    | |
| | ( Flying home tonight, lands ~10 pm ) |  <- travel-day pill
| +----------------------------------+ |
| +----------------------------------+ |
| | BACK IN SAN FRANCISCO            | |
| | Thu, Oct 8 · tomorrow            | |  <- countdown phrasing
| +----------------------------------+ |
|  COMING UP                           |
|  Nov 10–20     Germany ★             |
|  ------------------------------      |
|  Nov 28        Sacramento            |
|  [ Near Mom & Dad ]                  |  <- per-viewer badge
|                                      |
|  ( Text Lange )   ( Call )           |
|                                      |
|        Updated 6:00 am today         |  <- freshness stamp
+--------------------------------------+
```

**Principles**
- Mobile first, base text ≥18px, high contrast.
- Answer first: the city is the biggest thing on screen.
- Plain language ("Back in SF tomorrow", never ISO dates).
- Installable web app (manifest + icon) for Add to Home Screen.
- Light and dark mode follow the phone setting.
- Nothing that looks like tracking software.
- **Visual style is open.** First build step: produce 2–3 style templates using this layout and the fixture data, for Lange to pick from.

## 4. Data sources and merge logic

Inputs, in priority order (higher wins on conflict):

1. **Manual city marker (exceptions only).** A dedicated "Where's Langey" calendar in langeluntao@gmail.com, shared with lange@aiedu.org ("See all event details"). All-day event titled `📍 City, ST` (or `📍 City, Country`) spanning the stay, only for travel Navan doesn't book. Optional title tags:
   - `[work]` → add ★
   - `[personal]` → remove ★ (also overrides Navan trips on those dates)
   - `[private]` → show "Traveling" with no city
2. **Navan hotel stays.** Events on the aiEDU primary calendar titled `Stay: <hotel name>, <city> Confirmation <code>`, with the full street address in the location field (e.g. `…, 222 M STREET NE, Washington, DC 20002, US`). Take city + state/country from the location. Drop the hotel name.
3. **Navan flights.** Events on the aiEDU primary calendar titled `Flight: SFO (UA2386) to DCA Confirmation ABC123` (timed events with real departure/arrival). Gmail also creates duplicates like `Flight to Washington (UA 2386)` — dedupe by time. Backstop: Navan emails from `no-reply@navan.com` (some flights, e.g. Nov 28 EWR→SMF, have an email but no calendar event).
4. **Default.** Home in San Francisco.

**Do not use** Google Calendar Working Location events — they are inaccurate.

**Merge (Apps Script, every 30 minutes)**
1. Read the next 60 days of events (aiEDU primary + "Where's Langey" calendar) and the last 120 days of Navan emails.
2. Build a day-by-day timeline: each date gets one place, or "in transit" during a flight.
3. Remove canceled flights (match by confirmation code where present, else date + route).
4. Group consecutive away days into trips. Tag each trip with matching metros and the work flag.
5. POST the sanitized status (§6) to the Worker. Nothing else leaves Google.

Airport code → city mapping is needed (at minimum: SFO, OAK, SJC, SCK, SMF, LAX, BUR, LGB, SNA, ONT, TUS, BOS, JFK, LGA, EWR, DCA, IAD, BWI, BTV, SEA, LAS, plus a fallback that shows the code).

## 5. Security and privacy

| Risk | Mitigation |
| --- | --- |
| Page reveals when Lange's SF home is empty | Login required via Cloudflare Access. No public URL. `noindex` + robots disallow. |
| Someone shows up at hotel/event | City level only. No hotel, venue or flight number. |
| Leaking confidential work travel | `[private]` tag shows "Traveling" with no city. |
| Exposing Navan PII (e-tickets, confirmation codes, loyalty numbers) | Parsing runs in Apps Script inside Lange's Google account. Codes used only for matching, never sent. |
| A history of movements piling up | KV holds current status only, overwritten each run. Status never committed to git. |
| Shared link / forwarded password | Per-person email login. Remove one person without affecting others. |

**Access control:** Cloudflare Access, one-time PIN (6-digit code by email), allowlist of viewer emails, session up to 1 month.

**Accounts:** Apps Script runs on lange@aiedu.org. GitHub repo (private) and Cloudflare account are aiEDU accounts (admin OK confirmed). Viewer emails live in config outside git.

## 6. Architecture

```
[Your Google account — raw data never leaves]
  Google Calendar (aiEDU primary: Navan Flight/Stay events;
                   "Where's Langey" calendar: manual markers)
  Gmail (Navan confirmations and cancellations)
        |
        v
  Apps Script (every 30 min: build timeline, strip hotels/codes/details)
        |
        |  POST /api/update  (Access service token + shared secret)
        |  body = sanitized status only
        v
[Cloudflare, free plan]
  Worker + KV (STATUS) — serves the page; keeps current status only
        ^
  Cloudflare Access — email allowlist, one-time PIN, ≤1 month sessions
        ^
  Family and friends (phone browser / home-screen icon)

GitHub (private repo, aiEDU org) — page, Worker and Apps Script code;
deploys to Cloudflare (Wrangler / GitHub Actions)
```

**Status payload (the whole public contract)**

```json
{"updated":"2026-10-07T13:00:00Z",
 "today":{"city":"Washington","region":"DC","tz":"America/New_York","work":true,
          "transit":{"to":"San Francisco","lands":"2026-10-07T21:55:00-07:00"}},
 "homeOn":"2026-10-08",
 "trips":[{"start":"2026-11-10","end":"2026-11-20","place":"Germany","work":true,"metros":[]},
          {"start":"2026-11-28","end":"2026-11-28","place":"Sacramento, CA","work":false,"metros":["stockton"]}]}
```

`transit` is omitted when not traveling. `[private]` trips have `"place":"Traveling"` and `"metros":[]`. The Worker rejects any payload with fields outside this schema.

## 7. Build handoff (Claude Code)

**Stack**
- **Worker:** TypeScript + Wrangler. Static assets + one KV namespace `STATUS`. Routes:
  - `GET /` — the page.
  - `GET /api/status` — reads KV, adds `highlight` for the viewer using the Access identity email (`ctx.access` / `Cf-Access-Authenticated-User-Email`) and the viewer config.
  - `POST /api/update` — validates shared secret + schema, writes KV. Reached by Apps Script with a Cloudflare Access service token.
- **Page:** one HTML file, plain CSS + vanilla JS, no framework. Web app manifest + icon. Title "Where's Langey?". Phone number for sms:/tel: links comes from config.
- **Apps Script:** plain JS in lange@aiedu.org, managed with `clasp`. Time-driven trigger every 30 min. Worker URL, service token and secret in Script Properties, never in code. Parsing logic in pure functions so it can be unit-tested locally (Node) with fixtures.
- **Tests:** Vitest (or similar) for parsing, merge and Worker routes.

**Viewer config** (Worker secret/env var `VIEWERS`, not committed; commit a `viewers.example.json`)

```json
{"home":{"city":"San Francisco","region":"CA"},
 "phone":"<Lange's cell, E.164>",
 "viewers":{
   "mom@example.com":{"name":"Mom","metro":"stockton"},
   "dad@example.com":{"name":"Dad","metro":"stockton"},
   "friend@example.com":{"name":"Friend","metro":null}},
 "metros":{
   "stockton":{"label":"Near Mom & Dad","airports":["SCK","SMF"],"cities":["Stockton","Lodi","Sacramento"]},
   "la":{"label":"Your city","airports":["LAX","BUR","LGB","SNA","ONT"],"cities":["Los Angeles","Santa Monica","Pasadena"]},
   "sacramento":{"label":"Your city","airports":["SMF"],"cities":["Sacramento","Davis"]},
   "tucson":{"label":"Your city","airports":["TUS"],"cities":["Tucson"]},
   "boston":{"label":"Your city","airports":["BOS"],"cities":["Boston","Cambridge","Somerville"]},
   "nyc":{"label":"Your city","airports":["JFK","LGA","EWR"],"cities":["New York","Brooklyn","Jersey City","Newark"]},
   "dc":{"label":"Your city","airports":["DCA","IAD","BWI"],"cities":["Washington","Arlington","Alexandria"]},
   "burlington":{"label":"Your city","airports":["BTV"],"cities":["Burlington"]},
   "seattle":{"label":"Your city","airports":["SEA"],"cities":["Seattle","Bellevue"]}}}
```

Viewers in San Francisco (e.g. Jason) get no highlight (`metro: null`), since SF is home. More viewers will be added later.

**Parsing fixtures** (real formats, fake codes)

| Source | Example | Expected |
| --- | --- | --- |
| Calendar flight | `Flight: SFO (UA2386) to DCA Confirmation ABC123` | In transit SFO→DCA, then Washington, DC |
| Calendar flight (Gmail dup) | `Flight to Washington (UA 2386)` | Deduped with the above |
| Calendar hotel | `Stay: The Morrow Washington Dc, Curio Collection By Hilton, Washington Confirmation 0000000000` / location `…, 222 M STREET NE, Washington, DC 20002, US` | Washington, DC; hotel name dropped |
| Email, new format | `Your Nov 28 EWR–SMF flight is confirmed [ABC123]` | Flight Nov 28 to Sacramento, CA |
| Email, old format | `Your Sep 18 one-way DCA-SFO flight is confirmed - ABC123` | Same, with hyphen/en-dash variants |
| Email, ticketing | `Your Oct 7 DCA–SFO flight is being ticketed` | Ignored (wait for confirmed) |
| Email, cancellation | `You've canceled your Sep 18 DCA–SFO flight` | Flight removed (date + route match) |
| Manual marker | `📍 Stockton, CA [personal]` | Stockton, CA, no ★, "Near Mom & Dad" |
| Manual marker | `📍 Berlin, Germany [work]` | Berlin, Germany ★ |
| Manual marker | `📍 Chicago, IL [private]` | "Traveling", no city |
| Working Location | `Home` / `Germany` (workingLocation events) | Ignored |

**Acceptance checks**
- Fixture week Oct 5–8, 2026 (SFO→DCA Oct 5 2:30 pm PT; Stay Oct 5–8; DCA→SFO Oct 7 3:57 pm PT, lands 9:55 pm PT): Washington, DC on Oct 6; in transit after 3:57 pm PT Oct 7; home Oct 8.
- An email not on the allowlist can't load `/` or `/api/status`.
- Stored status contains only schema fields; a test fails if any confirmation code, e-ticket number or hotel name appears.
- A canceled flight drops off on the next run.
- Status older than 3 hours shows "may be out of date."
- Highlight appears for Mary/Ruperto on the Nov 28 Sacramento trip; not for Jason.

**Build order**
1. Repo scaffold, fixtures, parsing + merge as pure functions with tests.
2. 2–3 static style templates of the page using fixture status, for Lange to pick.
3. Worker (routes, KV, schema validation, highlight) + tests; deploy to workers.dev.
4. Apps Script wrapper (clasp), trigger, POST to Worker.
5. Access setup checklist + README for Lange.

**Lange's manual steps**
- [ ] Create the "Where's Langey" calendar in langeluntao@gmail.com and share it with lange@aiedu.org.
- [ ] Get access to the aiEDU GitHub org and Cloudflare account.
- [ ] Turn on Cloudflare Zero Trust (free plan); create an Access application for the Worker with a one-time PIN policy listing the viewer emails; create a service token for Apps Script.
- [ ] Run `clasp login` and approve the Apps Script on first run.
- [ ] Paste the service token and shared secret into Script Properties and Worker secrets.
- [ ] Pick a style template, then test with Mom and Dad.

## 8. Later builds (not v1)
- Gmail failure alert to Lange; Sunday self-reminder listing next week's inferred cities.
- Weekly digest email, your-city trip alerts, "landed safely" email to parents.
- Weather in today's city, small map pin, custom domain.

## 9. Risks
- **Navan formats change** → parsing breaks silently. Mitigation: freshness stamp; failure alert (later build).
- **Forgotten manual markers** → shows SF when Lange is away by car.
- **Same-day changes** lag up to 30 minutes, or longer if Navan's email is late.
