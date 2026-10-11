// The status payload is the whole public contract (SPEC §6). Anything outside it is rejected,
// so nothing extra (hotel names, confirmation codes, flight numbers) can ever be stored.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const INSTANT_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const METRO_ID = /^[a-z0-9_-]{1,32}$/;
// Links on the page may only go to these two sites.
const WIKI_URL = /^https:\/\/en\.wikipedia\.org\/wiki\/[^\s"<>]{1,200}$/;
const NYT_URL = /^https:\/\/www\.nytimes\.com\/[^\s"<>]{1,300}$/;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 80): v is string => typeof v === 'string' && v.length <= max;

function hasExactly(o: Obj, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(o);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Returns what's wrong with the payload, or null if it's a valid status. */
export function validateStatus(s: unknown): string | null {
  if (!isObj(s) || !hasExactly(s, ['updated', 'today', 'homeOn', 'trips'])) return 'top-level fields';
  if (!str(s.updated) || !INSTANT_UTC.test(s.updated)) return 'updated';

  const t = s.today;
  if (!isObj(t) || !hasExactly(t, ['city', 'region', 'tz', 'work'], ['transit', 'sleeping', 'fact'])) return 'today fields';
  if (!str(t.city) || !str(t.region) || typeof t.work !== 'boolean') return 'today values';
  if (t.tz !== null && (!str(t.tz, 64) || !isTimeZone(t.tz))) return 'today.tz'; // null: place not recognized
  if ('sleeping' in t && (!str(t.sleeping) || !t.sleeping.trim())) return 'today.sleeping'; // hotel name, "At home"...
  if ('fact' in t) {
    const f = t.fact;
    if (!isObj(f) || !hasExactly(f, ['text', 'wikiUrl', 'nytTitle', 'nytUrl'])) return 'fact fields';
    if (!str(f.text, 400) || !str(f.nytTitle, 200) || !str(f.wikiUrl, 300) || !str(f.nytUrl, 400)) return 'fact values';
    if (!WIKI_URL.test(f.wikiUrl) || !NYT_URL.test(f.nytUrl)) return 'fact links';
  }
  if ('transit' in t) {
    const x = t.transit;
    if (!isObj(x) || !hasExactly(x, ['to', 'departs', 'lands'])) return 'transit fields';
    if (!str(x.to) || !str(x.departs) || !str(x.lands) || !INSTANT_OFFSET.test(x.departs) || !INSTANT_OFFSET.test(x.lands)) {
      return 'transit values';
    }
  }

  if (s.homeOn !== null && !(str(s.homeOn) && DATE.test(s.homeOn))) return 'homeOn';

  if (!Array.isArray(s.trips) || s.trips.length > 60) return 'trips';
  for (const trip of s.trips) {
    if (!isObj(trip) || !hasExactly(trip, ['start', 'end', 'place', 'work', 'metros'])) return 'trip fields';
    if (!str(trip.start) || !DATE.test(trip.start) || !str(trip.end) || !DATE.test(trip.end)) return 'trip dates';
    if (!str(trip.place, 120) || typeof trip.work !== 'boolean') return 'trip values';
    if (!Array.isArray(trip.metros) || trip.metros.length > 20 || !trip.metros.every((m) => str(m) && METRO_ID.test(m))) {
      return 'trip metros';
    }
  }
  return null;
}
