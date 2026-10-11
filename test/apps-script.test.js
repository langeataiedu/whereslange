// Runs the Apps Script files the way Apps Script does (one shared global scope) against fake
// Calendar, Gmail, UrlFetch and Properties services loaded with the fixture data.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const core = require('../apps-script/src/core.js');
const { CONFIG } = require('../apps-script/src/config.js');
const fixture = require('./fixtures/fall-2026.json');

const SOURCES = ['config.js', 'core.js', 'Code.js'].map((f) => fs.readFileSync(new URL(`../apps-script/src/${f}`, import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-07T20:12:00Z');
const DAY = 24 * 3600e3;
const PROPS = {
  WORKER_URL: 'https://wheres-lange.example.workers.dev/',
  ACCESS_CLIENT_ID: 'client-id.access',
  ACCESS_CLIENT_SECRET: 'client-secret',
  UPDATE_SECRET: 'update-secret',
  MARKER_CALENDAR_ID: 'markers@group.calendar.google.com',
};

// A calendar event as CalendarApp returns it. All-day dates come back as Dates at local midnight.
function fakeEvent(e) {
  const day = (d) => new Date(`${d}T08:00:00Z`); // midnight Pacific
  return {
    getTitle: () => e.title,
    getLocation: () => e.location || '',
    isAllDayEvent: () => e.allDay,
    getAllDayStartDate: () => day(e.start),
    getAllDayEndDate: () => day(e.end),
    getStartTime: () => new Date(e.allDay ? `${e.start}T08:00:00Z` : e.start),
    getEndTime: () => new Date(e.allDay ? `${e.end}T08:00:00Z` : e.end),
    getEventType: () => ({ toString: () => (e.eventType === 'workingLocation' ? 'WORKING_LOCATION' : 'DEFAULT') }),
  };
}

function fakeCalendar(events, calls) {
  return {
    getName: () => "Where's Langey",
    getEvents(start, end) {
      calls.push([start.getTime(), end.getTime()]);
      return events.map(fakeEvent).filter((ev) => ev.getStartTime() < end && ev.getEndTime() > start);
    },
  };
}

/** Loads the Apps Script files into a fresh sandbox with fake Google services. */
// Fake Wikipedia intro for whichever city is asked about, and a fake NYT search result.
const WIKI_INTRO = 'Washington is the capital of the United States. "Washington" is from the name of George Washington, the first U.S. president. '
  + 'The population was 689,545 at the 2020 census. The city is home to many national monuments and museums.';
const NYT_DOC = { web_url: 'https://www.nytimes.com/2024/05/02/travel/things-to-do-washington-dc.html', headline: { main: '36 Hours in Washington, D.C.' } };

function appsScript({ props = PROPS, emails = fixture.emails, responseCode = 200, markerCalendar = true, markers = null, lookupsFail = false } = {}) {
  const isMarker = (e) => e.title.startsWith('📍');
  const meeting = { title: 'Lunch with Sam', location: 'Some Cafe', start: '2026-10-08T19:00:00Z', end: '2026-10-08T20:00:00Z', allDay: false };
  const calls = { getEvents: [], fetch: [], lookups: [], gmailGets: 0, triggers: [] };
  const cache = new Map();

  class FixedDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(NOW); }
    static now() { return NOW; }
  }
  const messages = emails.map((e, i) => ({ id: `m${i}`, internalDate: String(Date.parse(e.date)), payload: { headers: [{ name: 'Subject', value: e.subject }] } }));

  const sandbox = {
    console: { log() {} },
    Date: FixedDate,
    Session: { getScriptTimeZone: () => 'America/Los_Angeles' },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
        return fmt === 'yyyyMMdd' ? ymd.replace(/-/g, '') : ymd; // the two formats the script uses
      },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...props }) }) },
    CalendarApp: {
      getDefaultCalendar: () => fakeCalendar([...fixture.events.filter((e) => !isMarker(e)), meeting], calls.getEvents),
      getCalendarById: (id) => (markerCalendar && id === PROPS.MARKER_CALENDAR_ID ? fakeCalendar(markers || fixture.events.filter(isMarker), calls.getEvents) : null),
    },
    Gmail: {
      Users: {
        Messages: {
          // Two messages per page, to exercise paging.
          list: (user, { q, pageToken }) => {
            calls.query = q;
            const at = Number(pageToken || 0);
            return { messages: messages.slice(at, at + 2).map(({ id }) => ({ id })), nextPageToken: at + 2 < messages.length ? String(at + 2) : undefined };
          },
          get: (user, id, opts) => { calls.gmailGets++; calls.gmailFormat = opts.format; return messages.find((m) => m.id === id); },
        },
      },
    },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        // Like the real UrlFetchApp: characters that must be percent-encoded are an "Invalid argument".
        if (/[|\s"<>{}\\^`]/.test(url)) throw new Error(`Invalid argument: ${url}`);
        if (/wikipedia\.org|nytimes\.com/.test(url)) {
          calls.lookups.push(url);
          const body = /wikipedia/.test(url)
            ? { query: { pages: [{ title: decodeURIComponent(url.split('titles=')[1]), extract: WIKI_INTRO }] } }
            : { response: { docs: [NYT_DOC] } };
          return { getResponseCode: () => (lookupsFail ? 500 : 200), getContentText: () => JSON.stringify(body) };
        }
        calls.fetch.push({ url, opts });
        return { getResponseCode: () => responseCode, getContentText: () => (responseCode === 200 ? '{"ok":true}' : '{"error":"forbidden"}') };
      },
    },
    ScriptApp: {
      getProjectTriggers: () => [{ getHandlerFunction: () => 'updateStatus', id: 'old' }, { getHandlerFunction: () => 'other', id: 'keep' }],
      deleteTrigger: (t) => calls.triggers.push(`deleted ${t.id}`),
      newTrigger: (fn) => ({ timeBased: () => ({ everyMinutes: (n) => ({ create: () => calls.triggers.push(`created ${fn} every ${n} min`) }) }) }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCES.join('\n;\n'), sandbox);
  return { run: (fn) => sandbox[fn](), calls, sandbox };
}

