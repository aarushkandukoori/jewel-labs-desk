// Country names as the OFAC list writes them, plus common other spellings, by ISO 3166-1 alpha-2 code.
// Used only for the small country nudge in screening: we read the countries an SDN entry mentions
// (nationality, citizenship, "(Russia)" after a registration number, a vessel's flag) and compare
// them with the party's country from the papers.
import { basicNormalize } from './normalize.js';

const COUNTRY_NAMES = {
  AE: ['UNITED ARAB EMIRATES', 'UAE', 'EMIRATES'], AF: ['AFGHANISTAN'], AG: ['ANTIGUA AND BARBUDA'],
  AL: ['ALBANIA'], AM: ['ARMENIA'], AO: ['ANGOLA'], AR: ['ARGENTINA'], AT: ['AUSTRIA'], AU: ['AUSTRALIA'],
  AZ: ['AZERBAIJAN'], BA: ['BOSNIA AND HERZEGOVINA', 'BOSNIA'], BB: ['BARBADOS'], BD: ['BANGLADESH'],
  BE: ['BELGIUM'], BG: ['BULGARIA'], BH: ['BAHRAIN'], BJ: ['BENIN'], BO: ['BOLIVIA'], BR: ['BRAZIL'],
  BW: ['BOTSWANA'], BY: ['BELARUS'], BZ: ['BELIZE'], CA: ['CANADA'],
  CD: ['CONGO DEMOCRATIC REPUBLIC OF THE', 'DEMOCRATIC REPUBLIC OF THE CONGO', 'DR CONGO', 'DRC', 'CONGO KINSHASA'],
  CF: ['CENTRAL AFRICAN REPUBLIC'], CG: ['CONGO', 'REPUBLIC OF THE CONGO', 'CONGO BRAZZAVILLE'],
  CH: ['SWITZERLAND'], CI: ['COTE DIVOIRE', 'COTE D IVOIRE', 'IVORY COAST'], CK: ['COOK ISLANDS'], CL: ['CHILE'],
  CM: ['CAMEROON'], CN: ['CHINA', 'PEOPLES REPUBLIC OF CHINA', 'PRC'], CO: ['COLOMBIA'], CR: ['COSTA RICA'],
  CU: ['CUBA'], CV: ['CABO VERDE', 'CAPE VERDE'], CY: ['CYPRUS'], CZ: ['CZECH REPUBLIC', 'CZECHIA'],
  DE: ['GERMANY'], DJ: ['DJIBOUTI'], DK: ['DENMARK'], DM: ['DOMINICA'], DO: ['DOMINICAN REPUBLIC'],
  DZ: ['ALGERIA'], EC: ['ECUADOR'], EE: ['ESTONIA'], EG: ['EGYPT'], ER: ['ERITREA'], ES: ['SPAIN'],
  ET: ['ETHIOPIA'], FI: ['FINLAND'], FJ: ['FIJI'], FR: ['FRANCE'], GA: ['GABON'],
  GB: ['UNITED KINGDOM', 'UK', 'GREAT BRITAIN', 'BRITAIN', 'ENGLAND'], GE: ['GEORGIA'], GH: ['GHANA'],
  GI: ['GIBRALTAR'], GM: ['GAMBIA', 'THE GAMBIA'], GN: ['GUINEA'], GR: ['GREECE'], GT: ['GUATEMALA'],
  GW: ['GUINEA BISSAU'], GY: ['GUYANA'], HK: ['HONG KONG', 'HONG KONG SAR'], HN: ['HONDURAS'], HR: ['CROATIA'],
  HT: ['HAITI'], HU: ['HUNGARY'], ID: ['INDONESIA'], IE: ['IRELAND'], IL: ['ISRAEL'],
  IM: ['MAN ISLE OF', 'ISLE OF MAN'], IN: ['INDIA'], IQ: ['IRAQ'], IR: ['IRAN'], IT: ['ITALY'], JE: ['JERSEY'],
  JO: ['JORDAN'], JP: ['JAPAN'], KE: ['KENYA'], KG: ['KYRGYZSTAN'], KH: ['CAMBODIA'], KM: ['COMOROS'],
  KN: ['SAINT KITTS AND NEVIS', 'ST KITTS AND NEVIS'],
  KP: ['KOREA NORTH', 'NORTH KOREA', 'DEMOCRATIC PEOPLES REPUBLIC OF KOREA', 'DPRK'],
  KR: ['KOREA SOUTH', 'SOUTH KOREA', 'REPUBLIC OF KOREA'], KW: ['KUWAIT'], KY: ['CAYMAN ISLANDS'],
  KZ: ['KAZAKHSTAN'], LB: ['LEBANON'], LC: ['SAINT LUCIA'], LI: ['LIECHTENSTEIN'], LK: ['SRI LANKA'],
  LR: ['LIBERIA'], LS: ['LESOTHO'], LT: ['LITHUANIA'], LU: ['LUXEMBOURG'], LV: ['LATVIA'], LY: ['LIBYA'],
  MA: ['MOROCCO'], MD: ['MOLDOVA'], ME: ['MONTENEGRO'], MH: ['MARSHALL ISLANDS'],
  MK: ['NORTH MACEDONIA THE REPUBLIC OF', 'NORTH MACEDONIA', 'MACEDONIA'], ML: ['MALI'], MM: ['BURMA', 'MYANMAR'],
  MN: ['MONGOLIA'], MO: ['MACAU', 'MACAO'], MR: ['MAURITANIA'], MT: ['MALTA'], MU: ['MAURITIUS'],
  MV: ['MALDIVES'], MX: ['MEXICO'], MY: ['MALAYSIA'], MZ: ['MOZAMBIQUE'], NA: ['NAMIBIA'], NE: ['NIGER'],
  NG: ['NIGERIA'], NI: ['NICARAGUA'], NL: ['NETHERLANDS', 'THE NETHERLANDS', 'HOLLAND'], NO: ['NORWAY'],
  NZ: ['NEW ZEALAND'], OM: ['OMAN'], PA: ['PANAMA'], PE: ['PERU'], PH: ['PHILIPPINES'], PK: ['PAKISTAN'],
  PL: ['POLAND'], PS: ['PALESTINIAN', 'PALESTINIAN AUTHORITY', 'PALESTINE', 'WEST BANK', 'GAZA'],
  PT: ['PORTUGAL'], PW: ['PALAU', 'REPUBLIC OF PALAU'], PY: ['PARAGUAY'], QA: ['QATAR'], RO: ['ROMANIA'],
  RS: ['SERBIA'], RU: ['RUSSIA', 'RUSSIAN FEDERATION'], RW: ['RWANDA'], SA: ['SAUDI ARABIA'], SC: ['SEYCHELLES'],
  SD: ['SUDAN'], SE: ['SWEDEN'], SG: ['SINGAPORE'], SI: ['SLOVENIA'], SK: ['SLOVAKIA'], SL: ['SIERRA LEONE'],
  SM: ['SAN MARINO'], SN: ['SENEGAL'], SO: ['SOMALIA'], SS: ['SOUTH SUDAN'], ST: ['SAO TOME AND PRINCIPE'],
  SV: ['EL SALVADOR'], SY: ['SYRIA'], SZ: ['ESWATINI', 'SWAZILAND'], TD: ['CHAD'], TG: ['TOGO'],
  TH: ['THAILAND'], TJ: ['TAJIKISTAN'], TN: ['TUNISIA'], TR: ['TURKEY', 'TURKIYE'],
  TT: ['TRINIDAD AND TOBAGO'], TW: ['TAIWAN'], TZ: ['TANZANIA'], UA: ['UKRAINE'], UG: ['UGANDA'],
  US: ['UNITED STATES', 'UNITED STATES OF AMERICA', 'USA'], UY: ['URUGUAY'], UZ: ['UZBEKISTAN'],
  VC: ['SAINT VINCENT AND THE GRENADINES'], VE: ['VENEZUELA'],
  VG: ['VIRGIN ISLANDS BRITISH', 'BRITISH VIRGIN ISLANDS', 'BVI'], VN: ['VIETNAM', 'VIET NAM'], VU: ['VANUATU'],
  XK: ['KOSOVO'], YE: ['YEMEN'], ZA: ['SOUTH AFRICA'], ZM: ['ZAMBIA'], ZW: ['ZIMBABWE'],
};

