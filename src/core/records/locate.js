// Finds where a quoted value sits on a page, so the app can draw a highlight box around it.
// Words come from the PDF text layer or from OCR: [{ text, page, x0, y0, x1, y1 }] with boxes from
// 0 to 1 and the origin at the top left.
//
// The quote and the page are both cut into tokens: runs of letters and digits, lower case, without
// accents or punctuation. Numbers are written one way, so "1,02" and "1.02" are the same carat weight
// and "12,345.00" and "12345" the same amount, while "10.2" stays different from "1.02".
//
// Short quotes must be found whole. Long quotes (an address, a description) may be found in part:
// at least 60% of their tokens in order on the page, with every number among them.

const LONG_QUOTE_TOKENS = 4;
const MIN_PARTIAL_SCORE = 0.6;
const HINT_BONUS = 0.15; // the page the reader named gets a small head start over other pages
const MAX_QUOTE_TOKENS = 200;

// Scores for lining up the quote with the page: a matching token earns 2, a wrong or skipped one
// costs 1, so a stretch of the page only wins when it holds clearly more matches than misses.
const MATCH = 2;
const MISMATCH = -1;
const SKIP = 1;

// Digits OCR often reads as letters: O for 0, l or i for 1, S for 5, B for 8, Z for 2.
const OCR_LOOKALIKES = { o: '0', i: '1', l: '1', s: '5', b: '8', z: '2' };

