// Reference tables the rules use: countries, EU membership, Russia indicators, HS codes,
// grading report formats, KP participants, and plain normalizers for shape, colour and clarity.
// Everything here is a table or a small lookup so the rules stay explainable.
import { EU_MEMBER_STATES } from '../types.js';

// ---------- countries ----------

// [ISO2, ISO3, name, ...other ways papers print it]. Covers the EU, the diamond hubs, the mining
// countries and the usual trade partners. Unknown names return null and are shown as printed.
const COUNTRY_ROWS = [
  ['AE', 'ARE', 'United Arab Emirates', 'UAE', 'EMIRATES', 'UNITED ARAB EMIRATE'],
  ['AM', 'ARM', 'Armenia'],
  ['AO', 'AGO', 'Angola'],
  ['AR', 'ARG', 'Argentina'],
  ['AT', 'AUT', 'Austria', 'OSTERREICH', 'OESTERREICH'],
  ['AU', 'AUS', 'Australia'],
  ['BD', 'BGD', 'Bangladesh'],
  ['BE', 'BEL', 'Belgium', 'BELGIQUE', 'BELGIE', 'BELGIEN', 'BELGIO'],
  ['BG', 'BGR', 'Bulgaria'],
  ['BH', 'BHR', 'Bahrain'],
  ['BR', 'BRA', 'Brazil', 'BRASIL'],
  ['BW', 'BWA', 'Botswana'],
  ['BY', 'BLR', 'Belarus'],
  ['CA', 'CAN', 'Canada'],
  ['CD', 'COD', 'Democratic Republic of the Congo', 'DRC', 'DR CONGO', 'CONGO DR', 'CONGO DRC', 'CONGO KINSHASA',
    'DEMOCRATIC REPUBLIC OF CONGO', 'CONGO DEMOCRATIC REPUBLIC OF THE', 'CONGO DEMOCRATIC REPUBLIC', 'ZAIRE'],
  ['CF', 'CAF', 'Central African Republic', 'CAR'],
  ['CG', 'COG', 'Republic of the Congo', 'CONGO', 'CONGO BRAZZAVILLE', 'REPUBLIC OF CONGO'],
  ['CH', 'CHE', 'Switzerland', 'SUISSE', 'SCHWEIZ', 'SVIZZERA'],
  ['CI', 'CIV', "Cote d'Ivoire", 'COTE D IVOIRE', 'COTE DIVOIRE', 'IVORY COAST'],
  ['CM', 'CMR', 'Cameroon'],
  ['CN', 'CHN', 'China', 'PRC', 'PEOPLES REPUBLIC OF CHINA', 'P R CHINA'],
  ['CY', 'CYP', 'Cyprus'],
  ['CZ', 'CZE', 'Czechia', 'CZECH REPUBLIC'],
  ['DE', 'DEU', 'Germany', 'DEUTSCHLAND'],
  ['DK', 'DNK', 'Denmark'],
  ['EE', 'EST', 'Estonia'],
  ['EG', 'EGY', 'Egypt'],
  ['ES', 'ESP', 'Spain', 'ESPANA'],
  ['FI', 'FIN', 'Finland'],
  ['FR', 'FRA', 'France'],
  ['GA', 'GAB', 'Gabon'],
  ['GB', 'GBR', 'United Kingdom', 'UK', 'GREAT BRITAIN', 'BRITAIN', 'ENGLAND', 'SCOTLAND', 'WALES', 'NORTHERN IRELAND'],
  ['GH', 'GHA', 'Ghana'],
  ['GN', 'GIN', 'Guinea'],
  ['GR', 'GRC', 'Greece', 'HELLAS'],
  ['GY', 'GUY', 'Guyana'],
  ['HK', 'HKG', 'Hong Kong', 'HONGKONG', 'HONG KONG SAR', 'HK SAR'],
  ['HR', 'HRV', 'Croatia', 'HRVATSKA'],
  ['HU', 'HUN', 'Hungary'],
  ['ID', 'IDN', 'Indonesia'],
  ['IE', 'IRL', 'Ireland', 'EIRE'],
  ['IL', 'ISR', 'Israel'],
  ['IN', 'IND', 'India', 'BHARAT'],
  ['IT', 'ITA', 'Italy', 'ITALIA'],
  ['JP', 'JPN', 'Japan'],
  ['KG', 'KGZ', 'Kyrgyzstan'],
  ['KH', 'KHM', 'Cambodia'],
  ['KR', 'KOR', 'South Korea', 'KOREA', 'REPUBLIC OF KOREA', 'KOREA REPUBLIC OF', 'KOREA SOUTH'],
  ['KZ', 'KAZ', 'Kazakhstan'],
  ['LA', 'LAO', 'Laos'],
  ['LB', 'LBN', 'Lebanon'],
  ['LK', 'LKA', 'Sri Lanka'],
  ['LR', 'LBR', 'Liberia'],
  ['LS', 'LSO', 'Lesotho'],
  ['LT', 'LTU', 'Lithuania'],
  ['LU', 'LUX', 'Luxembourg'],
  ['LV', 'LVA', 'Latvia'],
  ['MG', 'MDG', 'Madagascar'],
  ['ML', 'MLI', 'Mali'],
  ['MT', 'MLT', 'Malta'],
  ['MU', 'MUS', 'Mauritius'],
  ['MX', 'MEX', 'Mexico'],
  ['MY', 'MYS', 'Malaysia'],
  ['MZ', 'MOZ', 'Mozambique'],
  ['NA', 'NAM', 'Namibia'],
  ['NG', 'NGA', 'Nigeria'],
  ['NL', 'NLD', 'Netherlands', 'THE NETHERLANDS', 'HOLLAND', 'NEDERLAND'],
  ['NO', 'NOR', 'Norway'],
  ['NZ', 'NZL', 'New Zealand'],
  ['OM', 'OMN', 'Oman'],
  ['PA', 'PAN', 'Panama'],
  ['PH', 'PHL', 'Philippines'],
  ['PK', 'PAK', 'Pakistan'],
  ['PL', 'POL', 'Poland', 'POLSKA'],
  ['PT', 'PRT', 'Portugal'],
  ['QA', 'QAT', 'Qatar'],
  ['RO', 'ROU', 'Romania'],
  ['RS', 'SRB', 'Serbia'],
  ['RU', 'RUS', 'Russia', 'RUSSIAN FEDERATION', 'ROSSIYA'],
  ['SA', 'SAU', 'Saudi Arabia', 'KSA'],
  ['SE', 'SWE', 'Sweden', 'SVERIGE'],
  ['SG', 'SGP', 'Singapore'],
  ['SI', 'SVN', 'Slovenia'],
  ['SK', 'SVK', 'Slovakia', 'SLOVAK REPUBLIC'],
  ['SL', 'SLE', 'Sierra Leone'],
  ['SZ', 'SWZ', 'Eswatini', 'SWAZILAND'],
  ['TG', 'TGO', 'Togo'],
  ['TH', 'THA', 'Thailand'],
  ['TR', 'TUR', 'Turkiye', 'TURKEY'],
  ['TW', 'TWN', 'Taiwan', 'CHINESE TAIPEI'],
  ['TZ', 'TZA', 'Tanzania', 'UNITED REPUBLIC OF TANZANIA'],
  ['UA', 'UKR', 'Ukraine'],
  ['US', 'USA', 'United States', 'UNITED STATES OF AMERICA', 'AMERICA', 'U S A', 'U S'],
  ['VE', 'VEN', 'Venezuela'],
  ['VN', 'VNM', 'Vietnam', 'VIET NAM'],
  ['ZA', 'ZAF', 'South Africa', 'RSA', 'REPUBLIC OF SOUTH AFRICA'],
  ['ZM', 'ZMB', 'Zambia'],
  ['ZW', 'ZWE', 'Zimbabwe'],
  // Not a country, but KP certificates issued in Antwerp name the EU as the exporting participant.
  ['EU', 'EUR', 'European Union', 'EUROPEAN COMMUNITY'],
];