// Reverse lookup: normalized name -> code.
const CODE_BY_NAME = new Map();
for (const [code, names] of Object.entries(COUNTRY_NAMES)) {
  for (const name of names) CODE_BY_NAME.set(name, code);
}

/** "India", "IN", "Korea, North", "St. Kitts & Nevis" -> ISO code, or null when we do not know it. */
export function countryCode(text) {
  const name = basicNormalize(text);
  if (!name) return null;
  if (name.length === 2 && COUNTRY_NAMES[name]) return name;
  return CODE_BY_NAME.get(name) || CODE_BY_NAME.get(name.replace(/^THE /, '')) || null;
}

// "nationality Iran;", "citizen Korea, North;", "Nationality of Registration Russia;"
const NATIONALITY = /(?:nationality of registration|nationality|citizen)\s+([^;()]{2,60}?)\s*(?:;|\.\s|\.$|$)/gi;
// "Tax ID No. 7701234567 (Russia)"
const IN_BRACKETS = /\(([^()]{2,60})\)/g;

/** Country codes an SDN entry mentions in its remarks or vessel flag, e.g. ['RU', 'AE']. */
export function countriesOfEntry(remarks, vesselFlag) {
  const codes = new Set();
  const text = String(remarks || '');
  for (const match of text.matchAll(NATIONALITY)) addCode(codes, match[1]);
  for (const match of text.matchAll(IN_BRACKETS)) addCode(codes, match[1]);
  if (vesselFlag) addCode(codes, vesselFlag);
  return [...codes];
}

function addCode(codes, text) {
  const code = countryCode(text);
  if (code) codes.add(code);
}
