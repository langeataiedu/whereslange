/**
 * Where's Lange? — Apps Script entry points (runs as lange@aiedu.org).
 *
 * Every 30 minutes: read Navan flight/hotel events from the aiEDU calendar, manual markers from the
 * "Where's Langey" calendar, and Navan emails; build the status with core.js; POST only that status
 * to the Worker. Nothing else leaves Google.
 *
 * Script Properties (Project Settings → Script properties; never in code):
 *   WORKER_URL            e.g. https://wheres-lange.<subdomain>.workers.dev
 *   ACCESS_CLIENT_ID      Cloudflare Access service token ID
 *   ACCESS_CLIENT_SECRET  Cloudflare Access service token secret
 *   UPDATE_SECRET         same value as the Worker's UPDATE_SECRET
 *   MARKER_CALENDAR_ID    ID of the "Where's Langey" calendar (optional until it exists)
 *   NYT_API_KEY           New York Times Article Search API key (optional: without it, the page
 *                         links to an NYT search for "36 Hours in <city>" instead of an article)
 *
 * First time: run dryRun() and check the log, then run installTrigger().
 * If a run fails, Apps Script emails a failure notice, and the page shows "may be out of date".
 */

const LOOKBACK_DAYS = 14; // so a trip already underway is visible
const READ_AHEAD_DAYS = 62; // status covers 60 days ahead
const NAVAN_EMAIL_QUERY = 'from:no-reply@navan.com newer_than:120d';
const MAX_EMAILS = 500;
// On the aiEDU calendar only these events are read; meetings and everything else are skipped.
// (Every event on the dedicated "Where's Langey" calendar is a location marker; no 📍 needed.)
const RELEVANT_TITLE = /^\s*(?:Flight:|Stay:|\u{1F4CD})/u;

/** Time-driven trigger target: build the status and send it to the Worker. */
function updateStatus() {
  const props = scriptProperties_();
  postStatus_(buildStatusNow_(props), props);
}

/** Builds the status and logs it without sending anything. */
function dryRun() {
  const status = buildStatusNow_(scriptProperties_());
  console.log(JSON.stringify(status, null, 2));
  return status;
}

/**
 * Troubleshooting: logs what the script sees in the marker calendar and why each event counts or
 * doesn't. Sends nothing.
 */
function checkMarkers() {
  const props = scriptProperties_();
  const lines = [];
  if (!props.MARKER_CALENDAR_ID) {
    const near = Object.keys(props).filter((k) => /marker|calendar/i.test(k) && k !== 'MARKER_CALENDAR_ID');
    lines.push('MARKER_CALENDAR_ID is not set, so the marker calendar is skipped.');
    if (near.length) lines.push(`Found a similar property name instead: ${near.join(', ')}. It must be exactly MARKER_CALENDAR_ID.`);
    console.log(lines.join('\n'));
    return lines;
  }
  const cal = CalendarApp.getCalendarById(props.MARKER_CALENDAR_ID);
  if (!cal) {
    lines.push('MARKER_CALENDAR_ID is set, but this account can\'t open that calendar. Check the ID, and that it\'s shared with this account ("See all event details").');
    console.log(lines.join('\n'));
    return lines;
  }
  const now = new Date();
  const start = new Date(now.getTime() - LOOKBACK_DAYS * DAY);
  const end = new Date(now.getTime() + READ_AHEAD_DAYS * DAY);
  const events = cal.getEvents(start, end);
  lines.push(`Calendar "${cal.getName()}": ${events.length} event(s) between ${start.toDateString()} and ${end.toDateString()}.`);
  for (const ev of events) {
    const title = ev.getTitle();
    const when = ev.isAllDayEvent()
      ? `${ev.getAllDayStartDate().toDateString()} → ${new Date(ev.getAllDayEndDate().getTime() - DAY).toDateString()}`
      : `${ev.getStartTime().toString()} → ${ev.getEndTime().toString()}`;
    let verdict;
    if (/^\s*busy\s*$/i.test(title) || !title) verdict = 'title hidden: the calendar is shared as free/busy only. Share it with "See all event details".';
    else {
      const m = parseMarker(asMarkerTitle_(title));
      verdict = !m || !(m.place.city || m.place.region) ? 'ignored: no place in the title'
        : `OK: ${[m.place.city, m.place.region].filter(Boolean).join(', ')}${m.tags.work ? ' [work]' : ''}${m.tags.personal ? ' [personal]' : ''}`
          + (m.place.tz ? '' : ' (place not recognized: the page will leave out the local time)');
    }
    lines.push(`- ${when}: "${title}" → ${verdict}`);
  }
  if (!events.length) lines.push('No events in that window. Markers must fall between 2 weeks ago and ~2 months ahead.');
  console.log(lines.join('\n'));
  return lines;
}

/** Runs updateStatus every 30 minutes (replaces any existing trigger for it). */
function installTrigger() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'updateStatus') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('updateStatus').timeBased().everyMinutes(30).create();
}

/** Script properties, trimmed (pasted values often pick up a stray space or line break). */
function scriptProperties_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, String(v).trim()]));
}