// Three kinds of tokens, tried in this order:
//   1. letters and digits glued together: "exp28", "vvs1", or "7955o06" where OCR misread a 0,
//   2. a number, which may carry separators inside: "1,02", "12,345.00", "1'000",
//   3. a word.
const TOKEN = /(?=[\p{L}\p{N}]*\p{L})(?=[\p{L}\p{N}]*\d)[\p{L}\p{N}]+|\d+(?:[.,']\d+)*|[\p{L}\p{N}]+/gu;
const NUMBER = /^\d+(?:[.,']\d+)*$/;

/** Returns { page, box: [x0, y0, x1, y1], score } for the quote, or null when it is not on any page (sync). */
export function locate(words, quote, options = {}) {
  const page = options?.page == null ? null : Number(options.page); // a reader may send "2" for page 2
  const quoteTokens = tokenize(quote).slice(0, MAX_QUOTE_TOKENS).map(makeToken);
  if (!quoteTokens.length || !Array.isArray(words) || !words.length) return null;

  let best = null;
  for (const onePage of pagesOf(words)) {
    const match = matchOnPage(quoteTokens, onePage);
    if (!match) continue;
    const rank = match.score + (onePage.page === page ? HINT_BONUS : 0);
    if (!best || rank > best.rank) best = { ...match, page: onePage.page, rank };
  }
  if (!best) return null;
  return { page: best.page, box: unionBox(best.words), score: Math.round(best.score * 100) / 100 };
}

/**
 * Fills field.page and field.box for each field from its quote (or its value when the quote is not
 * found). Fields that cannot be found keep what they had; a missing box becomes null. Returns the fields.
 */
export function locateFields(words, fields = []) {
  for (const field of fields || []) {
    if (!field) continue;
    const hint = { page: field.page ?? undefined };
    const found = locate(words, field.quote, hint) || locate(words, field.value, hint);
    if (found) {
      field.page = found.page;
      field.box = found.box;
    } else if (field.box === undefined) {
      field.box = null;
    }
  }
  return fields;
}

/** Splits text into comparable tokens: "Invoice No: EXP/26-27/28" -> ["invoice", "no", "exp", "26", "27", "28"]. */
export function tokenize(text) {
  const plain = String(text ?? '')
    .normalize('NFKD') // splits accents off letters and turns look-alike forms (ligatures, wide digits) into plain ones
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  const raw = plain.match(TOKEN) || [];
  return raw.map((token) => (NUMBER.test(token) ? canonicalNumber(token) : token));
}

/** "1,02" -> "1.02", "12,345.00" -> "12345", "12.345,00" -> "12345", "05" -> "5". */
export function canonicalNumber(token) {
  const number = token.replace(/'/g, '');
  const lastDot = number.lastIndexOf('.');
  const lastComma = number.lastIndexOf(',');
  let decimal = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimal = lastDot > lastComma ? '.' : ','; // the later mark is the decimal point
  } else if (lastComma >= 0) {
    // One comma followed by exactly three digits groups thousands ("1,020"); otherwise it is a decimal ("1,02").
    decimal = count(number, ',') === 1 && number.length - lastComma - 1 !== 3 ? ',' : null;
  } else if (lastDot >= 0) {
    decimal = count(number, '.') === 1 ? '.' : null; // "1.000.000" groups thousands
  }
  const cut = decimal ? number.lastIndexOf(decimal) : number.length;
  const whole = number.slice(0, cut).replace(/[.,]/g, '').replace(/^0+(?=\d)/, '');
  const fraction = number.slice(cut + 1).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function makeToken(text) {
  return { text, digit: /\d/.test(text), folded: text.replace(/[oilsbz]/g, (letter) => OCR_LOOKALIKES[letter]) };
}

function sameToken(a, b) {
  if (a.text === b.text) return true;
  // With digits involved only look-alike letters may differ: 2141438171 never equals 2141438172.
  if (a.digit || b.digit) return a.folded === b.folded;
  // A long word with one letter wrong, added or missing still counts (a common OCR slip).
  return a.text.length >= 5 && b.text.length >= 5 && withinOneEdit(a.text, b.text);
}

function withinOneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// Words grouped by page, each word cut into tokens that remember which word they came from.
// Cached per words array, because locateFields asks about the same words many times.
const pageCache = new WeakMap();

function pagesOf(words) {
  if (pageCache.has(words)) return pageCache.get(words);
  const byPage = new Map();
  for (const word of words) {
    if (!word) continue;
    const pageNo = word.page ?? 1;
    if (!byPage.has(pageNo)) byPage.set(pageNo, { page: pageNo, words: [], tokens: [] });
    const onePage = byPage.get(pageNo);
    for (const text of tokenize(word.text)) onePage.tokens.push({ ...makeToken(text), word });
    onePage.words.push(word);
  }
  const pages = [...byPage.values()].sort((p, q) => p.page - q.page);
  pageCache.set(words, pages);
  return pages;
}

function matchOnPage(quote, onePage) {
  const run = findRun(quote, onePage.tokens);
  if (run) return { score: 1, words: run.map((token) => token.word) };

  const pairs = alignTokens(quote, onePage.tokens);
  const found = new Set(pairs.map((pair) => pair.quoteIndex));
  if (isEnough(quote, found)) return { score: found.size / quote.length, words: pairs.map((pair) => pair.token.word) };

  const lines = quote.length >= LONG_QUOTE_TOKENS ? matchByLines(quote, onePage.tokens) : null;
  return lines ? { score: 0.9, words: lines } : null;
}

// The quote's tokens one after another on the page, the usual case.
function findRun(quote, tokens) {
  return findRuns(quote, tokens)[0] || null;
}

function findRuns(quote, tokens) {
  const runs = [];
  for (let start = 0; start + quote.length <= tokens.length; start++) {
    if (quote.every((token, k) => sameToken(token, tokens[start + k]))) runs.push(tokens.slice(start, start + quote.length));
  }
  return runs;
}

const MAX_LINES = 4;

/**
 * A quote printed over a few lines of one column, such as an address next to another column: in reading order
 * the other column's words sit between its lines. Each piece of the quote is found whole, on the line just below
 * the piece before it and starting near the same left edge. Returns the matched words, or null.
 */
function matchByLines(quote, tokens) {
  const words = [];
  let rest = quote;
  let previous = null;
  for (let lineCount = 0; rest.length; lineCount++) {
    if (lineCount >= MAX_LINES) return null;
    let piece = null;
    for (let length = rest.length; length >= 1 && !piece; length--) {
      piece = findRuns(rest.slice(0, length), tokens).find((run) => !previous || justBelow(previous, run)) || null;
      if (piece) rest = rest.slice(length);
    }
    if (!piece) return null;
    words.push(...piece.map((token) => token.word));
    previous = piece;
  }
  return words;
}

/** Is this run on the next line or two below the previous one, starting near its left edge? */
function justBelow(previous, run) {
  const top = previous[0].word;
  const first = run[0].word;
  const lineHeight = Math.max(0.004, top.y1 - top.y0);
  const gap = first.y0 - top.y0;
  return gap > lineHeight * 0.5 && gap < lineHeight * 3.5 && Math.abs(first.x0 - top.x0) < 0.12;
}

// Lines the quote up with the best stretch of the page, allowing missing, extra or misread words
// (local alignment, the Smith-Waterman method). Returns the matched pairs { quoteIndex, token }.
function alignTokens(quote, tokens) {
  const rows = quote.length;
  const cols = tokens.length;
  // score[i][j]: the best score of a stretch that ends at quote token i and page token j.
  const score = Array.from({ length: rows + 1 }, () => new Int32Array(cols + 1));
  let best = { value: 0, i: 0, j: 0 };
  for (let i = 1; i <= rows; i++) {
    for (let j = 1; j <= cols; j++) {
      const together = score[i - 1][j - 1] + (sameToken(quote[i - 1], tokens[j - 1]) ? MATCH : MISMATCH);
      const quoteWordMissing = score[i - 1][j] - SKIP;
      const extraPageWord = score[i][j - 1] - SKIP;
      score[i][j] = Math.max(0, together, quoteWordMissing, extraPageWord);
      if (score[i][j] > best.value) best = { value: score[i][j], i, j };
    }
  }
  // Walk back from the best cell to see which tokens were paired.
  const pairs = [];
  let { i, j } = best;
  while (i > 0 && j > 0 && score[i][j] > 0) {
    const same = sameToken(quote[i - 1], tokens[j - 1]);
    if (score[i][j] === score[i - 1][j - 1] + (same ? MATCH : MISMATCH)) {
      if (same) pairs.push({ quoteIndex: i - 1, token: tokens[j - 1] });
      i--;
      j--;
    } else if (score[i][j] === score[i - 1][j] - SKIP) {
      i--;
    } else {
      j--;
    }
  }
  return pairs.reverse();
}

function isEnough(quote, found) {
  if (quote.length < LONG_QUOTE_TOKENS) return found.size === quote.length;
  // Numbers carry the meaning (an invoice or report number), so none of them may be missing.
  const numbersFound = quote.every((token, index) => !token.digit || found.has(index));
  return numbersFound && found.size / quote.length >= MIN_PARTIAL_SCORE;
}

function unionBox(words) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const word of words) {
    box[0] = Math.min(box[0], word.x0);
    box[1] = Math.min(box[1], word.y0);
    box[2] = Math.max(box[2], word.x1);
    box[3] = Math.max(box[3], word.y1);
  }
  return box.map((value) => Math.round(value * 10000) / 10000);
}

function count(text, char) {
  return text.split(char).length - 1;
}
