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
  // More US
  ISP: { city: 'Islip', region: 'NY', tz: NY }, BOI: { city: 'Boise', region: 'ID', tz: 'America/Boise' },
  MSY: { city: 'New Orleans', region: 'LA', tz: CHI }, BNA: { city: 'Nashville', region: 'TN', tz: CHI },
  MCO: { city: 'Orlando', region: 'FL', tz: NY }, TPA: { city: 'Tampa', region: 'FL', tz: NY },
  FLL: { city: 'Fort Lauderdale', region: 'FL', tz: NY }, PIT: { city: 'Pittsburgh', region: 'PA', tz: NY },
  CLE: { city: 'Cleveland', region: 'OH', tz: NY }, CMH: { city: 'Columbus', region: 'OH', tz: NY },
  IND: { city: 'Indianapolis', region: 'IN', tz: 'America/Indiana/Indianapolis' }, MCI: { city: 'Kansas City', region: 'MO', tz: CHI },
  STL: { city: 'St. Louis', region: 'MO', tz: CHI }, SAT: { city: 'San Antonio', region: 'TX', tz: CHI },
  ABQ: { city: 'Albuquerque', region: 'NM', tz: DEN }, ANC: { city: 'Anchorage', region: 'AK', tz: 'America/Anchorage' },
  OGG: { city: 'Maui', region: 'HI', tz: 'Pacific/Honolulu' }, KOA: { city: 'Kona', region: 'HI', tz: 'Pacific/Honolulu' },
  LIH: { city: 'Kauai', region: 'HI', tz: 'Pacific/Honolulu' }, SBA: { city: 'Santa Barbara', region: 'CA', tz: LA },
  PSP: { city: 'Palm Springs', region: 'CA', tz: LA }, RNO: { city: 'Reno', region: 'NV', tz: LA },
  MRY: { city: 'Monterey', region: 'CA', tz: LA }, FAT: { city: 'Fresno', region: 'CA', tz: LA },
  // More international
  YUL: { city: 'Montreal', region: 'Canada', tz: 'America/Toronto' }, YYC: { city: 'Calgary', region: 'Canada', tz: 'America/Edmonton' },
  CUN: { city: 'Cancún', region: 'Mexico', tz: 'America/Cancun' }, SJD: { city: 'Los Cabos', region: 'Mexico', tz: 'America/Mazatlan' },
  GDL: { city: 'Guadalajara', region: 'Mexico', tz: 'America/Mexico_City' }, PVR: { city: 'Puerto Vallarta', region: 'Mexico', tz: 'America/Mexico_City' },
  LIS: { city: 'Lisbon', region: 'Portugal', tz: 'Europe/Lisbon' }, OPO: { city: 'Porto', region: 'Portugal', tz: 'Europe/Lisbon' },
  MAD: { city: 'Madrid', region: 'Spain', tz: 'Europe/Madrid' }, BCN: { city: 'Barcelona', region: 'Spain', tz: 'Europe/Madrid' },
  FCO: { city: 'Rome', region: 'Italy', tz: 'Europe/Rome' }, MXP: { city: 'Milan', region: 'Italy', tz: 'Europe/Rome' },
  VCE: { city: 'Venice', region: 'Italy', tz: 'Europe/Rome' }, ZRH: { city: 'Zurich', region: 'Switzerland', tz: 'Europe/Zurich' },
  GVA: { city: 'Geneva', region: 'Switzerland', tz: 'Europe/Zurich' }, VIE: { city: 'Vienna', region: 'Austria', tz: 'Europe/Vienna' },
  PRG: { city: 'Prague', region: 'Czech Republic', tz: 'Europe/Prague' }, BUD: { city: 'Budapest', region: 'Hungary', tz: 'Europe/Budapest' },
  WAW: { city: 'Warsaw', region: 'Poland', tz: 'Europe/Warsaw' }, CPH: { city: 'Copenhagen', region: 'Denmark', tz: 'Europe/Copenhagen' },
  ARN: { city: 'Stockholm', region: 'Sweden', tz: 'Europe/Stockholm' }, OSL: { city: 'Oslo', region: 'Norway', tz: 'Europe/Oslo' },
  HEL: { city: 'Helsinki', region: 'Finland', tz: 'Europe/Helsinki' }, KEF: { city: 'Reykjavik', region: 'Iceland', tz: 'Atlantic/Reykjavik' },
  BRU: { city: 'Brussels', region: 'Belgium', tz: 'Europe/Brussels' }, LGW: { city: 'London', region: 'United Kingdom', tz: 'Europe/London' },
  STN: { city: 'London', region: 'United Kingdom', tz: 'Europe/London' }, EDI: { city: 'Edinburgh', region: 'United Kingdom', tz: 'Europe/London' },
  MAN: { city: 'Manchester', region: 'United Kingdom', tz: 'Europe/London' }, DUS: { city: 'Düsseldorf', region: 'Germany', tz: 'Europe/Berlin' },
  HAM: { city: 'Hamburg', region: 'Germany', tz: 'Europe/Berlin' }, ATH: { city: 'Athens', region: 'Greece', tz: 'Europe/Athens' },
  IST: { city: 'Istanbul', region: 'Turkey', tz: 'Europe/Istanbul' }, DXB: { city: 'Dubai', region: 'United Arab Emirates', tz: 'Asia/Dubai' },
  AUH: { city: 'Abu Dhabi', region: 'United Arab Emirates', tz: 'Asia/Dubai' }, DOH: { city: 'Doha', region: 'Qatar', tz: 'Asia/Qatar' },
  TLV: { city: 'Tel Aviv', region: 'Israel', tz: 'Asia/Jerusalem' }, CAI: { city: 'Cairo', region: 'Egypt', tz: 'Africa/Cairo' },
  RAK: { city: 'Marrakesh', region: 'Morocco', tz: 'Africa/Casablanca' }, CMN: { city: 'Casablanca', region: 'Morocco', tz: 'Africa/Casablanca' },
  JNB: { city: 'Johannesburg', region: 'South Africa', tz: 'Africa/Johannesburg' }, CPT: { city: 'Cape Town', region: 'South Africa', tz: 'Africa/Johannesburg' },
  NBO: { city: 'Nairobi', region: 'Kenya', tz: 'Africa/Nairobi' }, LOS: { city: 'Lagos', region: 'Nigeria', tz: 'Africa/Lagos' },
  ACC: { city: 'Accra', region: 'Ghana', tz: 'Africa/Accra' }, KGL: { city: 'Kigali', region: 'Rwanda', tz: 'Africa/Kigali' },
  ADD: { city: 'Addis Ababa', region: 'Ethiopia', tz: 'Africa/Addis_Ababa' }, DEL: { city: 'Delhi', region: 'India', tz: 'Asia/Kolkata' },
  BOM: { city: 'Mumbai', region: 'India', tz: 'Asia/Kolkata' }, BLR: { city: 'Bengaluru', region: 'India', tz: 'Asia/Kolkata' },
  BKK: { city: 'Bangkok', region: 'Thailand', tz: 'Asia/Bangkok' }, SGN: { city: 'Ho Chi Minh City', region: 'Vietnam', tz: 'Asia/Ho_Chi_Minh' },
  HAN: { city: 'Hanoi', region: 'Vietnam', tz: 'Asia/Bangkok' }, KUL: { city: 'Kuala Lumpur', region: 'Malaysia', tz: 'Asia/Kuala_Lumpur' },
  CGK: { city: 'Jakarta', region: 'Indonesia', tz: 'Asia/Jakarta' }, DPS: { city: 'Bali', region: 'Indonesia', tz: 'Asia/Makassar' },
  HKG: { city: 'Hong Kong', region: 'Hong Kong', tz: 'Asia/Hong_Kong' }, TPE: { city: 'Taipei', region: 'Taiwan', tz: 'Asia/Taipei' },
  PEK: { city: 'Beijing', region: 'China', tz: 'Asia/Shanghai' }, PVG: { city: 'Shanghai', region: 'China', tz: 'Asia/Shanghai' },
  KIX: { city: 'Osaka', region: 'Japan', tz: 'Asia/Tokyo' }, MEL: { city: 'Melbourne', region: 'Australia', tz: 'Australia/Melbourne' },
  BNE: { city: 'Brisbane', region: 'Australia', tz: 'Australia/Brisbane' }, AKL: { city: 'Auckland', region: 'New Zealand', tz: 'Pacific/Auckland' },
  GRU: { city: 'São Paulo', region: 'Brazil', tz: 'America/Sao_Paulo' }, GIG: { city: 'Rio de Janeiro', region: 'Brazil', tz: 'America/Sao_Paulo' },
  EZE: { city: 'Buenos Aires', region: 'Argentina', tz: 'America/Argentina/Buenos_Aires' }, SCL: { city: 'Santiago', region: 'Chile', tz: 'America/Santiago' },
  LIM: { city: 'Lima', region: 'Peru', tz: 'America/Lima' }, BOG: { city: 'Bogotá', region: 'Colombia', tz: 'America/Bogota' },
  MDE: { city: 'Medellín', region: 'Colombia', tz: 'America/Bogota' }, PTY: { city: 'Panama City', region: 'Panama', tz: 'America/Panama' },
  SJO: { city: 'San José', region: 'Costa Rica', tz: 'America/Costa_Rica' },
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