// Diamond hubs and big trade cities, so "Antwerp" or "Surat" on an address still gives a country.
export const HUB_CITIES = {
  ANTWERP: 'BE', ANTWERPEN: 'BE', ANVERS: 'BE', BRUSSELS: 'BE',
  SURAT: 'IN', MUMBAI: 'IN', BOMBAY: 'IN', JAIPUR: 'IN', 'NEW DELHI': 'IN', DELHI: 'IN', AHMEDABAD: 'IN',
  DUBAI: 'AE', 'ABU DHABI': 'AE', SHARJAH: 'AE',
  'RAMAT GAN': 'IL', 'TEL AVIV': 'IL',
  'HONG KONG': 'HK', KOWLOON: 'HK',
  'NEW YORK': 'US', 'LOS ANGELES': 'US', MIAMI: 'US', CHICAGO: 'US',
  GABORONE: 'BW', BANGKOK: 'TH', LONDON: 'GB', GENEVA: 'CH', ZURICH: 'CH', SINGAPORE: 'SG', TOKYO: 'JP',
  SHANGHAI: 'CN', SHENZHEN: 'CN', JOHANNESBURG: 'ZA', WINDHOEK: 'NA', KINSHASA: 'CD', LUANDA: 'AO',
  FREETOWN: 'SL', HARARE: 'ZW', YEREVAN: 'AM', MOSCOW: 'RU',
};

