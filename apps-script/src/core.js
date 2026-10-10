/**
 * Where's Lange? — parsing + merge core.
 *
 * Pure functions only: no Google APIs, no network, no clock (callers pass `now`).
 * Runs in two places:
 *   - Apps Script (V8): top-level declarations become globals; the trigger wrapper
 *     (step 4) reads Calendar/Gmail, normalizes events, and calls buildStatus().
 *   - Node (Vitest): loaded with require(); see module.exports at the bottom.
 *
 * Input shapes (normalized by the wrapper):
 *   event: { title, location, start, end, allDay, eventType }
 *          timed events: start/end are ISO instants; all-day: 'YYYY-MM-DD' (end exclusive)
 *   email: { subject, date }  (date = ISO instant the email was received)
 *
 * The wrapper should pass events from ~2 weeks back so a trip already underway is visible.
 */

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const LAYOVER_MAX = 6 * HOUR; // flights closer than this are one journey
const LOOKAHEAD_DAYS = 60;
const HOME_BY_HOUR = 18;

const LA = 'America/Los_Angeles';
const NY = 'America/New_York';
const CHI = 'America/Chicago';
const DEN = 'America/Denver';

const AIRPORTS = {
  // Home + Bay Area / Central Valley
  SFO: { city: 'San Francisco', region: 'CA', tz: LA },
  OAK: { city: 'Oakland', region: 'CA', tz: LA },
  SJC: { city: 'San Jose', region: 'CA', tz: LA },
  SCK: { city: 'Stockton', region: 'CA', tz: LA },
  SMF: { city: 'Sacramento', region: 'CA', tz: LA },
  // Southern California
  LAX: { city: 'Los Angeles', region: 'CA', tz: LA },
  BUR: { city: 'Burbank', region: 'CA', tz: LA },
  LGB: { city: 'Long Beach', region: 'CA', tz: LA },
  SNA: { city: 'Santa Ana', region: 'CA', tz: LA },
  ONT: { city: 'Ontario', region: 'CA', tz: LA },
  SAN: { city: 'San Diego', region: 'CA', tz: LA },
  // West / Southwest
  TUS: { city: 'Tucson', region: 'AZ', tz: 'America/Phoenix' },
  PHX: { city: 'Phoenix', region: 'AZ', tz: 'America/Phoenix' },
  LAS: { city: 'Las Vegas', region: 'NV', tz: LA },
  SEA: { city: 'Seattle', region: 'WA', tz: LA },
  PDX: { city: 'Portland', region: 'OR', tz: LA },
  DEN: { city: 'Denver', region: 'CO', tz: DEN },
  SLC: { city: 'Salt Lake City', region: 'UT', tz: DEN },
  // Central
  ORD: { city: 'Chicago', region: 'IL', tz: CHI },
  MDW: { city: 'Chicago', region: 'IL', tz: CHI },
  DFW: { city: 'Dallas', region: 'TX', tz: CHI },
  AUS: { city: 'Austin', region: 'TX', tz: CHI },
  IAH: { city: 'Houston', region: 'TX', tz: CHI },
  MSP: { city: 'Minneapolis', region: 'MN', tz: CHI },
  // East
  BOS: { city: 'Boston', region: 'MA', tz: NY },
  JFK: { city: 'New York', region: 'NY', tz: NY },
  LGA: { city: 'New York', region: 'NY', tz: NY },
  EWR: { city: 'Newark', region: 'NJ', tz: NY },
  DCA: { city: 'Washington', region: 'DC', tz: NY },
  IAD: { city: 'Washington', region: 'DC', tz: NY },
  BWI: { city: 'Baltimore', region: 'MD', tz: NY },
  BTV: { city: 'Burlington', region: 'VT', tz: NY },
  PHL: { city: 'Philadelphia', region: 'PA', tz: NY },
  ATL: { city: 'Atlanta', region: 'GA', tz: NY },
  MIA: { city: 'Miami', region: 'FL', tz: NY },
  CLT: { city: 'Charlotte', region: 'NC', tz: NY },
  RDU: { city: 'Raleigh', region: 'NC', tz: NY },
  DTW: { city: 'Detroit', region: 'MI', tz: 'America/Detroit' },
  // International (common hubs)
  HNL: { city: 'Honolulu', region: 'HI', tz: 'Pacific/Honolulu' },
  YVR: { city: 'Vancouver', region: 'Canada', tz: 'America/Vancouver' },
  YYZ: { city: 'Toronto', region: 'Canada', tz: 'America/Toronto' },
  MEX: { city: 'Mexico City', region: 'Mexico', tz: 'America/Mexico_City' },
  LHR: { city: 'London', region: 'United Kingdom', tz: 'Europe/London' },
  CDG: { city: 'Paris', region: 'France', tz: 'Europe/Paris' },
  AMS: { city: 'Amsterdam', region: 'Netherlands', tz: 'Europe/Amsterdam' },
  FRA: { city: 'Frankfurt', region: 'Germany', tz: 'Europe/Berlin' },
  MUC: { city: 'Munich', region: 'Germany', tz: 'Europe/Berlin' },
  BER: { city: 'Berlin', region: 'Germany', tz: 'Europe/Berlin' },
  DUB: { city: 'Dublin', region: 'Ireland', tz: 'Europe/Dublin' },
  NRT: { city: 'Tokyo', region: 'Japan', tz: 'Asia/Tokyo' },
  HND: { city: 'Tokyo', region: 'Japan', tz: 'Asia/Tokyo' },
  ICN: { city: 'Seoul', region: 'South Korea', tz: 'Asia/Seoul' },
  MNL: { city: 'Manila', region: 'Philippines', tz: 'Asia/Manila' },
  SIN: { city: 'Singapore', region: 'Singapore', tz: 'Asia/Singapore' },
  SYD: { city: 'Sydney', region: 'Australia', tz: 'Australia/Sydney' },
};