// Every country and inhabited territory: ISO code | display name | representative time zone.
// Countries spanning several zones use the capital's (or the most-visited region's); see CITY_TZ.
const COUNTRY_TABLE = `
AD|Andorra|Europe/Andorra AE|United Arab Emirates|Asia/Dubai AF|Afghanistan|Asia/Kabul AG|Antigua and Barbuda|America/Antigua
AI|Anguilla|America/Anguilla AL|Albania|Europe/Tirane AM|Armenia|Asia/Yerevan AO|Angola|Africa/Luanda
AQ|Antarctica|Antarctica/McMurdo AR|Argentina|America/Argentina/Buenos_Aires AS|American Samoa|Pacific/Pago_Pago
AT|Austria|Europe/Vienna AU|Australia|Australia/Sydney AW|Aruba|America/Aruba AX|Åland Islands|Europe/Mariehamn
AZ|Azerbaijan|Asia/Baku BA|Bosnia and Herzegovina|Europe/Sarajevo BB|Barbados|America/Barbados BD|Bangladesh|Asia/Dhaka
BE|Belgium|Europe/Brussels BF|Burkina Faso|Africa/Ouagadougou BG|Bulgaria|Europe/Sofia BH|Bahrain|Asia/Bahrain
BI|Burundi|Africa/Bujumbura BJ|Benin|Africa/Porto-Novo BL|Saint Barthélemy|America/St_Barthelemy BM|Bermuda|Atlantic/Bermuda
BN|Brunei|Asia/Brunei BO|Bolivia|America/La_Paz BQ|Caribbean Netherlands|America/Kralendijk BR|Brazil|America/Sao_Paulo
BS|Bahamas|America/Nassau BT|Bhutan|Asia/Thimphu BW|Botswana|Africa/Gaborone BY|Belarus|Europe/Minsk BZ|Belize|America/Belize
CA|Canada|America/Toronto CC|Cocos Islands|Indian/Cocos CD|Democratic Republic of the Congo|Africa/Kinshasa
CF|Central African Republic|Africa/Bangui CG|Republic of the Congo|Africa/Brazzaville CH|Switzerland|Europe/Zurich
CI|Côte d'Ivoire|Africa/Abidjan CK|Cook Islands|Pacific/Rarotonga CL|Chile|America/Santiago CM|Cameroon|Africa/Douala
CN|China|Asia/Shanghai CO|Colombia|America/Bogota CR|Costa Rica|America/Costa_Rica CU|Cuba|America/Havana
CV|Cape Verde|Atlantic/Cape_Verde CW|Curaçao|America/Curacao CX|Christmas Island|Indian/Christmas CY|Cyprus|Asia/Nicosia
CZ|Czech Republic|Europe/Prague DE|Germany|Europe/Berlin DJ|Djibouti|Africa/Djibouti DK|Denmark|Europe/Copenhagen
DM|Dominica|America/Dominica DO|Dominican Republic|America/Santo_Domingo DZ|Algeria|Africa/Algiers EC|Ecuador|America/Guayaquil
EE|Estonia|Europe/Tallinn EG|Egypt|Africa/Cairo EH|Western Sahara|Africa/El_Aaiun ER|Eritrea|Africa/Asmara ES|Spain|Europe/Madrid
ET|Ethiopia|Africa/Addis_Ababa FI|Finland|Europe/Helsinki FJ|Fiji|Pacific/Fiji FK|Falkland Islands|Atlantic/Stanley
FM|Micronesia|Pacific/Pohnpei FO|Faroe Islands|Atlantic/Faroe FR|France|Europe/Paris GA|Gabon|Africa/Libreville
GB|United Kingdom|Europe/London GD|Grenada|America/Grenada GE|Georgia|Asia/Tbilisi GF|French Guiana|America/Cayenne
GG|Guernsey|Europe/Guernsey GH|Ghana|Africa/Accra GI|Gibraltar|Europe/Gibraltar GL|Greenland|America/Nuuk GM|Gambia|Africa/Banjul
GN|Guinea|Africa/Conakry GP|Guadeloupe|America/Guadeloupe GQ|Equatorial Guinea|Africa/Malabo GR|Greece|Europe/Athens
GS|South Georgia|Atlantic/South_Georgia GT|Guatemala|America/Guatemala GU|Guam|Pacific/Guam GW|Guinea-Bissau|Africa/Bissau
GY|Guyana|America/Guyana HK|Hong Kong|Asia/Hong_Kong HN|Honduras|America/Tegucigalpa HR|Croatia|Europe/Zagreb
HT|Haiti|America/Port-au-Prince HU|Hungary|Europe/Budapest ID|Indonesia|Asia/Jakarta IE|Ireland|Europe/Dublin IL|Israel|Asia/Jerusalem
IM|Isle of Man|Europe/Isle_of_Man IN|India|Asia/Kolkata IO|British Indian Ocean Territory|Indian/Chagos IQ|Iraq|Asia/Baghdad
IR|Iran|Asia/Tehran IS|Iceland|Atlantic/Reykjavik IT|Italy|Europe/Rome JE|Jersey|Europe/Jersey JM|Jamaica|America/Jamaica
JO|Jordan|Asia/Amman JP|Japan|Asia/Tokyo KE|Kenya|Africa/Nairobi KG|Kyrgyzstan|Asia/Bishkek KH|Cambodia|Asia/Phnom_Penh
KI|Kiribati|Pacific/Tarawa KM|Comoros|Indian/Comoro KN|Saint Kitts and Nevis|America/St_Kitts KP|North Korea|Asia/Pyongyang
KR|South Korea|Asia/Seoul KW|Kuwait|Asia/Kuwait KY|Cayman Islands|America/Cayman KZ|Kazakhstan|Asia/Almaty LA|Laos|Asia/Vientiane
LB|Lebanon|Asia/Beirut LC|Saint Lucia|America/St_Lucia LI|Liechtenstein|Europe/Vaduz LK|Sri Lanka|Asia/Colombo
LR|Liberia|Africa/Monrovia LS|Lesotho|Africa/Maseru LT|Lithuania|Europe/Vilnius LU|Luxembourg|Europe/Luxembourg LV|Latvia|Europe/Riga
LY|Libya|Africa/Tripoli MA|Morocco|Africa/Casablanca MC|Monaco|Europe/Monaco MD|Moldova|Europe/Chisinau ME|Montenegro|Europe/Podgorica
MF|Saint Martin|America/Marigot MG|Madagascar|Indian/Antananarivo MH|Marshall Islands|Pacific/Majuro MK|North Macedonia|Europe/Skopje
ML|Mali|Africa/Bamako MM|Myanmar|Asia/Yangon MN|Mongolia|Asia/Ulaanbaatar MO|Macau|Asia/Macau MP|Northern Mariana Islands|Pacific/Saipan
MQ|Martinique|America/Martinique MR|Mauritania|Africa/Nouakchott MS|Montserrat|America/Montserrat MT|Malta|Europe/Malta
MU|Mauritius|Indian/Mauritius MV|Maldives|Indian/Maldives MW|Malawi|Africa/Blantyre MX|Mexico|America/Mexico_City
MY|Malaysia|Asia/Kuala_Lumpur MZ|Mozambique|Africa/Maputo NA|Namibia|Africa/Windhoek NC|New Caledonia|Pacific/Noumea
NE|Niger|Africa/Niamey NF|Norfolk Island|Pacific/Norfolk NG|Nigeria|Africa/Lagos NI|Nicaragua|America/Managua
NL|Netherlands|Europe/Amsterdam NO|Norway|Europe/Oslo NP|Nepal|Asia/Kathmandu NR|Nauru|Pacific/Nauru NU|Niue|Pacific/Niue
NZ|New Zealand|Pacific/Auckland OM|Oman|Asia/Muscat PA|Panama|America/Panama PE|Peru|America/Lima PF|French Polynesia|Pacific/Tahiti
PG|Papua New Guinea|Pacific/Port_Moresby PH|Philippines|Asia/Manila PK|Pakistan|Asia/Karachi PL|Poland|Europe/Warsaw
PM|Saint Pierre and Miquelon|America/Miquelon PN|Pitcairn Islands|Pacific/Pitcairn PR|Puerto Rico|America/Puerto_Rico
PS|Palestine|Asia/Hebron PT|Portugal|Europe/Lisbon PW|Palau|Pacific/Palau PY|Paraguay|America/Asuncion QA|Qatar|Asia/Qatar
RE|Réunion|Indian/Reunion RO|Romania|Europe/Bucharest RS|Serbia|Europe/Belgrade RU|Russia|Europe/Moscow RW|Rwanda|Africa/Kigali
SA|Saudi Arabia|Asia/Riyadh SB|Solomon Islands|Pacific/Guadalcanal SC|Seychelles|Indian/Mahe SD|Sudan|Africa/Khartoum
SE|Sweden|Europe/Stockholm SG|Singapore|Asia/Singapore SH|Saint Helena|Atlantic/St_Helena SI|Slovenia|Europe/Ljubljana
SJ|Svalbard|Arctic/Longyearbyen SK|Slovakia|Europe/Bratislava SL|Sierra Leone|Africa/Freetown SM|San Marino|Europe/San_Marino
SN|Senegal|Africa/Dakar SO|Somalia|Africa/Mogadishu SR|Suriname|America/Paramaribo SS|South Sudan|Africa/Juba
ST|São Tomé and Príncipe|Africa/Sao_Tome SV|El Salvador|America/El_Salvador SX|Sint Maarten|America/Lower_Princes
SY|Syria|Asia/Damascus SZ|Eswatini|Africa/Mbabane TC|Turks and Caicos Islands|America/Grand_Turk TD|Chad|Africa/Ndjamena
TG|Togo|Africa/Lome TH|Thailand|Asia/Bangkok TJ|Tajikistan|Asia/Dushanbe TK|Tokelau|Pacific/Fakaofo TL|Timor-Leste|Asia/Dili
TM|Turkmenistan|Asia/Ashgabat TN|Tunisia|Africa/Tunis TO|Tonga|Pacific/Tongatapu TR|Turkey|Europe/Istanbul
TT|Trinidad and Tobago|America/Port_of_Spain TV|Tuvalu|Pacific/Funafuti TW|Taiwan|Asia/Taipei TZ|Tanzania|Africa/Dar_es_Salaam
UA|Ukraine|Europe/Kiev UG|Uganda|Africa/Kampala UM|U.S. Minor Outlying Islands|Pacific/Wake US|United States|America/New_York
UY|Uruguay|America/Montevideo UZ|Uzbekistan|Asia/Tashkent VA|Vatican City|Europe/Vatican VC|Saint Vincent and the Grenadines|America/St_Vincent
VE|Venezuela|America/Caracas VG|British Virgin Islands|America/Tortola VI|U.S. Virgin Islands|America/St_Thomas VN|Vietnam|Asia/Ho_Chi_Minh
VU|Vanuatu|Pacific/Efate WF|Wallis and Futuna|Pacific/Wallis WS|Samoa|Pacific/Apia XK|Kosovo|Europe/Belgrade YE|Yemen|Asia/Aden
YT|Mayotte|Indian/Mayotte ZA|South Africa|Africa/Johannesburg ZM|Zambia|Africa/Lusaka ZW|Zimbabwe|Africa/Harare`;