// Airport codes seen on air waybill routes ("BOM-DXB-BRU").
export const AIRPORTS = {
  BOM: 'IN', DEL: 'IN', STV: 'IN', JAI: 'IN', AMD: 'IN', MAA: 'IN', BLR: 'IN', CCU: 'IN', HYD: 'IN',
  BRU: 'BE', ANR: 'BE', LGG: 'BE', AMS: 'NL', FRA: 'DE', CDG: 'FR', LHR: 'GB', ZRH: 'CH', GVA: 'CH',
  DXB: 'AE', DWC: 'AE', AUH: 'AE', SHJ: 'AE', TLV: 'IL', HKG: 'HK', JFK: 'US', EWR: 'US', LAX: 'US',
  ORD: 'US', MIA: 'US', BKK: 'TH', SIN: 'SG', NRT: 'JP', HND: 'JP', PVG: 'CN', PEK: 'CN', GBE: 'BW',
  JNB: 'ZA', IST: 'TR', DOH: 'QA', SVO: 'RU', DME: 'RU', VKO: 'RU',
};

const BY_ISO2 = {};
const BY_WORDS = new Map(); // normalized name or alias -> ISO2
for (const [iso2, iso3, name, ...aliases] of COUNTRY_ROWS) {
  BY_ISO2[iso2] = { iso2, iso3, name };
  for (const word of [name, ...aliases]) BY_WORDS.set(cleanWords(word), iso2);
}
const BY_ISO3 = Object.fromEntries(COUNTRY_ROWS.map(([iso2, iso3]) => [iso3, iso2]));

function cleanWords(text) {
  return String(text)
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // Belgique, Côte, España
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

// Search table for country names and cities inside longer text such as addresses, longest first.
const SEARCH_WORDS = [...BY_WORDS.entries(), ...Object.entries(HUB_CITIES)]
  .filter(([word]) => word.length >= 4 || word === 'UAE' || word === 'USA' || word === 'DRC')
  .sort((a, b) => b[0].length - a[0].length);

/**
 * Turn whatever a paper prints ("U.A.E.", "Belgique", "IND", "Antwerpen, Belgium", "Surat") into an
 * ISO 3166 alpha-2 code, or null. A bare "NA" means "not applicable" here, not Namibia.
 */
export function normalizeCountry(input) {
  const exact = exactCountry(input);
  if (exact !== undefined) return exact;
  const words = cleanWords(String(input).replace(/\./g, ''));

  // Inside longer text: the country printed last wins (addresses end with the country).
  let best = null;
  const padded = ` ${words} `;
  for (const [word, iso2] of SEARCH_WORDS) {
    const at = padded.lastIndexOf(` ${word} `);
    if (at === -1) continue;
    const end = at + word.length;
    if (!best || end > best.end) best = { end, iso2 };
  }
  return best ? best.iso2 : null;
}

// Exact matches only (code, name, alias or hub city). Returns undefined when nothing matched exactly,
// null when the text is empty or means "not applicable".
function exactCountry(input) {
  if (input === null || input === undefined) return null;
  const words = cleanWords(String(input).trim().replace(/\./g, '')); // U.A.E. -> UAE
  if (!words) return null;
  if (words === 'NA' || words === 'N A') return null;
  if (/^[A-Z]{2}$/.test(words) && BY_ISO2[words]) return words;
  if (/^[A-Z]{3}$/.test(words) && BY_ISO3[words]) return BY_ISO3[words];
  if (BY_WORDS.has(words)) return BY_WORDS.get(words);
  if (HUB_CITIES[words]) return HUB_CITIES[words];
  return undefined;
}

/** Split a list such as "Botswana, Namibia / South Africa" or "BW, NA, ZA" into ISO2 codes. */
export function splitCountries(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  const codes = [];
  const add = (code) => {
    if (code && !codes.includes(code)) codes.push(code);
  };
  for (const item of list) {
    const text = String(item).replace(/^\s*(MIXED( ORIGIN)?|COUNTRIES OF MINING|COUNTRY OF MINING|ORIGIN)\s*[:-]?\s*/i, '');
    // "Congo, Democratic Republic of the" is one country even with a comma.
    const whole = exactCountry(text);
    if (whole) {
      add(whole);
      continue;
    }
    const parts = text.split(/[,;/&+\n]|\band\b/i).map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      // Inside a list a bare "NA" is Namibia.
      add(/^N\.?A\.?$/i.test(part) && parts.length > 1 ? 'NA' : normalizeCountry(part));
    }
  }
  return codes;
}

