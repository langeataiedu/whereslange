import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../apps-script/src/core.js');
const fixture = require('./fixtures/fall-2026.json');
const expectedStatus = require('./fixtures/status-2026-10-07.json');

const { config, events, emails } = fixture;
const statusAt = (now, overrides = {}) => core.buildStatus({ config, events, emails, now, ...overrides });

const flight = (title, start, end) => ({ title, start, end, allDay: false, eventType: 'default' });
const allDay = (title, start, end, eventType = 'default') => ({ title, start, end, allDay: true, eventType });

describe('parsers (SPEC §7 fixtures)', () => {
  it('calendar flight', () => {
    expect(core.parseCalendarFlight('Flight: SFO (UA2386) to DCA Confirmation ABC123')).toEqual({ from: 'SFO', to: 'DCA' });
  });

  it("Gmail's duplicate flight event is ignored (the Navan event covers it)", () => {
    expect(core.parseCalendarFlight('Flight to Washington (UA 2386)')).toBeNull();
  });

  it('hotel stay: city + state from the address, hotel name dropped', () => {
    const stay = core.parseStay(
      'Stay: The Morrow Washington Dc, Curio Collection By Hilton, Washington Confirmation 0000000000',
      'The Morrow Washington Dc, Curio Collection By Hilton, 222 M STREET NE, Washington, DC 20002, US');
    expect(stay).toEqual({ city: 'Washington', region: 'DC', tz: 'America/New_York' });
  });

  it('hotel stay abroad', () => {
    expect(core.parseAddress('Hotel Adlon Kempinski, Unter den Linden 77, 10117 Berlin, DE'))
      .toEqual({ city: 'Berlin', region: 'Germany', tz: 'Europe/Berlin' });
  });

  it('email, new format', () => {
    expect(core.parseEmailSubject('Your Nov 28 EWR–SMF flight is confirmed [ABC123]'))
      .toEqual({ kind: 'confirmed', month: 11, day: 28, from: 'EWR', to: 'SMF' });
  });

  it.each([
    'Your Sep 18 one-way DCA-SFO flight is confirmed - ABC123',
    'Your Sep 18 one-way DCA–SFO flight is confirmed – ABC123',
    'Your Sep 18 one-way DCA—SFO flight is confirmed - ABC123',
  ])('email, old format: %s', (subject) => {
    expect(core.parseEmailSubject(subject))
      .toEqual({ kind: 'confirmed', month: 9, day: 18, from: 'DCA', to: 'SFO' });
  });

  it('email, ticketing', () => {
    expect(core.parseEmailSubject('Your Oct 7 DCA–SFO flight is being ticketed').kind).toBe('ticketing');
  });

  it('email, cancellation', () => {
    expect(core.parseEmailSubject("You've canceled your Sep 18 DCA–SFO flight"))
      .toEqual({ kind: 'canceled', month: 9, day: 18, from: 'DCA', to: 'SFO' });
    expect(core.parseEmailSubject('You’ve cancelled your Sep 18 DCA-SFO flight').kind).toBe('canceled');
  });

  it('unrelated email', () => {
    expect(core.parseEmailSubject('Your receipt from Navan')).toBeNull();
  });

  it('email year: a January flight booked in December is next year', () => {
    expect(core.inferFlightDate(1, 3, Date.parse('2026-12-20T12:00:00Z'), 'America/Los_Angeles')).toBe('2027-01-03');
    expect(core.inferFlightDate(11, 28, Date.parse('2026-10-01T12:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-28');
  });

  it('manual markers', () => {
    expect(core.parseMarker('📍 Stockton, CA [personal]')).toEqual({
      place: { city: 'Stockton', region: 'CA', tz: 'America/Los_Angeles' },
      tags: { work: false, personal: true },
    });
    expect(core.parseMarker('📍 Berlin, Germany [work]')).toEqual({
      place: { city: 'Berlin', region: 'Germany', tz: 'Europe/Berlin' },
      tags: { work: true, personal: false },
    });
    expect(core.parseMarker('📍 Germany').place).toEqual({ city: null, region: 'Germany', tz: 'Europe/Berlin' });
    expect(core.parseMarker('Lunch with Sam')).toBeNull();
  });

  it('working location events are ignored', () => {
    expect(core.isIgnoredEvent(allDay('Germany', '2026-11-10', '2026-11-21', 'workingLocation'))).toBe(true);
    const s = statusAt('2026-10-12T19:00:00Z', {
      events: [allDay('📍 Berlin, Germany [work]', '2026-10-12', '2026-10-14', 'workingLocation')], emails: [],
    });
    expect(s.today.city).toBe('San Francisco');
  });
});

describe('merge: acceptance week Oct 5–8, 2026', () => {
  it('Washington, DC on Oct 6', () => {
    const s = statusAt('2026-10-06T19:00:00Z');
    expect(s.today).toMatchObject({ city: 'Washington', region: 'DC', tz: 'America/New_York', work: true });
    expect(s.today.transit).toBeUndefined();
    expect(s.homeOn).toBe('2026-10-08');
  });

  it('travel day before departure: still DC, with a transit note', () => {
    expect(statusAt('2026-10-07T20:12:00Z')).toEqual(expectedStatus);
  });

  it('in transit after 3:57 pm PT on Oct 7', () => {
    const now = '2026-10-07T23:30:00Z'; // 4:30 pm PT
    const s = statusAt(now);
    expect(Date.parse(s.today.transit.departs)).toBeLessThanOrEqual(Date.parse(now));
    expect(Date.parse(s.today.transit.lands)).toBeGreaterThan(Date.parse(now));
    expect(s.today.transit.to).toBe('San Francisco');
  });

  it('home on Oct 8', () => {
    const s = statusAt('2026-10-08T19:00:00Z');
    expect(s.today).toEqual({ city: 'San Francisco', region: 'CA', tz: 'America/Los_Angeles', work: false });
    expect(s.homeOn).toBeNull();
  });

  it('Gmail duplicate flights are deduped (one trip, no extra legs)', () => {
    const flights = core.collectFlights(events.filter((e) => !core.isIgnoredEvent(e)), emails, config);
    expect(flights.filter((f) => f.to === 'DCA')).toHaveLength(1);
    expect(flights.filter((f) => f.from === 'DCA' && f.to === 'SFO')).toHaveLength(1); // email + calendar + Gmail = 1
  });
});

describe('merge: rules', () => {
  it('upcoming trips: plain marker, personal, international, email-only', () => {
    const s = statusAt('2026-10-07T20:12:00Z');
    expect(s.trips.map((t) => [t.start, t.end, t.place, t.work])).toEqual([
      ['2026-10-15', '2026-10-16', 'Chicago, IL', false],
      ['2026-10-24', '2026-10-25', 'Stockton, CA', false],
      ['2026-11-10', '2026-11-20', 'Germany', true],
      ['2026-11-28', '2026-11-28', 'Sacramento, CA', true],
    ]);
  });

  it('[personal] marker removes the work star from a Navan trip on those dates', () => {
    const s = statusAt('2026-10-01T19:00:00Z', {
      events: [
        flight('Flight: SFO (UA100) to LAX Confirmation AAA111', '2026-10-10T09:00:00-07:00', '2026-10-10T10:30:00-07:00'),
        flight('Flight: LAX (UA101) to SFO Confirmation AAA111', '2026-10-11T18:00:00-07:00', '2026-10-11T19:30:00-07:00'),
        allDay('📍 Los Angeles, CA [personal]', '2026-10-10', '2026-10-12'),
      ],
      emails: [],
    });
    expect(s.trips).toEqual([{ start: '2026-10-10', end: '2026-10-11', place: 'Los Angeles, CA', work: false, metros: ['la'] }]);
  });

  it('every country: names, aliases and US state names resolve to a time zone', () => {
    const place = (t) => core.parseMarker(t).place;
    expect(place('📍 Boise, Idaho')).toEqual({ city: 'Boise', region: 'ID', tz: 'America/Boise' });
    expect(place('📍 Atlanta, Georgia')).toEqual({ city: 'Atlanta', region: 'GA', tz: 'America/New_York' });
    expect(place('📍 Tbilisi, Georgia')).toEqual({ city: 'Tbilisi', region: 'Georgia', tz: 'Asia/Tbilisi' });
    expect(place('📍 Edinburgh, Scotland').tz).toBe('Europe/London');
    expect(place('📍 Istanbul, Türkiye').tz).toBe('Europe/Istanbul');
    expect(place('📍 Abidjan, Ivory Coast').tz).toBe('Africa/Abidjan');
    expect(place('📍 Thimphu, Bhutan').tz).toBe('Asia/Thimphu');
    expect(place('📍 Chicago')).toEqual({ city: 'Chicago', region: 'IL', tz: 'America/Chicago' });
  });

  it('cities in multi-zone countries get their own time zone', () => {
    expect(core.parseMarker('📍 Vancouver, Canada').place.tz).toBe('America/Vancouver');
    expect(core.parseMarker('📍 Perth, Australia').place.tz).toBe('Australia/Perth');
    expect(core.parseMarker('📍 Cancún, Mexico').place.tz).toBe('America/Cancun');
    expect(core.parseAddress('Some Resort, Jl. Raya 1, 80361 Bali, ID').tz).toBe('Asia/Makassar');
  });

  it('an unrecognized place has no time zone (the page leaves out the local time)', () => {
    expect(core.parseMarker('📍 Atlantis, Narnia').place.tz).toBeNull();
    const s = statusAt('2026-10-21T19:00:00Z', { events: [allDay('📍 Atlantis, Narnia', '2026-10-20', '2026-10-23')], emails: [] });
    expect(s.today).toEqual({ city: 'Atlantis', region: 'Narnia', tz: null, work: false });
  });

  it('metros match cities only within their states', () => {
    const config = { ...fixture.config, metros: { li: { regions: ['NY'], cities: ['Lawrence', 'Melville'] } } };
    const metros = (t) => core.buildStatus({ config, events: [allDay(t, '2026-10-20', '2026-10-22')], emails: [], now: '2026-10-10T19:00:00Z' }).trips[0].metros;
    expect(metros('📍 Lawrence, NY')).toEqual(['li']);
    expect(metros('📍 Lawrence, KS')).toEqual([]);
  });

  it('multi-stop trips: countries when abroad, short list at home', () => {
    const at = (events) => statusAt('2026-10-01T19:00:00Z', { events, emails: [] }).trips.map((t) => t.place);
    expect(at([
      allDay('📍 Budapest, Hungary', '2026-11-10', '2026-11-13'),
      allDay('📍 Berlin, Germany', '2026-11-13', '2026-11-16'),
      allDay('📍 Munich, Germany', '2026-11-16', '2026-11-18'),
    ])).toEqual(['Hungary & Germany']);
    expect(at([
      allDay('📍 Boston, MA', '2026-10-10', '2026-10-12'),
      allDay('📍 New York, NY', '2026-10-12', '2026-10-14'),
    ])).toEqual(['Boston, MA & New York, NY']);
    expect(at([
      allDay('📍 Boston, MA', '2026-10-10', '2026-10-11'),
      allDay('📍 Providence, RI', '2026-10-11', '2026-10-12'),
      allDay('📍 New Haven, CT', '2026-10-12', '2026-10-13'),
      allDay('📍 New York, NY', '2026-10-13', '2026-10-14'),
    ])).toEqual(['Boston, MA, Providence, RI & 2 more']);
  });

  it('[work] marker adds the star to a manual trip', () => {
    const s = statusAt('2026-10-01T19:00:00Z', { events: [allDay('📍 Berlin, Germany [work]', '2026-11-10', '2026-11-21')], emails: [] });
    expect(s.trips).toEqual([{ start: '2026-11-10', end: '2026-11-20', place: 'Berlin, Germany', work: true, metros: [] }]);
  });

  it('a canceled flight drops off (date + route match)', () => {
    const events = [flight('Flight: SFO (UA200) to BOS Confirmation BBB222', '2026-10-20T08:00:00-07:00', '2026-10-20T16:30:00-04:00')];
    const confirmed = { subject: 'Your Oct 20 SFO–BOS flight is confirmed [BBB222]', date: '2026-10-01T12:00:00Z' };
    const canceled = { subject: "You've canceled your Oct 20 SFO–BOS flight", date: '2026-10-05T12:00:00Z' };
    const now = '2026-10-06T19:00:00Z';
    expect(statusAt(now, { events, emails: [confirmed] }).trips).toHaveLength(1);
    expect(statusAt(now, { events, emails: [confirmed, canceled] }).trips).toHaveLength(0);
    // email-only flight canceled too
    expect(statusAt(now, { events: [], emails: [confirmed, canceled] }).trips).toHaveLength(0);
    // rebooked on the same route after canceling: the newer confirmation wins
    const rebooked = { subject: 'Your Oct 20 SFO–BOS flight is confirmed [CCC333]', date: '2026-10-06T12:00:00Z' };
    expect(statusAt(now, { events: [], emails: [confirmed, canceled, rebooked] }).trips).toHaveLength(1);
  });

  it('ticketing emails alone create nothing', () => {
    const emails = [{ subject: 'Your Oct 20 SFO–BOS flight is being ticketed', date: '2026-10-01T12:00:00Z' }];
    expect(statusAt('2026-10-06T19:00:00Z', { events: [], emails }).trips).toHaveLength(0);
  });

  it('email-only flight (Nov 28 EWR–SMF) becomes a Sacramento day, tagged for Stockton', () => {
    const s = statusAt('2026-11-28T19:00:00Z');
    expect(s.today).toMatchObject({ city: 'Sacramento', region: 'CA' });
    expect(s.today.transit).toBeUndefined(); // no times known from the email
    expect(s.homeOn).toBe('2026-11-29');
  });

  it('connections are one journey: no layover city, transit goes to the final stop', () => {
    const events = [
      flight('Flight: SFO (UA1) to ORD Confirmation DDD444', '2026-10-20T07:00:00-07:00', '2026-10-20T13:10:00-05:00'),
      flight('Flight: ORD (UA2) to BOS Confirmation DDD444', '2026-10-20T14:30:00-05:00', '2026-10-20T17:45:00-04:00'),
      flight('Flight: BOS (UA3) to SFO Confirmation DDD444', '2026-10-23T18:00:00-04:00', '2026-10-23T21:30:00-07:00'),
    ];
    const before = statusAt('2026-10-19T19:00:00Z', { events, emails: [] });
    expect(before.trips).toEqual([{ start: '2026-10-20', end: '2026-10-23', place: 'Boston, MA', work: true, metros: ['boston'] }]);
    const layover = statusAt('2026-10-20T19:00:00Z', { events, emails: [] }); // 2 pm in Chicago, between legs
    expect(layover.today.transit).toMatchObject({ to: 'Boston', lands: '2026-10-20T17:45:00-04:00' });
    expect(layover.today.city).toBe('San Francisco');
  });

  it('abroad: city + country; landing home by 6 pm counts as home that day', () => {
    const s = statusAt('2026-11-12T19:00:00Z');
    expect(s.today).toEqual({ city: 'Berlin', region: 'Germany', tz: 'Europe/Berlin', work: true });
    expect(s.homeOn).toBe('2026-11-20'); // lands SFO 4:05 pm
  });

  it('nothing on the calendar: home in San Francisco', () => {
    const s = statusAt('2026-10-12T19:00:00Z', { events: [], emails: [] });
    expect(s).toEqual({
      updated: '2026-10-12T19:00:00Z',
      today: { city: 'San Francisco', region: 'CA', tz: 'America/Los_Angeles', work: false },
      homeOn: null,
      trips: [],
    });
  });

  it('only trips in the next 60 days are listed', () => {
    const s = statusAt('2026-09-01T19:00:00Z');
    expect(s.trips.map((t) => t.start)).toEqual(['2026-10-05', '2026-10-15', '2026-10-24']);
  });
});

describe('privacy: the status is schema fields only', () => {
  const TODAY_KEYS = ['city', 'region', 'tz', 'work', 'transit'];
  const SECRETS = [
    'ABC123', 'DEF456', 'GHI789', 'JKL012', 'MNO345', '0000000000', '1111111111', '2222222222',
    'Morrow', 'Curio', 'Hilton', 'Adlon', 'Kempinski', 'Bayerischer', '222 M', 'Linden', 'Promenadeplatz',
    'UA2386', 'UA 2386', 'UA1234', 'LH455', 'LH454', 'DCA', 'EWR', 'SMF', 'FRA',
  ];

  it.each([
    '2026-09-01T19:00:00Z', '2026-10-06T19:00:00Z', '2026-10-07T20:12:00Z', '2026-10-07T23:30:00Z',
    '2026-10-15T19:00:00Z', '2026-11-12T19:00:00Z', '2026-11-28T19:00:00Z',
  ])('at %s', (now) => {
    const s = statusAt(now);
    expect(Object.keys(s).sort()).toEqual(['homeOn', 'today', 'trips', 'updated']);
    for (const k of Object.keys(s.today)) expect(TODAY_KEYS).toContain(k);
    if (s.today.transit) expect(Object.keys(s.today.transit).sort()).toEqual(['departs', 'lands', 'to']);
    for (const t of s.trips) expect(Object.keys(t).sort()).toEqual(['end', 'metros', 'place', 'start', 'work']);
    const json = JSON.stringify(s);
    for (const secret of SECRETS) expect(json).not.toContain(secret);
  });
});