// ISO country code -> [display name, time zone]
const COUNTRIES = {};
for (const row of COUNTRY_TABLE.trim().split(/\s+(?=[A-Z]{2}\|)/)) {
  const [code, name, tz] = row.split('|');
  COUNTRIES[code] = [name, tz];
}

// Other names people (and hotel addresses) use for a country.
const COUNTRY_ALIASES = {
  usa: 'US', 'united states of america': 'US', america: 'US', uk: 'GB', 'great britain': 'GB', britain: 'GB',
  england: 'GB', scotland: 'GB', wales: 'GB', 'northern ireland': 'GB', czechia: 'CZ', turkiye: 'TR',
  korea: 'KR', 'republic of korea': 'KR', holland: 'NL', uae: 'AE', emirates: 'AE', 'ivory coast': 'CI',
  'cabo verde': 'CV', 'east timor': 'TL', burma: 'MM', macedonia: 'MK', swaziland: 'SZ', drc: 'CD',
  'dr congo': 'CD', 'congo-kinshasa': 'CD', congo: 'CG', 'congo-brazzaville': 'CG', vatican: 'VA', 'holy see': 'VA',
  'russian federation': 'RU', 'viet nam': 'VN', 'lao pdr': 'LA', 'st lucia': 'LC', 'st kitts and nevis': 'KN',
  'st vincent and the grenadines': 'VC', 'st barts': 'BL', 'st barths': 'BL', 'st martin': 'MF', 'st maarten': 'SX',
  bosnia: 'BA', trinidad: 'TT', tobago: 'TT', 'cayman': 'KY', 'turks and caicos': 'TC', bvi: 'VG', usvi: 'VI',
  tahiti: 'PF', bonaire: 'BQ', 'sao tome': 'ST', 'falklands': 'FK', 'faroes': 'FO', 'mainland china': 'CN', prc: 'CN',
};