/** 'BE' -> 'Belgium'. Unknown codes come back as given. */
export function countryName(code) {
  if (!code) return null;
  return BY_ISO2[code] ? BY_ISO2[code].name : String(code);
}

/** True for the 27 EU member states (and the EU itself as a KP participant). */
export function isEU(codeOrName) {
  const code = normalizeCountry(codeOrName);
  return Boolean(code && (code === 'EU' || EU_MEMBER_STATES[code]));
}

/** The country at an airport code on an air waybill route. */
export function airportCountry(code) {
  return AIRPORTS[String(code || '').toUpperCase().trim()] || null;
}

// ---------- Russia ----------

// Words that point to Russian origin. "RU" and "RUS" only count as whole entries in a country list.
export const RUSSIA_WORDS = ['RUSSIAN FEDERATION', 'RUSSIA', 'RUSSIAN', 'ALROSA', 'YAKUTIA', 'YAKUTSK', 'SAKHA', 'ARKHANGELSK'];
export const RUSSIA_CODES = ['RU', 'RUS'];

// A Russia word after one of these in the same sentence ("not of Russian origin",
// "excluding transits to/from Ukraine, Russia") is not a hit. "No" is left out on purpose:
// addresses say "Plot No. 5".
const NEGATIONS = new Set(['NOT', 'NON', 'EXCLUDING', 'EXCLUDED', 'EXCEPT', 'WITHOUT', 'THAN']);

/**
 * The Russia indicator found in free text, or null. Negated mentions are ignored, so a declaration
 * like "not of Russian origin" does not trip the rule.
 */
export function findRussiaWord(text) {
  if (!text) return null;
  for (const sentence of String(text).split(/[;:!?\n]|\.(?=\s|$)/)) {
    const words = cleanWords(sentence).split(' ');
    for (let i = 0; i < words.length; i++) {
      const hit = RUSSIA_WORDS.find((word) => word.split(' ').every((part, j) => words[i + j] === part));
      if (!hit) continue;
      const before = words.slice(Math.max(0, i - 8), i);
      if (before.some((word) => NEGATIONS.has(word))) continue;
      return hit;
    }
  }
  return null;
}

/** True when a country list or country field names Russia ("RU", "RUS", "Russian Federation", "Yakutia"). */
export function countryListHasRussia(text) {
  if (!text) return false;
  const items = String(text).split(/[,;/&+\n]|\band\b/i).map((part) => cleanWords(part));
  if (items.some((item) => RUSSIA_CODES.includes(item))) return true;
  return splitCountries(text).includes('RU') || Boolean(findRussiaWord(text));
}

// ---------- HS codes ----------

// Six-digit HS subheadings for diamonds. India prints eight digits (71023910); the first six decide.
export const HS_CODES = {
  '7102.10': { nature: 'natural', form: 'rough', unsorted: true, label: 'Diamonds, unsorted' },
  '7102.21': { nature: 'natural', form: 'rough', industrial: true, label: 'Industrial diamonds, unworked' },
  '7102.29': { nature: 'natural', form: 'polished', industrial: true, label: 'Industrial diamonds, worked' },
  '7102.31': { nature: 'natural', form: 'rough', label: 'Non-industrial diamonds, unworked (natural rough)' },
  '7102.39': { nature: 'natural', form: 'polished', label: 'Non-industrial diamonds, worked (natural polished)' },
  '7104.21': { nature: 'lab-grown', form: 'rough', label: 'Synthetic diamonds, unworked (lab-grown rough)' },
  '7104.91': { nature: 'lab-grown', form: 'polished', label: 'Synthetic diamonds, worked (lab-grown polished)' },
};
// Four-digit headings used when only the heading is printed.
export const HS_HEADINGS = {
  7102: { nature: 'natural', form: 'unknown', label: 'Diamonds' },
  7104: { nature: 'lab-grown', form: 'unknown', label: 'Synthetic or reconstructed stones' },
  7113: { nature: 'unknown', form: 'jewelry', label: 'Jewellery of precious metal' },
};

