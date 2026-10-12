/**
 * Where's Lange? — turns a status payload into plain-language text for the page.
 * Pure functions (callers pass `now`). Browser: window.LangeFormat. Node: require().
 */
(function (root) {
  const DAY = 24 * 3600e3;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const STALE_AFTER = 3 * 3600e3;

  // "Local Mail" area: the 9 Bay Area counties + Sacramento and San Joaquin counties (CA only).
  // Incorporated cities plus common unincorporated place names.
  const LOCAL_CITIES = new Set([
    // San Francisco
    'San Francisco',
    // San Mateo
    'Atherton', 'Belmont', 'Brisbane', 'Burlingame', 'Colma', 'Daly City', 'East Palo Alto', 'Foster City',
    'Half Moon Bay', 'Hillsborough', 'Menlo Park', 'Millbrae', 'Pacifica', 'Portola Valley', 'Redwood City',
    'San Bruno', 'San Carlos', 'San Mateo', 'South San Francisco', 'Woodside',
    // Santa Clara
    'Campbell', 'Cupertino', 'Gilroy', 'Los Altos', 'Los Altos Hills', 'Los Gatos', 'Milpitas', 'Monte Sereno',
    'Morgan Hill', 'Mountain View', 'Palo Alto', 'San Jose', 'Santa Clara', 'Saratoga', 'Sunnyvale',
    // Alameda
    'Alameda', 'Albany', 'Berkeley', 'Castro Valley', 'Dublin', 'Emeryville', 'Fremont', 'Hayward', 'Livermore',
    'Newark', 'Oakland', 'Piedmont', 'Pleasanton', 'San Leandro', 'San Lorenzo', 'Union City',
    // Contra Costa
    'Alamo', 'Antioch', 'Brentwood', 'Clayton', 'Concord', 'Danville', 'El Cerrito', 'El Sobrante', 'Hercules',
    'Lafayette', 'Martinez', 'Moraga', 'Oakley', 'Orinda', 'Pinole', 'Pittsburg', 'Pleasant Hill', 'Richmond',
    'San Pablo', 'San Ramon', 'Walnut Creek',
    // Marin
    'Belvedere', 'Bolinas', 'Corte Madera', 'Fairfax', 'Larkspur', 'Mill Valley', 'Muir Beach', 'Novato',
    'Point Reyes Station', 'Ross', 'San Anselmo', 'San Rafael', 'Sausalito', 'Stinson Beach', 'Tiburon',
    // Sonoma
    'Bodega Bay', 'Cloverdale', 'Cotati', 'Guerneville', 'Healdsburg', 'Petaluma', 'Rohnert Park', 'Santa Rosa',
    'Sebastopol', 'Sonoma', 'Windsor',
    // Napa
    'American Canyon', 'Calistoga', 'Napa', 'St. Helena', 'Saint Helena', 'Yountville',
    // Solano
    'Benicia', 'Dixon', 'Fairfield', 'Rio Vista', 'Suisun City', 'Vacaville', 'Vallejo',
    // Sacramento County
    'Sacramento', 'Antelope', 'Carmichael', 'Citrus Heights', 'Elk Grove', 'Fair Oaks', 'Folsom', 'Galt',
    'Isleton', 'North Highlands', 'Orangevale', 'Rancho Cordova',
    // San Joaquin
    'Stockton', 'Escalon', 'French Camp', 'Lathrop', 'Lockeford', 'Lodi', 'Manteca', 'Mountain House', 'Ripon', 'Tracy',
  ].map((c) => c.toLowerCase()));

  function isLocalArea(city, region) {
    return region === 'CA' && !!city && LOCAL_CITIES.has(city.trim().toLowerCase());
  }

  /** Stamp on the Today card: 'local' inside that area, 'air' anywhere else or while flying. */
  function mailStamp(today, inAir) {
    return !inAir && isLocalArea(today.city, today.region) ? 'local' : 'air';
  }

  const ymd = (s) => s.split('-').map(Number);
  const utcOf = (s) => { const [y, m, d] = ymd(s); return Date.UTC(y, m - 1, d); };
  const daysBetween = (a, b) => Math.round((utcOf(b) - utcOf(a)) / DAY);

  function partsIn(ms, tz) {
    const p = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
    return { date: `${p.year}-${p.month}-${p.day}`, h: +p.hour % 24, mi: +p.minute };
  }

  /** Wall-clock parts straight from an ISO string with offset: "2026-10-07T21:55:00-07:00". */
  function wallClock(iso) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(iso);
    return { date: m[1], h: +m[2], mi: +m[3] };
  }

  /** 16, 12 -> "4:12 pm";  22, 0 -> "10 pm" (short) or "10:00 pm" */
  function clock(h, mi, opts) {
    const suffix = h < 12 ? 'am' : 'pm';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    if (mi === 0 && opts && opts.short) return `${h12} ${suffix}`;
    return `${h12}:${String(mi).padStart(2, '0')} ${suffix}`;
  }

  /** Round to the nearest quarter hour for "about 10 pm". */
  function approx(h, mi) {
    const total = Math.round((h * 60 + mi) / 15) * 15;
    return clock(Math.floor(total / 60) % 24, total % 60, { short: true });
  }

  function formatDate(date) {
    const [y, m, d] = ymd(date);
    return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
  }

  /** "Nov 28", "Nov 10–20", "Oct 31 – Nov 2" */
  function formatRange(start, end) {
    const [, sm, sd] = ymd(start);
    const [, em, ed] = ymd(end);
    if (start === end) return `${MONTHS[sm - 1]} ${sd}`;
    if (sm === em) return `${MONTHS[sm - 1]} ${sd}–${ed}`;
    return `${MONTHS[sm - 1]} ${sd} – ${MONTHS[em - 1]} ${ed}`;
  }

  function relativeDay(date, today) {
    const n = daysBetween(today, date);
    return n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
  }

  const placeText = (today) => [today.city, today.region].filter(Boolean).join(', ');

  function partOfDay(h) {
    if (h < 12) return 'this morning';
    if (h < 17) return 'this afternoon';
    return 'tonight';
  }

  /** The travel-day pill, or null. */
  function travelPill(today, now, home) {
    const t = today.transit;
    if (!t || Date.parse(t.lands) <= now) return null;
    const lands = wallClock(t.lands);
    const departs = wallClock(t.departs);
    const goingHome = t.to === home.city;
    const landsText = `lands ${lands.date !== departs.date ? 'tomorrow ' : ''}about ${approx(lands.h, lands.mi)}${goingHome ? '' : ` ${t.to} time`}`;
    if (Date.parse(t.departs) <= now) return `${goingHome ? 'On the way home' : 'In the air'} · ${landsText}`;
    return `Flying ${goingHome ? 'home' : `to ${t.to}`} ${partOfDay(departs.h)} · ${landsText}`;
  }

  function freshness(updated, now, tz) {
    const u = partsIn(Date.parse(updated), tz);
    const n = daysBetween(u.date, partsIn(now, tz).date);
    const day = n === 0 ? 'today' : n === 1 ? 'yesterday' : formatDate(u.date);
    return { text: `Updated ${clock(u.h, u.mi)} ${day}`, stale: now - Date.parse(updated) > STALE_AFTER };
  }

  /**
   * opts: { now, tz (viewer's), home: {city, region}, phone, highlight: {metro, label} | null, viewerName? }
   * highlight is the viewer's your-city metro (the Worker adds it per viewer).
   */
  function viewModel(status, opts) {
    const { now, home, highlight } = opts;
    const today = status.today;
    const isHome = today.city === home.city && today.region === home.region;
    const inAir = !!today.transit && Date.parse(today.transit.departs) <= now && Date.parse(today.transit.lands) > now;
    // Lange's wall clock, wherever he is. Left out in the air, or when the place wasn't recognized (no tz).
    const lange = !inAir && today.tz ? partsIn(now, today.tz) : null;

    const trips = status.trips.map((t) => {
      const dates = formatRange(t.start, t.end);
      const badge = highlight && t.metros.includes(highlight.metro) ? highlight.label : null;
      const body = `Hi Lange! I saw you'll be in ${t.place.split(',')[0]} ${dates}. Let's get dinner?`;
      return { dates, place: t.place, work: t.work, badge, dinnerHref: badge ? `sms:${opts.phone}?&body=${encodeURIComponent(body)}` : null };
    });

    return {
      today: {
        place: inAir ? 'In the air' : placeText(today),
        sub: inAir ? `${placeText(today)} → ${today.transit.to}` : '',
        sleeping: today.sleeping || null, // hotel name, "At home", "Overnight flight"
        localTime: lange ? clock(lange.h, lange.mi) : null,
        fact: today.fact || null, // { text, wikiUrl }
        inAir,
        isHome,
        mail: mailStamp(today, inAir),
        work: today.work,
        localHour: (lange || partsIn(now, opts.tz)).h,
      },
      pill: travelPill(today, now, home),
      back: status.homeOn ? { date: formatDate(status.homeOn), rel: relativeDay(status.homeOn, partsIn(now, opts.tz).date) } : null,
      trips,
      greeting: opts.viewerName ? `Hi ${String(opts.viewerName).trim().split(/\s+/)[0]}!` : null,
      showKey: today.work || trips.some((t) => t.work),
      updated: freshness(status.updated, now, opts.tz),
      textHref: `sms:${opts.phone}`,
      callHref: `tel:${opts.phone}`,
    };
  }

  const api = { viewModel, mailStamp, travelPill, freshness, formatRange, relativeDay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LangeFormat = api;
})(typeof window !== 'undefined' ? window : globalThis);
