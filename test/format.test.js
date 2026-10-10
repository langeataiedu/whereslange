import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const F = require('../public/format.js');
const status = require('./fixtures/status-2026-10-07.json');
const { config } = require('./fixtures/fall-2026.json');

const opts = (now, highlight) => ({
  now: Date.parse(now), tz: 'America/Los_Angeles', home: config.home, phone: '+15555550123', highlight,
});
const MARY = { metro: 'stockton', label: 'Near Mom & Dad' }; // what the Worker sends for Mom
const JASON = null; // SF friend: no highlight

describe('page text', () => {
  it('travel day, before the flight (the SPEC mockup)', () => {
    const vm = F.viewModel(status, opts('2026-10-07T20:12:00Z', MARY));
    expect(vm.today).toMatchObject({ place: 'Washington, DC', sub: '4:12 pm there', inAir: false, work: true });
    expect(vm.pill).toBe('Flying home tonight · lands about 10 pm');
    expect(vm.back).toEqual({ date: 'Thu, Oct 8', rel: 'tomorrow' });
    expect(vm.updated).toEqual({ text: 'Updated 1:12 pm today', stale: false });
  });

  it('in the air', () => {
    const vm = F.viewModel(status, opts('2026-10-07T23:30:00Z', MARY));
    expect(vm.today).toMatchObject({ place: 'In the air', sub: 'Washington, DC → San Francisco', inAir: true });
    expect(vm.pill).toBe('On the way home · lands about 10 pm');
  });

  it('flying somewhere else, overnight', () => {
    const today = { city: 'San Francisco', region: 'CA', tz: 'America/Los_Angeles', work: true,
      transit: { to: 'Boston', departs: '2026-10-20T22:30:00-07:00', lands: '2026-10-21T07:05:00-04:00' } };
    expect(F.travelPill(today, Date.parse('2026-10-20T19:00:00Z'), config.home))
      .toBe('Flying to Boston tonight · lands tomorrow about 7 am Boston time');
  });

  it('stale after 3 hours', () => {
    expect(F.freshness('2026-10-07T13:00:00Z', Date.parse('2026-10-07T16:30:00Z'), 'America/Los_Angeles'))
      .toEqual({ text: 'Updated 6:00 am today', stale: true });
  });

  it('dates in plain language', () => {
    expect(F.formatRange('2026-11-10', '2026-11-20')).toBe('Nov 10–20');
    expect(F.formatRange('2026-11-28', '2026-11-28')).toBe('Nov 28');
    expect(F.formatRange('2026-10-31', '2026-11-02')).toBe('Oct 31 – Nov 2');
    expect(F.relativeDay('2026-10-12', '2026-10-07')).toBe('in 5 days');
  });

  it('your-city badge for Mary and Ruperto on the Sacramento trip, not for Jason', () => {
    const mary = F.viewModel(status, opts('2026-10-07T20:12:00Z', MARY)).trips;
    expect(mary.filter((t) => t.badge).map((t) => [t.place, t.badge])).toEqual([
      ['Stockton, CA', 'Near Mom & Dad'], ['Sacramento, CA', 'Near Mom & Dad'],
    ]);
    expect(mary[3].dinnerHref).toMatch(/^sms:\+15555550123\?&body=.*Sacramento/);
    const jason = F.viewModel(status, opts('2026-10-07T20:12:00Z', JASON)).trips;
    expect(jason.every((t) => !t.badge && !t.dinnerHref)).toBe(true);
  });

  it('unrecognized place: no local time, no crash', () => {
    const s = { ...status, today: { city: 'Atlantis', region: 'Narnia', tz: null, work: false } };
    const vm = F.viewModel(s, opts('2026-10-21T19:00:00Z', MARY));
    expect(vm.today).toMatchObject({ place: 'Atlantis, Narnia', sub: '' });
  });

  it('stamp: Local Mail in the Bay Area, Sacramento and San Joaquin counties; Air Mail elsewhere or in flight', () => {
    const at = (city, region) => F.mailStamp({ city, region, tz: 'America/Los_Angeles', work: false }, false);
    expect(at('San Francisco', 'CA')).toBe('local');
    expect(at('Oakland', 'CA')).toBe('local');
    expect(at('Santa Rosa', 'CA')).toBe('local');
    expect(at('Sacramento', 'CA')).toBe('local');
    expect(at('Stockton', 'CA')).toBe('local');
    expect(at('Los Angeles', 'CA')).toBe('air');
    expect(at('Davis', 'CA')).toBe('air'); // Yolo County
    expect(at('Newark', 'NJ')).toBe('air');
    expect(at('Washington', 'DC')).toBe('air');
    expect(at('Berlin', 'Germany')).toBe('air');
    expect(F.mailStamp({ city: 'San Francisco', region: 'CA' }, true)).toBe('air');
  });
});