/** '71023910' or '7102.39.10' -> '7102.39'; '7113' -> '7113'. Null when it is not an HS code. */
export function formatHsCode(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  if (digits.length < 6) return digits.slice(0, 4);
  const six = `${digits.slice(0, 4)}.${digits.slice(4, 6)}`;
  // Jewellery is grouped by heading because the subheading is about the metal, not the stone.
  return digits.startsWith('7113') ? '7113' : six;
}

/** What an HS code says about the goods: { code, nature, form, industrial, unsorted, label } or null. */
export function hsInfo(input) {
  const code = formatHsCode(input);
  if (!code) return null;
  if (HS_CODES[code]) return { code, industrial: false, unsorted: false, ...HS_CODES[code] };
  const heading = HS_HEADINGS[code.slice(0, 4)];
  if (heading) return { code, industrial: false, unsorted: false, ...heading };
  return null;
}

// ---------- words on the papers ----------

const LAB_GROWN_PATTERN = /\b(LAB[\s-]?GROWN|LABORATORY[\s-]GROWN|LAB[\s-]CREATED|LGD|CVD|HPHT|SYNTHETIC|MAN[\s-]?MADE|CULTURED)\b/;
const NATURAL_PATTERN = /\b(NATURAL|EARTH[\s-]MINED|MINED)\b/;

/** 'natural', 'lab-grown' or null from a description, a growth column or a lab comment. */
export function natureFromText(text) {
  if (!text) return null;
  const upper = String(text).toUpperCase();
  if (LAB_GROWN_PATTERN.test(upper)) return 'lab-grown';
  if (NATURAL_PATTERN.test(upper)) return 'natural';
  return null;
}

/** 'CVD', 'HPHT' or null. */
export function growthMethodFromText(text) {
  if (!text) return null;
  const upper = String(text).toUpperCase();
  if (/\bCVD\b|CHEMICAL VAPOU?R/.test(upper)) return 'CVD';
  if (/\bHPHT\b|HIGH PRESSURE/.test(upper)) return 'HPHT';
  return null;
}

/** 'rough', 'polished', 'jewelry' or null from a description. */
export function formFromText(text) {
  if (!text) return null;
  const upper = String(text).toUpperCase();
  if (/\b(JEWELL?ERY|JEWELRY|RINGS?|EARRINGS?|PENDANTS?|NECKLACES?|BRACELETS?|BANGLES?)\b/.test(upper)) return 'jewelry';
  if (/\b(POLISHED|CUT\s*(AND|&)\s*POLISHED|WORKED|FACETED|BRILLIANTS?)\b/.test(upper)) return 'polished';
  if (/\b(ROUGH|UNWORKED|UNCUT|UNSORTED)\b/.test(upper)) return 'rough';
  return null;
}

// ---------- labs and report numbers ----------

const LAB_NAMES = [
  ['GIA', /\bGIA\b|GEMOLOGICAL INSTITUTE OF AMERICA/],
  ['IGI', /\bIGI\b|INTERNATIONAL GEMOLOGICAL INSTITUTE/],
  ['HRD', /\bHRD\b/],
  ['GCAL', /\bGCAL\b/],
  ['GSI', /\bGSI\b|GEMOLOGICAL SCIENCE INTERNATIONAL/],
  ['IIDGR', /\bIIDGR\b/],
  ['AGS', /\bAGS\b/],
  ['EGL', /\bEGL\b/],
];

/** 'GIA', 'IGI', 'HRD', 'GCAL', ... from a printed lab name. Other labs keep their printed name. */
export function normalizeLab(text) {
  if (!text) return null;
  const upper = String(text).toUpperCase();
  for (const [lab, pattern] of LAB_NAMES) if (pattern.test(upper)) return lab;
  return String(text).trim() || null;
}

/** Remove spaces and labels: "GIA # 2141 438 171" -> "2141438171". */
export function cleanReportNumber(input) {
  if (!input) return '';
  return String(input).toUpperCase().replace(/\b(GIA|IGI|HRD|GCAL|GSI|REPORT|NO|NUMBER)\b\.?/g, '').replace(/[^A-Z0-9]/g, '');
}

// Report number shapes per lab. Approximate: labs change formats over time, so a miss is a
// question for a person, never a failure.
export const REPORT_FORMATS = {
  GIA: { pattern: /^\d{7,10}$/, hint: '7 to 10 digits' },
  IGI: { pattern: /^(LG)?\d{8,10}$/, hint: '8 to 10 digits, with LG in front for lab-grown' },
  HRD: { pattern: /^\d{8,12}$/, hint: '8 to 12 digits' },
  GCAL: { pattern: /^\d{6,12}$/, hint: '6 to 12 digits' },
};