// US state names -> postal codes ("Boise, Idaho" means ID).
const US_STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', 'washington dc': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI',
  idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME',
  maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
// "Georgia" is a US state unless the city is in the country.
const GEORGIA_COUNTRY_CITIES = ['tbilisi', 'batumi', 'kutaisi', 'gudauri', 'kazbegi', 'stepantsminda', 'mestia', 'sighnaghi', 'telavi'];

// Cities whose time zone differs from their country's representative one.
const CITY_TZ = {
  vancouver: 'America/Vancouver', victoria: 'America/Vancouver', whistler: 'America/Vancouver', calgary: 'America/Edmonton',
  edmonton: 'America/Edmonton', banff: 'America/Edmonton', winnipeg: 'America/Winnipeg', regina: 'America/Regina',
  halifax: 'America/Halifax', "st. john's": 'America/St_Johns', perth: 'Australia/Perth', adelaide: 'Australia/Adelaide',
  darwin: 'Australia/Darwin', brisbane: 'Australia/Brisbane', cairns: 'Australia/Brisbane', 'gold coast': 'Australia/Brisbane',
  melbourne: 'Australia/Melbourne', hobart: 'Australia/Hobart', cancun: 'America/Cancun', 'playa del carmen': 'America/Cancun',
  tulum: 'America/Cancun', tijuana: 'America/Tijuana', 'los cabos': 'America/Mazatlan', 'cabo san lucas': 'America/Mazatlan',
  'san jose del cabo': 'America/Mazatlan', 'la paz': 'America/Mazatlan', manaus: 'America/Manaus', bali: 'Asia/Makassar',
  denpasar: 'Asia/Makassar', ubud: 'Asia/Makassar', lombok: 'Asia/Makassar', vladivostok: 'Asia/Vladivostok',
  yekaterinburg: 'Asia/Yekaterinburg', novosibirsk: 'Asia/Novosibirsk', tenerife: 'Atlantic/Canary', 'las palmas': 'Atlantic/Canary',
  'gran canaria': 'Atlantic/Canary', lanzarote: 'Atlantic/Canary', funchal: 'Atlantic/Madeira', madeira: 'Atlantic/Madeira',
  'ponta delgada': 'Atlantic/Azores', azores: 'Atlantic/Azores', galapagos: 'Pacific/Galapagos', 'easter island': 'Pacific/Easter',
  'el paso': DEN, pensacola: CHI, 'sioux falls': CHI, 'rapid city': DEN, boise: 'America/Boise', 'coeur d\'alene': LA,
  almaty: 'Asia/Almaty', astana: 'Asia/Almaty', nuuk: 'America/Nuuk', 'santa cruz de la sierra': 'America/La_Paz',
};

