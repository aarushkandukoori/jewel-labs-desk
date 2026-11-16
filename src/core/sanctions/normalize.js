// Name normalization for sanctions screening.
// Both the OFAC names and the party names from the papers go through the same steps, so
// "M/s Kavya Gems Pvt. Ltd." and "KAVYA GEMS PRIVATE LIMITED" both become the tokens ["KAVYA", "GEMS"].

// Legal forms and noise. They say nothing about who the party is, so we drop them.
// Multi-word phrases are removed first, then single words.
const DROP_PHRASES = [
  'PUBLIC JOINT STOCK COMPANY', 'CLOSED JOINT STOCK COMPANY', 'OPEN JOINT STOCK COMPANY', 'JOINT STOCK COMPANY',
  'LIMITED LIABILITY COMPANY', 'LIMITED LIABILITY PARTNERSHIP', 'LIMITED PARTNERSHIP', 'PRIVATE LIMITED',
  'PUBLICHNOE AKTSIONERNOE OBSHCHESTVO', 'ZAKRYTOE AKTSIONERNOE OBSHCHESTVO', 'OTKRYTOE AKTSIONERNOE OBSHCHESTVO',
  'AKTSIONERNOE OBSHCHESTVO', 'OBSHCHESTVO S OGRANICHENNOI OTVETSTVENNOSTYU',
  'OBSHCHESTVO S OGRANICHENNOY OTVETSTVENNOSTYU', 'SOCIEDAD ANONIMA', 'SOCIETE ANONYME',
  'SA DE CV', 'S DE RL DE CV', 'S DE RL', 'SP Z OO', 'SDN BHD', 'PTE LTD', 'PTY LTD', 'AND SONS', 'AND CO',
];
const DROP_PHRASE_PATTERNS = DROP_PHRASES.map((phrase) => new RegExp(`(^| )${phrase}(?= |$)`, 'g'));

// "M/s" (Messrs) in front of Indian firm names: "M/s Kavya Gems".
const LEADING_MESSRS = /^(M S|MESSRS|MESSERS) /;

const DROP_WORDS = new Set([
  // The list from the brief
  'LLC', 'LTD', 'LIMITED', 'PVT', 'PRIVATE', 'FZCO', 'FZE', 'DMCC', 'LLP', 'BV', 'NV', 'BVBA', 'GMBH', 'SA', 'SAS',
  'SPA', 'INC', 'CORP', 'CO', 'COMPANY', 'EXPORTS', 'IMPORTS',
  // Other common legal forms
  'LTDA', 'PLC', 'LP', 'PTE', 'PTY', 'BHD', 'SRL', 'SARL', 'SAL', 'SPRL', 'AG', 'KG', 'OY', 'ASA', 'JSC', 'PJSC',
  'OJSC', 'CJSC', 'OAO', 'ZAO', 'OOO', 'PAO', 'AO', 'TOO', 'FZ', 'FZC', 'FZLLC', 'WLL', 'INCORPORATED',
  'CORPORATION', 'CV', 'BVI', 'KFT', 'DOO', 'EOOD', 'OOD', 'SRO', 'APS', 'LIABILITY',
  // Filler words and titles
  'THE', 'OF', 'AND', 'FOR', 'DR', 'MR', 'MRS', 'MISS', 'PROF', 'SIR',
]);