// Primary time zone per US state (good enough for city-level display).
const US_STATE_TZ = {
  AL: CHI, AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: CHI, CA: LA, CO: DEN, CT: NY,
  DE: NY, DC: NY, FL: NY, GA: NY, HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: CHI,
  IN: 'America/Indiana/Indianapolis', IA: CHI, KS: CHI, KY: NY, LA: CHI, ME: NY, MD: NY, MA: NY,
  MI: 'America/Detroit', MN: CHI, MS: CHI, MO: CHI, MT: DEN, NE: CHI, NV: LA, NH: NY, NJ: NY,
  NM: DEN, NY: NY, NC: NY, ND: CHI, OH: NY, OK: CHI, OR: LA, PA: NY, RI: NY, SC: NY, SD: CHI,
  TN: CHI, TX: CHI, UT: DEN, VT: NY, VA: NY, WA: LA, WV: NY, WI: CHI, WY: DEN, PR: 'America/Puerto_Rico',
};

// ISO country code -> [display name, representative time zone]
const COUNTRIES = {
  US: ['United States', NY], CA: ['Canada', 'America/Toronto'], MX: ['Mexico', 'America/Mexico_City'],
  GB: ['United Kingdom', 'Europe/London'], IE: ['Ireland', 'Europe/Dublin'], FR: ['France', 'Europe/Paris'],
  DE: ['Germany', 'Europe/Berlin'], NL: ['Netherlands', 'Europe/Amsterdam'], BE: ['Belgium', 'Europe/Brussels'],
  ES: ['Spain', 'Europe/Madrid'], PT: ['Portugal', 'Europe/Lisbon'], IT: ['Italy', 'Europe/Rome'],
  CH: ['Switzerland', 'Europe/Zurich'], AT: ['Austria', 'Europe/Vienna'], DK: ['Denmark', 'Europe/Copenhagen'],
  SE: ['Sweden', 'Europe/Stockholm'], NO: ['Norway', 'Europe/Oslo'], FI: ['Finland', 'Europe/Helsinki'],
  PL: ['Poland', 'Europe/Warsaw'], GR: ['Greece', 'Europe/Athens'], JP: ['Japan', 'Asia/Tokyo'],
  KR: ['South Korea', 'Asia/Seoul'], CN: ['China', 'Asia/Shanghai'], SG: ['Singapore', 'Asia/Singapore'],
  IN: ['India', 'Asia/Kolkata'], PH: ['Philippines', 'Asia/Manila'], AU: ['Australia', 'Australia/Sydney'],
  NZ: ['New Zealand', 'Pacific/Auckland'], AE: ['United Arab Emirates', 'Asia/Dubai'],
  IL: ['Israel', 'Asia/Jerusalem'], BR: ['Brazil', 'America/Sao_Paulo'], ZA: ['South Africa', 'Africa/Johannesburg'],
  KE: ['Kenya', 'Africa/Nairobi'], HU: ['Hungary', 'Europe/Budapest'], MA: ['Morocco', 'Africa/Casablanca'],
  CZ: ['Czech Republic', 'Europe/Prague'], SK: ['Slovakia', 'Europe/Bratislava'], RO: ['Romania', 'Europe/Bucharest'],
  BG: ['Bulgaria', 'Europe/Sofia'], HR: ['Croatia', 'Europe/Zagreb'], SI: ['Slovenia', 'Europe/Ljubljana'],
  RS: ['Serbia', 'Europe/Belgrade'], UA: ['Ukraine', 'Europe/Kyiv'], EE: ['Estonia', 'Europe/Tallinn'],
  LV: ['Latvia', 'Europe/Riga'], LT: ['Lithuania', 'Europe/Vilnius'], IS: ['Iceland', 'Atlantic/Reykjavik'],
  LU: ['Luxembourg', 'Europe/Luxembourg'], MT: ['Malta', 'Europe/Malta'], CY: ['Cyprus', 'Asia/Nicosia'],
  TR: ['Turkey', 'Europe/Istanbul'], EG: ['Egypt', 'Africa/Cairo'], NG: ['Nigeria', 'Africa/Lagos'],
  GH: ['Ghana', 'Africa/Accra'], RW: ['Rwanda', 'Africa/Kigali'], TZ: ['Tanzania', 'Africa/Dar_es_Salaam'],
  SA: ['Saudi Arabia', 'Asia/Riyadh'], QA: ['Qatar', 'Asia/Qatar'], JO: ['Jordan', 'Asia/Amman'],
  PK: ['Pakistan', 'Asia/Karachi'], BD: ['Bangladesh', 'Asia/Dhaka'], LK: ['Sri Lanka', 'Asia/Colombo'],
  NP: ['Nepal', 'Asia/Kathmandu'], TH: ['Thailand', 'Asia/Bangkok'], VN: ['Vietnam', 'Asia/Ho_Chi_Minh'],
  KH: ['Cambodia', 'Asia/Phnom_Penh'], MY: ['Malaysia', 'Asia/Kuala_Lumpur'], ID: ['Indonesia', 'Asia/Jakarta'],
  TW: ['Taiwan', 'Asia/Taipei'], HK: ['Hong Kong', 'Asia/Hong_Kong'], AR: ['Argentina', 'America/Argentina/Buenos_Aires'],
  CL: ['Chile', 'America/Santiago'], CO: ['Colombia', 'America/Bogota'], PE: ['Peru', 'America/Lima'],
  EC: ['Ecuador', 'America/Guayaquil'], CR: ['Costa Rica', 'America/Costa_Rica'], PA: ['Panama', 'America/Panama'],
  GT: ['Guatemala', 'America/Guatemala'], DO: ['Dominican Republic', 'America/Santo_Domingo'], JM: ['Jamaica', 'America/Jamaica'],
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const DEFAULT_CONFIG = {
  home: { city: 'San Francisco', region: 'CA', tz: LA },
  homeAirports: ['SFO', 'OAK', 'SJC'],
  metros: {},
};

// ---------------------------------------------------------------------------
// Time helpers (Intl-based; no libraries)

const fmtCache = {};

function zonedParts(ms, tz) {
  const fmt = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }));
  const p = {};
  for (const part of fmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

function tzOffsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of an instant in a time zone. */
function localDate(ms, tz) {
  const p = zonedParts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** Instant of a wall-clock time on a date in a time zone. */
function zonedToUtc(dateStr, h, mi, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  return guess - tzOffsetMs(guess - tzOffsetMs(guess, tz), tz);
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** ISO 8601 with the zone's offset, e.g. 2026-10-07T21:55:00-07:00 */
function isoInTz(ms, tz) {
  const p = zonedParts(ms, tz);
  const off = Math.round(tzOffsetMs(ms, tz) / 60e3);
  const abs = Math.abs(off);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${off < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// ---------------------------------------------------------------------------
// Places: { city, region, tz, airport? }

function airportPlace(code) {
  const a = AIRPORTS[code] || { city: code, region: '', tz: null }; // unknown code: show the code
  return { city: a.city, region: a.region, tz: a.tz, airport: code };
}

function countryByName(name) {
  const n = (name || '').trim().toLowerCase();
  return Object.values(COUNTRIES).find((c) => c[0].toLowerCase() === n) || null;
}

const placeLabel = (p) => [p.city, p.region].filter(Boolean).join(', ');

function titleCaseIfShouting(s) {
  return s && s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : s;
}

function withDefaults(config) {
  const c = Object.assign({}, DEFAULT_CONFIG, config);
  c.home = Object.assign({}, DEFAULT_CONFIG.home, config && config.home);
  return c;
}

const homePlace = (config) => ({ city: config.home.city, region: config.home.region, tz: config.home.tz });

function isHomePlace(p, config) {
  return (!!p.airport && config.homeAirports.includes(p.airport))
    || (p.city === config.home.city && p.region === config.home.region);
}

// ---------------------------------------------------------------------------
// Parsers (one per source format)

/**
 * "Flight: SFO (UA2386) to DCA Confirmation ABC123"
 * Gmail's duplicates ("Flight to Washington (UA 2386)") don't match and are ignored:
 * the Navan event covers the same flight, and Navan emails cover any gaps.
 */
function parseCalendarFlight(title) {
  const m = /^Flight:\s*([A-Z]{3})\s*\([A-Z0-9]{2}\s?\d{1,4}\)\s*to\s*([A-Z]{3})\b/i.exec((title || '').trim());
  return m ? { from: m[1].toUpperCase(), to: m[2].toUpperCase() } : null;
}

/** Street address -> place. "…, 222 M STREET NE, Washington, DC 20002, US" / "…, 10117 Berlin, DE" */
function parseAddress(location) {
  const parts = (location || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts.pop();
  const lastUp = last.toUpperCase();

  if (lastUp === 'US' || lastUp === 'USA' || lastUp === 'UNITED STATES') {
    const sm = /^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/i.exec(parts[parts.length - 1] || '');
    if (!sm || parts.length < 2) return null;
    const region = sm[1].toUpperCase();
    return { city: titleCaseIfShouting(parts[parts.length - 2]), region, tz: US_STATE_TZ[region] || null };
  }

  const country = COUNTRIES[lastUp] || countryByName(last);
  // Drop postcode-ish tokens: "10117 Berlin" -> "Berlin", "London SW1A 1AA" -> "London"
  const city = (parts[parts.length - 1] || '').split(/\s+/).filter((t) => !/\d/.test(t)).join(' ');
  return { city: titleCaseIfShouting(city) || null, region: country ? country[0] : titleCaseIfShouting(last), tz: country ? country[1] : null };
}

/** "Stay: <hotel name>, <city> Confirmation <code>": the place comes from the address; the hotel name is dropped. */
function parseStay(title, location) {
  return /^Stay:/i.test((title || '').trim()) ? parseAddress(location) : null;
}

/**
 * Navan email subjects:
 *   "Your Nov 28 EWR–SMF flight is confirmed [ABC123]"
 *   "Your Sep 18 one-way DCA-SFO flight is confirmed - ABC123"
 *   "Your Oct 7 DCA–SFO flight is being ticketed"
 *   "You've canceled your Sep 18 DCA–SFO flight"
 */
function parseEmailSubject(subject) {
  const s = (subject || '').trim();
  const m = /^(?:(?:Fwd?|Re):\s*)*(Your|You(?:'|’)?ve\s+cancell?ed\s+your)\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\s+(?:(?:one-way|round-?trip|multi-city)\s+)?([A-Za-z]{3})\s*[-–—]\s*([A-Za-z]{3})\s+flight\b(.*)$/i
    .exec(s);
  const month = m && MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const kind = /cancel/i.test(m[1]) || /\bcancell?ed\b/i.test(m[6]) ? 'canceled'
    : /\bconfirmed\b/i.test(m[6]) ? 'confirmed'
    : /\bticket(?:ed|ing)\b/i.test(m[6]) ? 'ticketing' : null;
  return kind && { kind, month, day: +m[3], from: m[4].toUpperCase(), to: m[5].toUpperCase() };
}

/** Email subjects have no year: pick the first occurrence on/after (received − 7 days). */
function inferFlightDate(month, day, receivedMs, tz) {
  const floor = localDate(receivedMs - 7 * DAY, tz);
  const y = +floor.slice(0, 4);
  const date = `${y}-${pad(month)}-${pad(day)}`;
  return date < floor ? `${y + 1}-${pad(month)}-${pad(day)}` : date;
}

/** "📍 Berlin, Germany [work]" / "📍 Stockton, CA [personal]" / "📍 Germany" */
function parseMarker(title) {
  const m = /^\s*\u{1F4CD}️?\s*(.*)$/u.exec(title || '');
  if (!m) return null;
  const tags = { work: false, personal: false };
  const parts = m[1]
    .replace(/\[\s*(\w+)\s*\]/g, (_, t) => { if (t.toLowerCase() in tags) tags[t.toLowerCase()] = true; return ''; })
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;

  let city = parts.length > 1 ? parts.slice(0, -1).join(', ') : null;
  let region = parts.length > 1 ? parts[parts.length - 1] : '';
  if (region.length === 2) region = region.toUpperCase();
  if (parts.length === 1) {
    if (countryByName(parts[0])) region = parts[0];
    else city = parts[0];
  }
  const tz = US_STATE_TZ[region] || (countryByName(region) || [])[1] || null;
  return { place: { city, region, tz }, tags };
}

/** Working Location events are inaccurate and never used. */
function isIgnoredEvent(ev) {
  return !ev || ev.eventType === 'workingLocation';
}

// ---------------------------------------------------------------------------
// Flights: calendar events + Navan emails as backstop, cancellations removed

function collectFlights(events, emails, config) {
  const tzOf = (code) => (AIRPORTS[code] && AIRPORTS[code].tz) || config.home.tz;
  const key = (date, from, to) => `${date}|${from}|${to}`;

  const flights = [];
  for (const ev of events) {
    const f = parseCalendarFlight(ev.title);
    if (!f) continue;
    const dep = Date.parse(ev.start);
    flights.push({
      from: f.from, to: f.to, toPlace: airportPlace(f.to), dep, arr: Date.parse(ev.end), timeKnown: true,
      key: key(localDate(dep, tzOf(f.from)), f.from, f.to),
    });
  }

  // For each date + route, the most recently received email decides: confirmed or canceled.
  const latest = {};
  for (const e of emails || []) {
    const p = parseEmailSubject(e.subject);
    if (!p || p.kind === 'ticketing') continue;
    const received = Date.parse(e.date);
    const date = inferFlightDate(p.month, p.day, received, tzOf(p.from));
    const k = key(date, p.from, p.to);
    if (!latest[k] || received >= latest[k].received) latest[k] = { kind: p.kind, received, date, from: p.from, to: p.to };
  }

  const kept = flights.filter((f) => !(latest[f.key] && latest[f.key].kind === 'canceled'));

  // Email-only flights (no calendar event): the date is known, the times aren't.
  for (const k of Object.keys(latest)) {
    const x = latest[k];
    if (x.kind !== 'confirmed' || kept.some((f) => f.key === k)) continue;
    const toPlace = airportPlace(x.to);
    const t = zonedToUtc(x.date, 0, 0, toPlace.tz || config.home.tz);
    kept.push({ from: x.from, to: x.to, toPlace, dep: t, arr: t, timeKnown: false, key: k });
  }

  kept.sort((a, b) => a.dep - b.dep);
  kept.forEach((a, i) => {
    const b = kept[i + 1];
    if (b && a.timeKnown && b.timeKnown && b.from === a.to && b.dep >= a.arr && b.dep - a.arr <= LAYOVER_MAX) {
      a.connectsTo = b;
      b.isConnection = true;
    }
  });
  return kept;
}

// ---------------------------------------------------------------------------
// Timeline: continuous intervals of "where" ({ start, end, place, work }; place null = in the air)

const PRIO = { ground: 1, stay: 2, marker: 3, air: 4 };

/**
 * A stay/marker says where Lange is over whole days; flights say exactly when he moves.
 * Start at the first journey that lands inside the span; end at the first journey that leaves.
 */
function clipToFlights(start, end, flights) {
  const arrival = flights.find((f) => !f.connectsTo && f.arr >= start && f.arr < end);
  const s = arrival ? arrival.arr : start;
  const departure = flights.find((f) => f !== arrival && !f.isConnection && f.dep >= s && f.dep < end);
  return [s, departure ? departure.dep : end];
}

function eventSpan(ev, tz) {
  return ev.allDay
    ? [zonedToUtc(ev.start, 0, 0, tz), zonedToUtc(ev.end, 0, 0, tz)]
    : [Date.parse(ev.start), Date.parse(ev.end)];
}

function buildTimeline(events, flights, config) {
  const homeTz = config.home.tz;
  const segs = [];
  const personal = [];
  const add = (start, end, prio, place, work) => { if (end > start) segs.push({ start, end, prio, place, work }); };

  flights.forEach((f, i) => {
    if (f.timeKnown) add(f.dep, f.arr, PRIO.air, null, true);
    if (f.connectsTo) return add(f.arr, f.connectsTo.dep, PRIO.air, null, true); // layover
    const p = f.toPlace;
    if (isHomePlace(p, config)) return;
    // In the arrival city until the next flight out. If that flight leaves from somewhere else
    // (or there is none), we don't know — so just the arrival day, then the default (home).
    const next = flights[i + 1];
    const tz = p.tz || homeTz;
    const endOfDay = zonedToUtc(addDays(localDate(f.arr, tz), 1), 0, 0, tz);
    const continues = next && placeLabel(airportPlace(next.from)) === placeLabel(p);
    add(f.arr, continues ? next.dep : Math.min(endOfDay, next ? next.dep : Infinity), PRIO.ground, p, true);
  });

  for (const ev of events) {
    const marker = parseMarker(ev.title);
    const stay = marker ? null : parseStay(ev.title, ev.location);
    if (!marker && !stay) continue;
    // Markers mean the dates Lange typed, in home time; hotel dates are local to the hotel.
    const [s, e] = eventSpan(ev, marker ? homeTz : stay.tz || homeTz);
    if (marker && marker.tags.personal) personal.push([s, e]);
    const [cs, ce] = clipToFlights(s, e, flights);
    if (marker) add(cs, ce, PRIO.marker, marker.place, marker.tags.work);
    else add(cs, ce, PRIO.stay, stay, true);
  }

  // Resolve overlaps: split at every boundary; highest priority wins (ties: later start).
  const points = Array.from(new Set(segs.flatMap((s) => [s.start, s.end]))).sort((a, b) => a - b);
  const intervals = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    let best = null;
    for (const s of segs) {
      if (s.start <= a && s.end >= b && (!best || s.prio > best.prio || (s.prio === best.prio && s.start > best.start))) best = s;
    }
    if (!best) continue;
    const prev = intervals[intervals.length - 1];
    const same = prev && prev.end === a && (prev.place && best.place ? placeLabel(prev.place) === placeLabel(best.place) : prev.place === best.place);
    if (same) {
      prev.end = b;
      prev.work = prev.work || best.work;
    } else {
      intervals.push({ start: a, end: b, place: best.place, work: best.work });
    }
  }
  return { intervals, personal };
}

// ---------------------------------------------------------------------------
// Trips

const joinAnd = (items) => (items.length <= 1 ? items[0] || '' : `${items.slice(0, -1).join(', ')} & ${items[items.length - 1]}`);

function tripPlaceLabel(places) {
  const labels = Array.from(new Set(places.map(placeLabel)));
  if (labels.length <= 1) return labels[0] || 'Traveling';
  // Entirely abroad: name the countries ("Germany", "Hungary & Germany").
  const regions = Array.from(new Set(places.map((p) => p.region)));
  if (regions.every((r) => r && !US_STATE_TZ[r])) return joinAnd(regions);
  return labels.length <= 3 ? joinAnd(labels) : `${labels.slice(0, 2).join(', ')} & ${labels.length - 2} more`;
}

function matchMetros(places, config) {
  return Object.keys(config.metros || {}).filter((id) => {
    const m = config.metros[id];
    const cities = (m.cities || []).map((c) => c.toLowerCase());
    return places.some((p) =>
      (p.city && cities.includes(p.city.toLowerCase())) || (p.airport && (m.airports || []).includes(p.airport)));
  });
}

function groupTrips(timeline, config) {
  const homeTz = config.home.tz;
  const groups = [];
  for (const iv of timeline.intervals) {
    if (iv.place && isHomePlace(iv.place, config)) continue;
    const g = groups[groups.length - 1];
    if (g && g.endMs === iv.start) {
      g.endMs = iv.end;
      g.intervals.push(iv);
    } else {
      groups.push({ startMs: iv.start, endMs: iv.end, intervals: [iv] });
    }
  }
  return groups.map((g) => {
    const places = g.intervals.filter((iv) => iv.place).map((iv) => iv.place);
    const personal = timeline.personal.some(([s, e]) => s < g.endMs && e > g.startMs);
    return {
      startMs: g.startMs,
      endMs: g.endMs,
      start: localDate(g.startMs, homeTz),
      end: localDate(g.endMs - 1, homeTz),
      place: tripPlaceLabel(places),
      work: !personal && g.intervals.some((iv) => iv.work),
      metros: matchMetros(places, config),
    };
  });
}

// ---------------------------------------------------------------------------
// Status (the whole public contract — see SPEC §6)

function buildStatus(input) {
  const config = withDefaults(input.config);
  const homeTz = config.home.tz;
  const now = typeof input.now === 'number' ? input.now : Date.parse(input.now);
  const events = (input.events || []).filter((ev) => !isIgnoredEvent(ev));
  const flights = collectFlights(events, input.emails, config);
  const timeline = buildTimeline(events, flights, config);
  const trips = groupTrips(timeline, config);
  const today = localDate(now, homeTz);
  const intervalAt = (t) => timeline.intervals.findIndex((x) => x.start <= t && t < x.end);

  // Where is he right now? In the air counts as the place he just left.
  const i = intervalAt(now);
  let here = i >= 0 ? timeline.intervals[i].place : null;
  if (i >= 0 && !here && i > 0 && timeline.intervals[i - 1].end === timeline.intervals[i].start) here = timeline.intervals[i - 1].place;
  if (!here || isHomePlace(here, config)) here = homePlace(config);

  const currentTrip = trips.find((t) => t.startMs <= now && now < t.endMs);
  const todayOut = { city: here.city || '', region: here.region || '', tz: here.tz || homeTz, work: !!(currentTrip && currentTrip.work) };

  // Travel-day note: a journey that is underway or leaves today (origin's local date).
  const finalLeg = (f) => { while (f.connectsTo) f = f.connectsTo; return f; };
  const tzOf = (code) => (AIRPORTS[code] && AIRPORTS[code].tz) || homeTz;
  const leg = flights.find((f) => f.timeKnown && !f.isConnection && finalLeg(f).arr > now &&
    (f.dep <= now || localDate(f.dep, tzOf(f.from)) === localDate(now, tzOf(f.from))));
  if (leg) {
    const last = finalLeg(leg);
    const j = intervalAt(last.arr);
    const dest = (j >= 0 && timeline.intervals[j].place) || last.toPlace;
    todayOut.transit = {
      to: isHomePlace(dest, config) ? config.home.city : (dest.city || dest.region),
      departs: isoInTz(leg.dep, tzOf(leg.from)),
      lands: isoInTz(last.arr, last.toPlace.tz || homeTz),
    };
  }

  // Back home: end of the trip he's on (or leaving on today). Home "on" a date = home by 6 pm;
  // a 9:55 pm landing reads as "home tomorrow".
  const homeTrip = currentTrip || trips.find((t) => t.start === today && t.startMs > now);
  let homeOn = null;
  if (homeTrip) {
    const endDate = localDate(homeTrip.endMs, homeTz);
    homeOn = zonedParts(homeTrip.endMs, homeTz).h < HOME_BY_HOUR ? endDate : addDays(endDate, 1);
  }

  const horizon = addDays(today, LOOKAHEAD_DAYS);
  return {
    updated: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    today: todayOut,
    homeOn,
    trips: trips
      .filter((t) => t.start > today && t.start <= horizon)
      .map((t) => ({ start: t.start, end: t.end, place: t.place, work: t.work, metros: t.metros })),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildStatus, collectFlights,
    parseCalendarFlight, parseStay, parseAddress, parseEmailSubject, parseMarker, inferFlightDate, isIgnoredEvent,
  };
}