/** Lowercase, no accents or periods, no leading "the": "Côte d'Ivoire" -> "cote d'ivoire". */
function normalizeName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\./g, '').replace(/^the\s+/, '').replace(/\s+/g, ' ').trim();
}

const COUNTRY_BY_NAME = {};
for (const code of Object.keys(COUNTRIES)) COUNTRY_BY_NAME[normalizeName(COUNTRIES[code][0])] = code;
for (const alias of Object.keys(COUNTRY_ALIASES)) COUNTRY_BY_NAME[normalizeName(alias)] = COUNTRY_ALIASES[alias];


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

/** [display name, time zone] for a country name or alias, or null. */
function countryByName(name) {
  const code = COUNTRY_BY_NAME[normalizeName(name)];
  return code ? COUNTRIES[code] : null;
}

/** The time zone for a city: its own if it differs from its country's, else the given fallback. */
const cityTz = (city, fallback) => CITY_TZ[normalizeName(city)] || fallback || null;

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
    const city = titleCaseIfShouting(parts[parts.length - 2]);
    return { city, region, tz: cityTz(city, US_STATE_TZ[region]) };
  }

  const country = COUNTRIES[lastUp] || countryByName(last);
  // Drop postcode-ish tokens: "10117 Berlin" -> "Berlin", "London SW1A 1AA" -> "London"
  const city = (parts[parts.length - 1] || '').split(/\s+/).filter((t) => !/\d/.test(t)).join(' ');
  const cityName = titleCaseIfShouting(city) || null;
  return { city: cityName, region: country ? country[0] : titleCaseIfShouting(last), tz: cityTz(cityName, country && country[1]) };
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
  let region = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  let tz = null;
  const state = US_STATE_TZ[region.toUpperCase()] && region.length === 2 ? region.toUpperCase() : US_STATE_NAMES[normalizeName(region)];
  const georgiaCountry = normalizeName(region) === 'georgia' && GEORGIA_COUNTRY_CITIES.includes(normalizeName(city));
  if (state && !georgiaCountry) {
    region = state; // "ID" or "Idaho" -> "ID"
    tz = US_STATE_TZ[state];
  } else if (countryByName(region)) {
    tz = countryByName(region)[1]; // keeps the name as typed: "Scotland", "Czechia"
  } else if (parts.length === 1) {
    // "📍 Chicago": a bare city. Borrow state/country and time zone from a known airport city.
    city = parts[0];
    const known = Object.values(AIRPORTS).find((x) => normalizeName(x.city) === normalizeName(city));
    region = known ? known.region : '';
    tz = known ? known.tz : null;
  }
  return { place: { city, region, tz: cityTz(city, tz) }, tags };
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

