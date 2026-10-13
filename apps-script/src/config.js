/**
 * Where's Lange? — trip tagging config for the Apps Script (no personal data: viewer emails and the
 * phone number live only in the Worker's VIEWERS secret).
 *
 * metros: each viewer's metro (in VIEWERS) refers to one of these IDs. A trip is tagged with a
 * metro when it lands at one of its airports, or stays in one of its cities within its states
 * (so Lawrence, KS never counts as Long Island's Lawrence, NY).
 */
// Nassau and Suffolk counties (Long Island), towns, villages and hamlets.
const LONG_ISLAND = [
  'Long Island', 'Albertson', 'Atlantic Beach', 'Baldwin', 'Bayville', 'Bellmore', 'Bethpage', 'Carle Place',
  'Cedarhurst', 'East Meadow', 'East Rockaway', 'East Williston', 'Elmont', 'Farmingdale', 'Floral Park',
  'Franklin Square', 'Freeport', 'Garden City', 'Glen Cove', 'Glen Head', 'Great Neck', 'Hempstead', 'Hewlett',
  'Hicksville', 'Inwood', 'Island Park', 'Jericho', 'Kings Point', 'Lake Success', 'Lawrence', 'Levittown',
  'Locust Valley', 'Long Beach', 'Lynbrook', 'Malverne', 'Manhasset', 'Massapequa', 'Massapequa Park', 'Merrick',
  'Mill Neck', 'Mineola', 'Muttontown', 'New Hyde Park', 'North Hempstead', 'North Massapequa', 'Oceanside',
  'Old Bethpage', 'Old Westbury', 'Oyster Bay', 'Plainview', 'Point Lookout', 'Port Washington', 'Rockville Centre',
  'Roosevelt', 'Roslyn', 'Sands Point', 'Sea Cliff', 'Seaford', 'Syosset', 'Uniondale', 'Valley Stream', 'Wantagh',
  'West Hempstead', 'Westbury', 'Williston Park', 'Woodbury', 'Woodmere', 'Amagansett', 'Amityville', 'Babylon',
  'Bay Shore', 'Bayport', 'Bellport', 'Bohemia', 'Brentwood', 'Bridgehampton', 'Brookhaven', 'Calverton',
  'Centereach', 'Centerport', 'Central Islip', 'Cold Spring Harbor', 'Commack', 'Copiague', 'Coram', 'Cutchogue',
  'Deer Park', 'Dix Hills', 'East Hampton', 'East Islip', 'East Northport', 'East Setauket', 'Eastport',
  'Farmingville', 'Fire Island', 'Fishers Island', 'Fort Salonga', 'Great River', 'Greenlawn', 'Greenport',
  'Hampton Bays', 'Hauppauge', 'Holbrook', 'Holtsville', 'Huntington', 'Huntington Station', 'Islandia', 'Islip',
  'Jamesport', 'Kings Park', 'Lake Grove', 'Lindenhurst', 'Lloyd Harbor', 'Manorville', 'Mastic', 'Mastic Beach',
  'Mattituck', 'Medford', 'Melville', 'Miller Place', 'Montauk', 'Mount Sinai', 'Nesconset', 'North Babylon',
  'Northport', 'Oakdale', 'Ocean Beach', 'Orient', 'Patchogue', 'Port Jefferson', 'Port Jefferson Station', 'Quogue',
  'Riverhead', 'Rocky Point', 'Ronkonkoma', 'Sag Harbor', 'Sagaponack', 'Saint James', 'St. James', 'Saltaire',
  'Sayville', 'Selden', 'Setauket', 'Shelter Island', 'Shirley', 'Shoreham', 'Smithtown', 'Southampton', 'Southold',
  'Springs', 'Stony Brook', 'Wading River', 'Wainscott', 'Water Mill', 'West Babylon', 'West Islip', 'Westhampton',
  'Westhampton Beach', 'Wyandanch', 'Yaphank',
];

// Boroughs, well-known neighborhoods and close-in towns, so a marker like "Manhattan, NY" or
// "Brookline, MA" still finds its metro. A name that isn't listed just gets no badge.
const NYC = [
  'New York', 'New York City', 'NYC', 'Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island',
  'Harlem', 'Upper West Side', 'Upper East Side', 'Midtown', 'Chelsea', 'Greenwich Village', 'West Village',
  'East Village', 'Lower East Side', 'SoHo', 'Tribeca', 'Financial District', 'Williamsburg', 'Greenpoint',
  'Bushwick', 'Park Slope', 'Brooklyn Heights', 'DUMBO', 'Astoria', 'Long Island City', 'Flushing',
  'Jersey City', 'Hoboken', 'Weehawken', 'Newark',
];
const BOSTON = [
  'Boston', 'Cambridge', 'Somerville', 'Brookline', 'Newton', 'Watertown', 'Belmont', 'Arlington', 'Medford',
  'Malden', 'Everett', 'Chelsea', 'Revere', 'Quincy', 'Waltham', 'Allston', 'Brighton', 'Charlestown',
  'Dorchester', 'Roxbury', 'Jamaica Plain', 'South Boston', 'East Boston', 'Back Bay',
];

const CONFIG = {
  home: { city: 'San Francisco', region: 'CA', tz: 'America/Los_Angeles' },
  homeAirports: ['SFO', 'OAK', 'SJC'],
  metros: {
    stockton: { regions: ['CA'], airports: ['SCK', 'SMF'], cities: ['Stockton', 'Lodi', 'Sacramento'] },
    la: { regions: ['CA'], airports: ['LAX', 'BUR', 'LGB', 'SNA', 'ONT'], cities: ['Los Angeles', 'Santa Monica', 'Pasadena'] },
    sacramento: { regions: ['CA'], airports: ['SMF'], cities: ['Sacramento', 'Davis'] },
    tucson: { regions: ['AZ'], airports: ['TUS'], cities: ['Tucson', 'South Tucson', 'Oro Valley', 'Marana', 'Catalina Foothills'] },
    boston: { regions: ['MA'], airports: ['BOS'], cities: BOSTON },
    // NYC includes Long Island, so NYC viewers see Long Island trips too.
    nyc: { regions: ['NY', 'NJ'], airports: ['JFK', 'LGA', 'EWR', 'ISP'], cities: [...NYC, ...LONG_ISLAND] },
    longisland: { regions: ['NY'], airports: ['ISP'], cities: LONG_ISLAND },
    dc: { regions: ['DC', 'VA', 'MD'], airports: ['DCA', 'IAD', 'BWI'], cities: ['Washington', 'Georgetown', 'Arlington', 'Alexandria', 'Bethesda', 'Chevy Chase', 'Silver Spring', 'Takoma Park', 'Hyattsville', 'College Park', 'Falls Church', 'McLean'] },
    burlington: { regions: ['VT'], airports: ['BTV'], cities: ['Burlington', 'South Burlington', 'Winooski', 'Essex', 'Essex Junction', 'Colchester', 'Shelburne', 'Williston'] },
    seattle: { regions: ['WA'], airports: ['SEA'], cities: ['Seattle', 'Bellevue', 'Redmond', 'Kirkland', 'Mercer Island', 'Shoreline', 'Renton', 'Ballard', 'Capitol Hill', 'Fremont'] },
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { CONFIG, LONG_ISLAND };