// Words that are common in trade and place names. We keep them (they still help when the rest
// matches) but they count for little, so "Lumen Diamant" does not match an entry just called "DIAMOND".
export const LOW_WEIGHT_WORDS = new Set([
  'DIAMOND', 'DIAMONDS', 'DIAMANT', 'DIAMANTS', 'DIAMANTE', 'DIAMANTES', 'DIAMANTI', 'DIAM', 'GEM', 'GEMS',
  'GEMSTONE', 'GEMSTONES', 'JEWEL', 'JEWELS', 'JEWELLERY', 'JEWELRY', 'JEWELLERS', 'JEWELERS', 'JEWELLER', 'JEWELER',
  'GOLD', 'SILVER', 'PLATINUM', 'PEARL', 'PEARLS', 'STONE', 'STONES', 'BULLION',
  'TRADING', 'TRADERS', 'TRADER', 'TRADE', 'EXPORT', 'IMPORT', 'EXIM', 'IMPEX', 'OVERSEAS', 'INTERNATIONAL', 'INTL',
  'GLOBAL', 'WORLDWIDE', 'GROUP', 'HOLDING', 'HOLDINGS', 'ENTERPRISE', 'ENTERPRISES', 'INDUSTRIES', 'INDUSTRY',
  'INDUSTRIAL', 'MANUFACTURING', 'MANUFACTURERS', 'GENERAL', 'SERVICES', 'SERVICE', 'SOLUTIONS', 'CREATIONS',
  'BROTHERS', 'BROS', 'SONS', 'PARTNERS', 'ASSOCIATES', 'VENTURES', 'INVESTMENTS', 'INVESTMENT', 'LOGISTICS',
  'SHIPPING', 'CARGO', 'FREIGHT', 'EXPRESS', 'COURIER', 'BRANCH', 'OFFICE', 'AGENCY',
  // Places that often follow a trading name ("..., Dubai branch")
  'DUBAI', 'HONG', 'KONG', 'HK', 'ANTWERP', 'ANTWERPEN', 'MUMBAI', 'BOMBAY', 'SURAT', 'NEW', 'YORK', 'NY', 'TEL',
  'AVIV', 'RAMAT', 'GAN', 'LONDON', 'GENEVA', 'SINGAPORE', 'BANGKOK', 'INDIA', 'BELGIUM', 'ISRAEL', 'USA', 'UAE',
  // Articles inside personal names ("AL-ZAWAHIRI" and "ZAWAHIRI" are the same family name) and honorifics
  'AL', 'EL', 'AS', 'AD', 'AR', 'AZ', 'ASH', 'AN', 'DE', 'DA', 'DI', 'DU', 'DEL', 'DER', 'DOS', 'DAS', 'VAN', 'VON',
  'LA', 'LE', 'SHAYKH', 'SHEIKH', 'SHAIKH', 'HAJI', 'HAJJI', 'MULLAH', 'MAULANA',
]);

// Letters that Unicode decomposition (NFKD) does not split into a base letter plus an accent.
const SPECIAL_LETTERS = { ß: 'SS', ẞ: 'SS', Ø: 'O', ø: 'O', Æ: 'AE', æ: 'AE', Œ: 'OE', œ: 'OE', Ł: 'L', ł: 'L',
  Đ: 'D', đ: 'D', Þ: 'TH', þ: 'TH', ı: 'I' };

/** Uppercase, strip accents and punctuation, collapse spaces. Keeps every word. */
export function basicNormalize(raw) {
  let text = String(raw ?? '');
  text = text.replace(/[ßẞØøÆæŒœŁłĐđÞþı]/g, (ch) => SPECIAL_LETTERS[ch]);
  text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); // é -> e
  text = text.toUpperCase();
  text = text.replace(/&/g, ' AND ');
  text = text.replace(/['’‘`.]/g, ''); // "L.L.C." -> "LLC", "O'NEIL" -> "ONEIL"
  text = text.replace(/[^A-Z0-9]+/g, ' ');
  return text.trim().replace(/ +/g, ' ');
}

/** Name tokens used for matching: legal forms and filler words removed. */
export function nameTokens(raw) {
  const basic = basicNormalize(raw);
  if (!basic) return [];
  let text = basic.replace(LEADING_MESSRS, '');
  for (const pattern of DROP_PHRASE_PATTERNS) text = text.replace(pattern, ' ');
  const tokens = text.split(' ').filter((token) => token && !DROP_WORDS.has(token));
  // A name made only of legal words ("THE COMPANY") keeps its words, so it never vanishes.
  return tokens.length ? tokens : basic.split(' ');
}

/** The normalized name as one string, e.g. "Kavya Gems Pvt. Ltd." -> "KAVYA GEMS". */
export function normalizeName(raw) {
  return nameTokens(raw).join(' ');
}

/** True for trade and place words, and for single letters (initials). They count for little. */
export function isLowWeightWord(token) {
  return token.length === 1 || LOW_WEIGHT_WORDS.has(token);
}