function buildStatusNow_(props) {
  const now = new Date();
  const start = new Date(now.getTime() - LOOKBACK_DAYS * DAY);
  const end = new Date(now.getTime() + READ_AHEAD_DAYS * DAY);

  const events = readEvents_(CalendarApp.getDefaultCalendar(), start, end, false);
  if (props.MARKER_CALENDAR_ID) {
    const markers = CalendarApp.getCalendarById(props.MARKER_CALENDAR_ID);
    if (!markers) throw new Error('MARKER_CALENDAR_ID: calendar not found, or not shared with this account');
    events.push(...readEvents_(markers, start, end, true));
  }

  const status = buildStatus({
    config: CONFIG,
    events,
    emails: readNavanEmails_(),
    now: now.getTime(),
  });
  return addCityFact_(status, props, now.getTime());
}

// ---------------------------------------------------------------------------
// Fun fact about today's city: a sentence from Wikipedia + a recent New York Times article.

const FACT_CACHE_SECONDS = 6 * 3600; // look each city up at most every 6 hours
// (UrlFetchApp rejects a raw "|" in a URL, so it's written as %7C.)
const WIKI_API = 'https://en.wikipedia.org/w/api.php?action=query&prop=extracts%7Cpageprops&ppprop=disambiguation'
  + '&exintro=1&explaintext=1&redirects=1&format=json&formatversion=2&titles=';
const NYT_SEARCH_API = 'https://api.nytimes.com/svc/search/v2/articlesearch.json';
const FUN_SENTENCE = /\b(first|oldest|largest|longest|tallest|biggest|highest|known as|nicknamed|nickname|home to|famous|founded|named after|birthplace|invented|world.s)\b/i;
// Census-style sentences aren't fun facts.
const DRY_SENTENCE = /\b(population|census|inhabitants|county seat|square (miles|kilometers)|metropolitan statistical|is located|is a (city|town|hamlet|village|census))\b/i;

/** Adds today.fact. Never breaks the update: if anything goes wrong, the page just has no fact. */
function addCityFact_(status, props, now) {
  try {
    const fact = cityFact_(status.today, props, now);
    if (fact) status.today.fact = fact;
  } catch (e) {
    console.log(`Fun fact skipped: ${e.message}`);
  }
  return status;
}

function cityFact_(today, props, now) {
  if (!today.city && !today.region) return null;
  const cache = CacheService.getScriptCache();
  const key = `fact:${today.city}|${today.region}`;
  let found = JSON.parse(cache.get(key) || 'null');
  if (!found) {
    found = { wiki: wikipediaSentences_(today), nyt: nytArticle_(today, props, now) };
    cache.put(key, JSON.stringify(found), FACT_CACHE_SECONDS);
  }
  if (!found.wiki || !found.wiki.sentences.length) return null;
  const sentences = found.wiki.sentences;
  return {
    text: sentences[Math.floor(now / DAY) % sentences.length], // a different one each day
    wikiUrl: found.wiki.url,
    nytTitle: found.nyt.title,
    nytUrl: found.nyt.url,
  };
}

/** Wikipedia article names to try: "Melville, New York", "Washington, D.C.", "Budapest"... */
function wikipediaTitles_({ city, region }) {
  if (!city) return [region];
  if (region === 'DC') return ['Washington, D.C.'];
  const state = Object.keys(US_STATE_NAMES).find((n) => US_STATE_NAMES[n] === region && n !== 'washington dc');
  if (state) return [`${city}, ${state.replace(/\b\w/g, (c) => c.toUpperCase())}`, city];
  return region ? [city, `${city}, ${region}`] : [city];
}

