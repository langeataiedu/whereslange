/**
 * Where's Lange? — trip tagging config for the Apps Script (no personal data: viewer emails and the
 * phone number live only in the Worker's VIEWERS secret).
 *
 * metros: each viewer's metro (in VIEWERS) refers to one of these IDs. A trip is tagged with a
 * metro when it lands at one of its airports or stays in one of its cities.
 */
const CONFIG = {
  home: { city: 'San Francisco', region: 'CA', tz: 'America/Los_Angeles' },
  homeAirports: ['SFO', 'OAK', 'SJC'],
  metros: {
    stockton: { airports: ['SCK', 'SMF'], cities: ['Stockton', 'Lodi', 'Sacramento'] },
    la: { airports: ['LAX', 'BUR', 'LGB', 'SNA', 'ONT'], cities: ['Los Angeles', 'Santa Monica', 'Pasadena'] },
    sacramento: { airports: ['SMF'], cities: ['Sacramento', 'Davis'] },
    tucson: { airports: ['TUS'], cities: ['Tucson'] },
    boston: { airports: ['BOS'], cities: ['Boston', 'Cambridge', 'Somerville'] },
    nyc: { airports: ['JFK', 'LGA', 'EWR'], cities: ['New York', 'Brooklyn', 'Jersey City', 'Newark'] },
    dc: { airports: ['DCA', 'IAD', 'BWI'], cities: ['Washington', 'Arlington', 'Alexandria'] },
    burlington: { airports: ['BTV'], cities: ['Burlington'] },
    seattle: { airports: ['SEA'], cities: ['Seattle', 'Bellevue'] },
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { CONFIG };
