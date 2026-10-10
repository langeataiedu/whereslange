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
 *
 * First time: run dryRun() and check the log, then run installTrigger().
 * If a run fails, Apps Script emails a failure notice, and the page shows "may be out of date".
 */

const LOOKBACK_DAYS = 14; // so a trip already underway is visible
const READ_AHEAD_DAYS = 62; // status covers 60 days ahead
const NAVAN_EMAIL_QUERY = 'from:no-reply@navan.com newer_than:120d';
const MAX_EMAILS = 500;
// Only these events are read; meetings and everything else on the calendar are skipped.
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
    const when = ev.isAllDayEvent() ? `${ev.getAllDayStartDate().toDateString()} (all day)` : ev.getStartTime().toString();
    let verdict;
    if (/^\s*busy\s*$/i.test(title) || !title) verdict = 'title hidden: the calendar is shared as free/busy only. Share it with "See all event details".';
    else if (!RELEVANT_TITLE.test(title)) {
      const first = Array.from(title.trim())[0] || '';
      verdict = `ignored: must start with 📍 (round pushpin). It starts with "${first}" (U+${first.codePointAt(0).toString(16).toUpperCase()}).`;
    } else {
      const m = parseMarker(title);
      verdict = m && (m.place.city || m.place.region)
        ? `OK: ${[m.place.city, m.place.region].filter(Boolean).join(', ')}${m.tags.work ? ' [work]' : ''}${m.tags.personal ? ' [personal]' : ''}`
        : 'ignored: no place after the 📍';
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

  const calendars = [CalendarApp.getDefaultCalendar()];
  if (props.MARKER_CALENDAR_ID) {
    const markers = CalendarApp.getCalendarById(props.MARKER_CALENDAR_ID);
    if (!markers) throw new Error('MARKER_CALENDAR_ID: calendar not found, or not shared with this account');
    calendars.push(markers);
  }

  return buildStatus({
    config: CONFIG,
    events: calendars.flatMap((cal) => readEvents_(cal, start, end)),
    emails: readNavanEmails_(),
    now: now.getTime(),
  });
}

/** Calendar events in the shape core.js expects (see the top of core.js). */
function readEvents_(calendar, start, end) {
  const tz = Session.getScriptTimeZone();
  return calendar.getEvents(start, end)
    .filter((ev) => RELEVANT_TITLE.test(ev.getTitle()))
    .map((ev) => {
      const allDay = ev.isAllDayEvent();
      return {
        title: ev.getTitle(),
        location: ev.getLocation(),
        allDay,
        start: allDay ? Utilities.formatDate(ev.getAllDayStartDate(), tz, 'yyyy-MM-dd') : ev.getStartTime().toISOString(),
        end: allDay ? Utilities.formatDate(ev.getAllDayEndDate(), tz, 'yyyy-MM-dd') : ev.getEndTime().toISOString(),
        eventType: String(ev.getEventType()) === 'WORKING_LOCATION' ? 'workingLocation' : 'default',
      };
    });
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