/** Is an airport close enough to a place that landing there means arriving at it? (Same time zone.) */
function isNear(airportPlace, place) {
  if (!place || !airportPlace) return true;
  if (airportPlace.tz && place.tz) return airportPlace.tz === place.tz;
  return !!place.region && airportPlace.region === place.region;
}

/**
 * A stay/marker says where Lange is over whole days; flights say exactly when he moves.
 * Start at the first journey that lands inside the span near the place (a flight landing somewhere
 * else, like Newark→Sacramento during a Melville stay, doesn't count); end at the first journey that
 * leaves, from anywhere.
 */
function clipToFlights(start, end, flights, place) {
  const arrival = flights.find((f) => !f.connectsTo && f.arr >= start && f.arr < end && isNear(f.toPlace, place));
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
    const [cs, ce] = clipToFlights(s, e, flights, marker ? marker.place : stay);
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

/** Metros a trip touches: by airport, or by city name within the metro's states (if it lists them). */
function matchMetros(places, config) {
  return Object.keys(config.metros || {}).filter((id) => {
    const m = config.metros[id];
    const cities = (m.cities || []).map(normalizeName);
    return places.some((p) => (p.airport && (m.airports || []).includes(p.airport))
      || (p.city && cities.includes(normalizeName(p.city)) && (!m.regions || m.regions.includes(p.region))));
  });
}

/** Trip rows: one per US state; everywhere abroad together ("Hungary, Germany & Morocco"). */
const legKey = (p) => (p && US_STATE_TZ[p.region] ? `US:${p.region}` : 'abroad');

/**
 * runs: continuous time away from home (for "home on" and "where is he now").
 * rows: the "Coming up" list. Each run is split where the leg changes, so Melville, NY and a next-day
 * Sacramento, CA are separate rows. In the air belongs to wherever the flight is going. A changeover
 * day (left Morocco, arrived in New York) shows on both rows.
 */
function groupTrips(timeline, config) {
  const homeTz = config.home.tz;
  const runs = [];
  for (const iv of timeline.intervals) {
    if (iv.place && isHomePlace(iv.place, config)) continue;
    const r = runs[runs.length - 1];
    if (r && r.endMs === iv.start) {
      r.endMs = iv.end;
      r.intervals.push(iv);
    } else {
      runs.push({ startMs: iv.start, endMs: iv.end, intervals: [iv] });
    }
  }

  const rows = [];
  for (const run of runs) {
    const ivs = run.intervals;
    ivs.forEach((iv, i) => {
      const anchor = iv.place || (ivs.slice(i + 1).find((x) => x.place) || ivs.slice(0, i).reverse().find((x) => x.place) || {}).place;
      const key = legKey(anchor);
      const row = rows[rows.length - 1];
      if (row && row.run === run && row.key === key) {
        row.endMs = iv.end;
        row.intervals.push(iv);
      } else {
        rows.push({ run, key, startMs: iv.start, endMs: iv.end, intervals: [iv] });
      }
    });
  }

  const summarize = (g, end) => {
    const places = g.intervals.filter((iv) => iv.place).map((iv) => iv.place);
    const personal = timeline.personal.some(([s, e]) => s < g.endMs && e > g.startMs);
    return {
      startMs: g.startMs,
      endMs: g.endMs,
      start: localDate(g.startMs, homeTz),
      end,
      place: tripPlaceLabel(places),
      work: !personal && g.intervals.some((iv) => iv.work),
      metros: matchMetros(places, config),
    };
  };
  return {
    runs: runs.map((r) => summarize(r, localDate(r.endMs - 1, homeTz))),
    rows: rows.map((r, i) => {
      const next = rows[i + 1];
      const end = next && next.run === r.run ? localDate(next.startMs, homeTz) : localDate(r.endMs - 1, homeTz);
      return summarize(r, end);
    }),
  };
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
  const { runs, rows: trips } = groupTrips(timeline, config);
  const today = localDate(now, homeTz);
  const intervalAt = (t) => timeline.intervals.findIndex((x) => x.start <= t && t < x.end);

  // Where is he right now? In the air counts as the place he just left.
  const i = intervalAt(now);
  let here = i >= 0 ? timeline.intervals[i].place : null;
  if (i >= 0 && !here && i > 0 && timeline.intervals[i - 1].end === timeline.intervals[i].start) here = timeline.intervals[i - 1].place;
  if (!here || isHomePlace(here, config)) here = homePlace(config);

  const currentTrip = trips.find((t) => t.startMs <= now && now < t.endMs);
  const currentRun = runs.find((r) => r.startMs <= now && now < r.endMs);
  // tz is null when we can't tell (an unrecognized place): the page then leaves out the local time.
  const todayOut = { city: here.city || '', region: here.region || '', tz: here.tz || null, work: !!(currentTrip && currentTrip.work) };

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
  const homeTrip = currentRun || runs.find((r) => r.start === today && r.startMs > now);
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