/** The introduction of the city's Wikipedia article, as candidate fun facts (most fun-fact-like first). */
function wikipediaSentences_(today) {
  for (const title of wikipediaTitles_(today)) {
    const res = UrlFetchApp.fetch(WIKI_API + encodeURIComponent(title), {
      muteHttpExceptions: true,
      headers: { 'Api-User-Agent': 'WheresLange/1.0 (family travel page)' },
    });
    if (res.getResponseCode() !== 200) continue;
    const page = ((JSON.parse(res.getContentText()).query || {}).pages || [])[0];
    if (!page || page.missing || !page.extract || (page.pageprops && 'disambiguation' in page.pageprops)) continue;
    return { url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`, sentences: funSentences_(page.extract) };
  }
  return null;
}

function funSentences_(extract) {
  // Split at sentence ends, but not after an initial ("Robert F. Stockton").
  const all = extract.replace(/\s+/g, ' ').trim().split(/(?<=[a-z0-9)"”][.!?])\s+(?=[A-Z"“(])/)
    .filter((t) => t.length >= 40 && t.length <= 260 && !DRY_SENTENCE.test(t));
  const rest = all.length > 1 ? all.slice(1) : all; // the first sentence is usually "X is a city in Y"
  const fun = rest.filter((t) => FUN_SENTENCE.test(t));
  return (fun.length ? fun : rest).slice(0, 6);
}

/** A recent (last 5 years) NYT article about the city, favoring the "36 Hours in…" travel column. */
function nytArticle_(today, props, now) {
  const where = today.city || today.region;
  const search = {
    title: `36 Hours in ${where}`,
    url: `https://www.nytimes.com/search?query=${encodeURIComponent(`"36 Hours in ${where}"`)}`,
  };
  if (!props.NYT_API_KEY) return search;
  const since = Utilities.formatDate(new Date(now - 5 * 365 * DAY), 'UTC', 'yyyyMMdd');
  for (const q of [`"36 Hours in ${where}"`, `${where} travel`]) {
    const res = UrlFetchApp.fetch(`${NYT_SEARCH_API}?q=${encodeURIComponent(q)}&begin_date=${since}&sort=relevance`
      + `&api-key=${encodeURIComponent(props.NYT_API_KEY)}`, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) continue;
    const docs = (JSON.parse(res.getContentText()).response || {}).docs || [];
    const best = docs.map((d) => ({ d, score: nytScore_(d, where) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)[0];
    if (best) return { title: best.d.headline.main, url: best.d.web_url };
  }
  return search;
}

/** How well an NYT result is *about* the city: a travel piece naming the city in its headline. 0 = don't use it. */
function nytScore_(doc, where) {
  const headline = (doc.headline && doc.headline.main) || '';
  if (!doc.web_url || !/^https:\/\/www\.nytimes\.com\//.test(doc.web_url) || !headline) return 0;
  const city = where.toLowerCase();
  if (!headline.toLowerCase().includes(city)) return 0;
  const section = String(doc.section_name || (doc.section && doc.section.name) || '').toLowerCase();
  const thirtySix = /36 hours/i.test(headline);
  if (!thirtySix && section !== 'travel') return 0; // e.g. a politics story about "Washington"
  return 1 + (thirtySix ? 4 : 0) + (section === 'travel' ? 2 : 0);
}

/**
 * Calendar events in the shape core.js expects (see the top of core.js). On the marker calendar
 * every event is a location ("Boise, ID" works as well as "📍 Boise, ID").
 */
function readEvents_(calendar, start, end, isMarkerCalendar) {
  const tz = Session.getScriptTimeZone();
  return calendar.getEvents(start, end)
    .filter((ev) => isMarkerCalendar || RELEVANT_TITLE.test(ev.getTitle()))
    .map((ev) => {
      const allDay = ev.isAllDayEvent();
      return {
        title: isMarkerCalendar ? asMarkerTitle_(ev.getTitle()) : ev.getTitle(),
        location: ev.getLocation(),
        allDay,
        start: allDay ? Utilities.formatDate(ev.getAllDayStartDate(), tz, 'yyyy-MM-dd') : ev.getStartTime().toISOString(),
        end: allDay ? Utilities.formatDate(ev.getAllDayEndDate(), tz, 'yyyy-MM-dd') : ev.getEndTime().toISOString(),
        eventType: String(ev.getEventType()) === 'WORKING_LOCATION' ? 'workingLocation' : 'default',
      };
    });
}

/** "Boise, ID" / "📌 Boise, ID" / "📍 Boise, ID" → "📍 Boise, ID" (the marker format core.js reads). */
function asMarkerTitle_(title) {
  return `\u{1F4CD} ${String(title).trim().replace(/^[^\p{L}\p{N}[]+/u, '')}`;
}

/** Navan email subjects and when they arrived (Gmail API, read-only, headers only). */
function readNavanEmails_() {
  const emails = [];
  let pageToken;
  do {
    const page = Gmail.Users.Messages.list('me', { q: NAVAN_EMAIL_QUERY, maxResults: 100, pageToken });
    for (const { id } of page.messages || []) {
      const msg = Gmail.Users.Messages.get('me', id, { format: 'metadata', metadataHeaders: ['Subject'] });
      const subject = (msg.payload.headers.find((h) => h.name === 'Subject') || {}).value || '';
      emails.push({ subject, date: new Date(Number(msg.internalDate)).toISOString() });
    }
    pageToken = page.nextPageToken;
  } while (pageToken && emails.length < MAX_EMAILS);
  return emails;
}

function postStatus_(status, props) {
  for (const key of ['WORKER_URL', 'ACCESS_CLIENT_ID', 'ACCESS_CLIENT_SECRET', 'UPDATE_SECRET']) {
    if (!props[key]) throw new Error(`Script property ${key} is not set`);
  }
  const res = UrlFetchApp.fetch(`${props.WORKER_URL.replace(/\/+$/, '')}/api/update`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(status),
    headers: {
      'CF-Access-Client-Id': props.ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': props.ACCESS_CLIENT_SECRET,
      Authorization: `Bearer ${props.UPDATE_SECRET}`,
    },
    followRedirects: false,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    const body = res.getContentText();
    // Cloudflare Access answers with an HTML page; the Worker answers with JSON.
    const who = /cloudflare access/i.test(body) ? 'Cloudflare Access refused the service token (check ACCESS_CLIENT_ID/SECRET and the Service Auth policy)'
      : body.slice(0, 200);
    throw new Error(`Worker update failed: HTTP ${code}: ${who}`);
  }
}