/** A lab guessed from the number itself, only where the format is unmistakable (IGI's LG prefix). */
export function labFromReportNumber(reportNumber) {
  const clean = cleanReportNumber(reportNumber);
  if (/^LG\d{8,10}$/.test(clean)) return 'IGI';
  return null;
}

/** { ok: true|false|null, lab, hint }. ok is null when the lab has no known format. */
export function checkReportNumber(lab, reportNumber) {
  const clean = cleanReportNumber(reportNumber);
  const format = REPORT_FORMATS[lab];
  if (!clean) return { ok: false, lab, hint: format ? format.hint : null, clean };
  if (!format) return { ok: null, lab, hint: null, clean };
  return { ok: format.pattern.test(clean), lab, hint: format.hint, clean };
}

// ---------- grades ----------

const SHAPES = [
  ['Round', /\b(ROUND|RD|RBC|BR|RB)\b/],
  ['Oval', /\b(OVAL|OV)\b/],
  ['Pear', /\b(PEAR|PS|PE)\b/],
  ['Princess', /\b(PRINCESS|PR|PRN)\b/],
  ['Cushion', /\b(CUSHION|CU|CUS|CB|CMB)\b/],
  ['Emerald', /\b(EMERALD|EM|EC)\b/],
  ['Marquise', /\b(MARQUISE|MQ|MARQ)\b/],
  ['Heart', /\b(HEART|HS|HT)\b/],
  ['Radiant', /\b(RADIANT|RAD|RA)\b/],
  ['Asscher', /\b(ASSCHER|AS|ASH)\b/],
  ['Baguette', /\b(BAGUETTE|BAG)\b/],
];

/** 'Round Brilliant', 'RD', 'RBC' -> 'Round'. Unknown shapes come back trimmed. */
export function normalizeShape(text) {
  if (!text) return null;
  const upper = String(text).toUpperCase();
  for (const [shape, pattern] of SHAPES) if (pattern.test(upper)) return shape;
  return String(text).trim() || null;
}

/** 'G', 'g color', 'G ' -> 'G'. Fancy colours come back in upper case. */
export function normalizeColor(text) {
  if (!text) return null;
  const upper = String(text).toUpperCase().trim();
  const letter = upper.match(/^([D-Z])(\b|$|\s|-)/);
  if (letter && !/^[D-Z]-[D-Z]/.test(upper)) return letter[1];
  return upper.replace(/\s+/g, ' ') || null;
}

const CLARITIES = ['FL', 'IF', 'VVS1', 'VVS2', 'VS1', 'VS2', 'SI1', 'SI2', 'SI3', 'I1', 'I2', 'I3'];

/** 'VS 1', 'vs-1' -> 'VS1'. */
export function normalizeClarity(text) {
  if (!text) return null;
  const compact = String(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (CLARITIES.includes(compact)) return compact;
  const found = CLARITIES.slice().sort((a, b) => b.length - a.length).find((grade) => compact.startsWith(grade));
  return found || compact || null;
}

// ---------- Kimberley Process ----------

// KP participants (approximate, from kimberleyprocess.com; check there for the current list).
// The EU counts as one participant for all 27 member states.
export const KP_PARTICIPANTS = [
  'AO', 'AM', 'AU', 'BD', 'BY', 'BW', 'BR', 'KH', 'CM', 'CA', 'CF', 'CN', 'CI', 'CD', 'CG', 'EU', 'GA', 'GH', 'GN',
  'GY', 'IN', 'ID', 'IL', 'JP', 'KZ', 'KR', 'KG', 'LA', 'LB', 'LS', 'LR', 'MY', 'ML', 'MU', 'MX', 'NA', 'NZ', 'NO',
  'PA', 'RU', 'SL', 'SG', 'ZA', 'LK', 'SZ', 'CH', 'TW', 'TZ', 'TH', 'TG', 'TR', 'UA', 'AE', 'GB', 'US', 'VE', 'VN',
  'ZW', 'HK',
];

/** True when the country takes part in the Kimberley Process (EU members count through the EU). */
export function isKpParticipant(codeOrName) {
  const code = normalizeCountry(codeOrName);
  if (!code) return false;
  return KP_PARTICIPANTS.includes(code) || Boolean(EU_MEMBER_STATES[code]);
}