const gas_dry = () => appsScript().run('dryRun');
const expected = () => core.buildStatus({ config: CONFIG, events: fixture.events, emails: fixture.emails, now: NOW });
const plain = (v) => JSON.parse(JSON.stringify(v)); // values from the sandbox's own realm

describe('Apps Script wrapper', () => {
  it('sends the same status the merge logic builds from the fixtures', () => {
    const gas = appsScript();
    gas.run('updateStatus');
    expect(gas.calls.fetch).toHaveLength(1);
    const { url, opts } = gas.calls.fetch[0];
    expect(url).toBe('https://wheres-lange.example.workers.dev/api/update');
    const { fact, ...today } = JSON.parse(opts.payload).today;
    expect({ ...JSON.parse(opts.payload), today }).toEqual(expected());
    expect(fact.wikiUrl).toBe('https://en.wikipedia.org/wiki/Washington%2C_D.C.');
    expect(opts.headers).toEqual({
      'CF-Access-Client-Id': 'client-id.access',
      'CF-Access-Client-Secret': 'client-secret',
      Authorization: 'Bearer update-secret',
    });
    expect(opts.method).toBe('post');
  });

  it('reads 14 days back and 62 days ahead, from both calendars', () => {
    const gas = appsScript();
    gas.run('dryRun');
    expect(gas.calls.getEvents).toEqual([
      [NOW - 14 * DAY, NOW + 62 * DAY],
      [NOW - 14 * DAY, NOW + 62 * DAY],
    ]);
  });

  it('reads only Flight:/Stay:/📍 events — meetings never enter the status', () => {
    const gas = appsScript();
    const events = plain(gas.sandbox.readEvents_(gas.sandbox.CalendarApp.getDefaultCalendar(), new Date(0), new Date(NOW + 365 * DAY)));
    expect(events.map((e) => e.title).every((t) => /^(Flight:|Stay:)/.test(t))).toBe(true);
    expect(JSON.stringify(plain(gas.run('dryRun')))).not.toMatch(/Sam|Cafe/);
  });

  it('turns all-day events into dates and timed events into instants', () => {
    const gas = appsScript();
    const events = plain(gas.sandbox.readEvents_(gas.sandbox.CalendarApp.getDefaultCalendar(), new Date(0), new Date(NOW + 365 * DAY)));
    expect(events.find((e) => e.title.startsWith('Stay: The Morrow'))).toMatchObject({ allDay: true, start: '2026-10-05', end: '2026-10-08' });
    expect(events.find((e) => e.title.includes('UA1234'))).toMatchObject({ allDay: false, start: '2026-10-07T22:57:00.000Z', end: '2026-10-08T04:55:00.000Z' });
  });

  it('reads every page of Navan emails, headers only', () => {
    const gas = appsScript();
    gas.run('dryRun');
    expect(gas.calls.query).toBe('from:no-reply@navan.com newer_than:120d');
    expect(gas.calls.gmailGets).toBe(fixture.emails.length);
    expect(gas.calls.gmailFormat).toBe('metadata');
  });

  it('dryRun sends nothing', () => {
    const gas = appsScript();
    const status = plain(gas.run('dryRun'));
    delete status.today.fact;
    expect(status).toEqual(expected());
    expect(gas.calls.fetch).toHaveLength(0);
  });

  it('fails loudly (so Apps Script emails Lange) when the Worker rejects the update', () => {
    const gas = appsScript({ responseCode: 403 });
    expect(() => gas.run('updateStatus')).toThrow('Worker update failed: HTTP 403');
  });

  it('trims stray spaces and line breaks from pasted script properties', () => {
    const gas = appsScript({ props: { ...PROPS, ACCESS_CLIENT_SECRET: ' client-secret\n', UPDATE_SECRET: 'update-secret ' } });
    gas.run('updateStatus');
    expect(gas.calls.fetch[0].opts.headers['CF-Access-Client-Secret']).toBe('client-secret');
    expect(gas.calls.fetch[0].opts.headers.Authorization).toBe('Bearer update-secret');
  });

  it('refuses to send when a script property is missing', () => {
    const { UPDATE_SECRET, ...rest } = PROPS;
    const gas = appsScript({ props: rest });
    expect(() => gas.run('updateStatus')).toThrow('Script property UPDATE_SECRET is not set');
    expect(gas.calls.fetch).toHaveLength(0);
  });

  it('says so when the marker calendar is not shared', () => {
    const gas = appsScript({ markerCalendar: false });
    expect(() => gas.run('dryRun')).toThrow('MARKER_CALENDAR_ID');
  });

  it('works without a marker calendar yet', () => {
    const { MARKER_CALENDAR_ID, ...rest } = PROPS;
    const gas = appsScript({ props: rest });
    const trips = plain(gas.run('dryRun')).trips.map((t) => t.place);
    expect(trips).not.toContain('Stockton, CA'); // that trip only exists as a marker
    expect(trips).toContain('Germany');
  });

  it('checkMarkers explains why each marker counts or not', () => {
    const day = (title, start, end) => ({ title, start, end, allDay: true });
    const gas = appsScript({ markers: [
      day('📍 Stockton, CA [personal]', '2026-10-24', '2026-10-26'),
      day('📌 Chicago, IL', '2026-10-15', '2026-10-17'),
      day('busy', '2026-10-20', '2026-10-21'),
    ] });
    const out = plain(gas.run('checkMarkers')).join('\n');
    expect(out).toContain('3 event(s)');
    expect(out).toContain('"📍 Stockton, CA [personal]" → OK: Stockton, CA [personal]');
    expect(out).toContain('"📌 Chicago, IL" → OK: Chicago, IL');
    expect(out).toContain('"busy" → title hidden');
    expect(out).toMatch(/Sat Oct 24 2026 → Sun Oct 25 2026: "📍 Stockton/); // shows the whole span
    expect(gas.calls.fetch).toHaveLength(0);
  });

  it('on the marker calendar no 📍 is needed; on the aiEDU calendar it still is', () => {
    const day = (title, start, end) => ({ title, start, end, allDay: true });
    const gas = appsScript({ markers: [
      day('Boise, ID', '2026-10-27', '2026-10-30'),
      day('Budapest, Hungary [work]', '2026-11-02', '2026-11-05'),
      day('📍 Melville, NY', '2026-11-25', '2026-11-27'),
    ] });
    const trips = plain(gas.run('dryRun')).trips.map((t) => [t.start, t.end, t.place, t.work]);
    expect(trips).toContainEqual(['2026-10-27', '2026-10-29', 'Boise, ID', false]);
    expect(trips).toContainEqual(['2026-11-02', '2026-11-04', 'Budapest, Hungary', true]);
    expect(trips).toContainEqual(['2026-11-25', '2026-11-26', 'Melville, NY', false]);
    // A "Boise, ID"-style title on the work calendar is just a meeting, never a location.
    const work = plain(gas.sandbox.readEvents_({ getEvents: () => [fakeEvent(day('Boise, ID', '2026-10-27', '2026-10-28'))] }, new Date(0), new Date(NOW + 365 * DAY), false));
    expect(work).toEqual([]);
  });

  it('Long Island trips reach NYC viewers, and only New York towns count', () => {
    const day = (title, start, end) => ({ title, start, end, allDay: true });
    const gas = appsScript({ markers: [day('Melville, NY', '2026-10-20', '2026-10-22'), day('Lawrence, KS', '2026-10-25', '2026-10-27')] });
    const trips = plain(gas.run('dryRun')).trips;
    expect(trips.find((t) => t.place === 'Melville, NY').metros).toEqual(['nyc', 'longisland']);
    expect(trips.find((t) => t.place === 'Lawrence, KS').metros).toEqual([]);
  });

  it('checkMarkers spots a missing or misspelled MARKER_CALENDAR_ID', () => {
    const { MARKER_CALENDAR_ID, ...rest } = PROPS;
    const gas = appsScript({ props: { ...rest, MARKER_CALENDAR: 'x@group.calendar.google.com' } });
    const out = plain(gas.run('checkMarkers')).join('\n');
    expect(out).toContain('MARKER_CALENDAR_ID is not set');
    expect(out).toContain('similar property name instead: MARKER_CALENDAR');
  });

  it('adds a Wikipedia fun fact (not the census line) and an NYT search link when there is no NYT key', () => {
    const fact = plain(gas_dry()).today.fact;
    expect([
      '"Washington" is from the name of George Washington, the first U.S. president.',
      'The city is home to many national monuments and museums.',
    ]).toContain(fact.text);
    expect(fact.nytTitle).toBe('36 Hours in Washington');
    expect(fact.nytUrl).toMatch(/^https:\/\/www\.nytimes\.com\/search\?query=/);
  });

  it('with an NYT key, links a recent NYT article; lookups are cached for 6 hours', () => {
    const gas = appsScript({ props: { ...PROPS, NYT_API_KEY: 'nyt-key' } });
    const fact = plain(gas.run('dryRun')).today.fact;
    expect(fact).toMatchObject({ nytTitle: '36 Hours in Washington, D.C.', nytUrl: NYT_DOC.web_url });
    expect(gas.calls.lookups.find((u) => u.includes('api.nytimes.com'))).toMatch(/begin_date=2021\d{4}/); // last 5 years
    const before = gas.calls.lookups.length;
    gas.run('dryRun');
    expect(gas.calls.lookups.length).toBe(before); // second run: from the cache
  });

  it('if Wikipedia or NYT fails, the update still goes out, just without a fact', () => {
    const gas = appsScript({ lookupsFail: true });
    gas.run('updateStatus');
    expect(gas.calls.fetch).toHaveLength(1);
    expect(JSON.parse(gas.calls.fetch[0].opts.payload).today).not.toHaveProperty('fact');
  });

  it('installTrigger replaces the old 30-minute trigger and leaves others alone', () => {
    const gas = appsScript();
    gas.run('installTrigger');
    expect(gas.calls.triggers).toEqual(['deleted old', 'created updateStatus every 30 min']);
  });
});
