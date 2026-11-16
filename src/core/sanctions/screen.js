// Screens one party name against the OFAC SDN index.
//
// 1. Normalize the name into words (normalize.js): "M/s Kavya Gems Pvt. Ltd." -> KAVYA GEMS.
// 2. Candidates: every SDN name that shares a word, or a nearly identical word, with the party. Rare words
//    count more, so the names that share rare words rank first. We score the top few hundred in detail.
//    Vessels and aircraft are left out by default: a party on a diamond invoice is a person or a company.
// 3. Score each candidate from 0 to 1. Every word is paired with its most similar word on the other side
//    (Jaro-Winkler, see wordSimilarity), and we add up how much of the word weight of both names found a
//    partner. Rare words weigh more than common ones; trade and place words weigh little. So an extra rare
//    word on either side pulls the score down a lot, an extra "Gems" or "Dubai" only a little.
//    A word may also match two neighbouring words written together ("ALZAWAHIRI" vs "AL ZAWAHIRI").
//    The party's country, when known, moves the score up or down a little.
// 4. >= 0.93 'match', >= 0.86 'review', else 'clear'. The result always carries the list date:
//    'clear' only means "no close name on this list on this date", never that a party is safe.
import { nameTokens } from './normalize.js';
import { jaroWinkler } from './jaro.js';
import { wordWeight, startKey } from './build.js';
import { countryCode } from './countries.js';

export const THRESHOLDS = { match: 0.93, review: 0.86 };

const WORD_MIN_SIMILARITY = 0.84; // two words less alike than this (Jaro-Winkler) count as different words
const FUZZY_MAX_LENGTH_GAP = 2; // fuzzy lookup only compares words of similar length
const MAX_SCORED = 250; // candidates scored in detail per name
const COUNTRY_NUDGE = 0.02;
const SHORT_WORD_LETTERS = 3;
const NOT_PARTIES = new Set(['vessel', 'aircraft']);

/**
 * @param {string} name  party name as printed on the papers
 * @param {object} index from loadSdn()
 * @param {{ country?: string, includeVessels?: boolean }} [options]
 *   country: the party's country (name or ISO code); includeVessels: also compare vessel and aircraft names
 * @returns {{ name, status:'clear'|'review'|'match', best:{ sdnName, uid, programs, score, type, matchedName,
 *   matchedOn, countries }|null, compared:number, listDate:string|null, note:string }}
 */
export function screen(name, index, { country, includeVessels = false } = {}) {
  if (!index || !index.names) throw new Error('The OFAC list is not loaded yet. Call loadSdn first.');
  const query = makeQuery(name, index);
  if (!query.tokens.length) {
    // The OFAC list is written in Latin letters. A name in another script cannot be compared, so a person
    // has to look at it; an empty name has nothing to screen.
    if (/\p{L}/u.test(String(name ?? ''))) {
      return { name, status: 'review', best: null, compared: 0, listDate: index.date,
        note: 'This name has no Latin letters to compare with the OFAC list. Add the Latin spelling or check it by hand.' };
    }
    return { name, status: 'clear', best: null, compared: 0, listDate: index.date, note: 'No name to screen.' };
  }

  const partyCountry = country ? countryCode(country) : null;
  const candidates = findCandidates(query, index, includeVessels);
  let best = null;
  for (const nameIndex of candidates) {
    const candidate = index.names[nameIndex];
    const score = round(nudgeForCountry(scoreName(query, candidate), candidate.entry, partyCountry));
    if (!best || isBetter(score, candidate, best)) best = { score, candidate };
  }

  let status = !best ? 'clear' : best.score >= THRESHOLDS.match ? 'match'
    : best.score >= THRESHOLDS.review ? 'review' : 'clear';
  // A name made only of very short words ("SRK", "Li Wei") says too little to call it a match.
  if (status === 'match' && query.tokens.every((word) => word.length <= SHORT_WORD_LETTERS)) status = 'review';
  return {
    name,
    status,
    best: best ? describe(best) : null,
    compared: candidates.length,
    listDate: index.date,
    note: noteFor(status, best, candidates.length, index.date),
  };
}

// ---------- the query ----------

function makeQuery(name, index) {
  const tokens = [...new Set(nameTokens(name))];
  const weights = tokens.map((word) => wordWeight(word, index));
  return { tokens, weights, totalWeight: weights.reduce((sum, weight) => sum + weight, 0) };
}

// ---------- candidate retrieval ----------

function findCandidates(query, index, includeVessels) {
  // Rare words first: they find the right entry fastest and add the most to the ranking.
  const order = query.tokens.map((_, i) => i)
    .sort((a, b) => (index.entryFrequency.get(query.tokens[a]) || 0) - (index.entryFrequency.get(query.tokens[b]) || 0));

  const overlap = new Map(); // name index -> how much rare overlap it has with the party name
  for (const i of order) {
    for (const { word, similarity } of similarWords(query.tokens[i], index)) {
      const gain = query.weights[i] * similarity;
      for (const nameIndex of index.postings.get(word)) {
        if (!includeVessels && NOT_PARTIES.has(index.names[nameIndex].entry.type)) continue;
        overlap.set(nameIndex, (overlap.get(nameIndex) || 0) + gain);
      }
    }
  }
  return [...overlap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SCORED)
    .map(([nameIndex]) => nameIndex);
}

/** Words on the list equal or close to `word` (same first letter, similar length). */
function similarWords(word, index) {
  const found = [];
  if (index.postings.has(word)) found.push({ word, similarity: 1 });
  if (!canBeFuzzy(word)) return found;
  for (let length = word.length - FUZZY_MAX_LENGTH_GAP; length <= word.length + FUZZY_MAX_LENGTH_GAP; length++) {
    for (const other of index.wordsByStart.get(startKey(word[0], length)) || []) {
      if (other === word) continue;
      const similarity = wordSimilarity(word, other);
      if (similarity > 0) found.push({ word: other, similarity });
    }
  }
  return found;
}

// ---------- scoring ----------

/**
 * How well two words match: 1 for the same word, 0 for different words, in between for near spellings.
 * The gap from a perfect Jaro-Winkler score counts double, so one swapped letter in a long word still
 * scores about 0.92 ("RUHMEER" vs "RUMHEER"), but two short words that merely look alike drop well
 * below the review line ("KIRAN" vs "KSIAN": Jaro-Winkler 0.88, match 0.76).
 */
export function wordSimilarity(a, b) {
  if (a === b) return 1;
  if (!canBeFuzzy(a) || !canBeFuzzy(b)) return 0;
  const similarity = jaroWinkler(a, b);
  return similarity >= WORD_MIN_SIMILARITY ? 1 - 2 * (1 - similarity) : 0;
}

// Short words and numbers must match exactly: "ALI" vs "ALY" or "1380079" vs "1380097" are different.
function canBeFuzzy(word) {
  return word.length >= 4 && !/\d/.test(word);
}

function scoreName(query, candidate) {
  // Pair every word with its most similar word on the other side.
  const queryBest = new Array(query.tokens.length).fill(0);
  const candidateBest = new Array(candidate.tokens.length).fill(0);
  for (let i = 0; i < query.tokens.length; i++) {
    for (let j = 0; j < candidate.tokens.length; j++) {
      const similarity = wordSimilarity(query.tokens[i], candidate.tokens[j]);
      if (similarity > queryBest[i]) queryBest[i] = similarity;
      if (similarity > candidateBest[j]) candidateBest[j] = similarity;
    }
  }
  // A word may also match two neighbouring words written together ("ALZAWAHIRI" vs "AL ZAWAHIRI").
  matchJoinedWords(query.tokens, queryBest, candidate.tokens, candidateBest);
  matchJoinedWords(candidate.tokens, candidateBest, query.tokens, queryBest);

  // Share of all word weight, on both names, that found a partner on the other side.
  const found = weightedSum(query.weights, queryBest) + weightedSum(candidate.weights, candidateBest);
  return Math.min(1, found / (query.totalWeight + candidate.totalWeight));
}

/** Compares each word on one side with each pair of neighbouring words on the other side, joined. */
function matchJoinedWords(words, wordsBest, otherWords, otherBest) {
  for (let j = 0; j + 1 < otherWords.length; j++) {
    const joined = otherWords[j] + otherWords[j + 1];
    for (let i = 0; i < words.length; i++) {
      // Only about the same length, so "ZAWAHIRI" does not half-match "ZAWAHIRIAYMAN".
      if (Math.abs(words[i].length - joined.length) > FUZZY_MAX_LENGTH_GAP) continue;
      const similarity = wordSimilarity(words[i], joined);
      if (similarity <= wordsBest[i]) continue;
      wordsBest[i] = similarity;
      otherBest[j] = Math.max(otherBest[j], similarity);
      otherBest[j + 1] = Math.max(otherBest[j + 1], similarity);
    }
  }
}

function weightedSum(weights, similarities) {
  let sum = 0;
  for (let i = 0; i < weights.length; i++) sum += weights[i] * similarities[i];
  return sum;
}

/** Same country as the entry: a little up. A different known country: a little down. Unknown: no change. */
function nudgeForCountry(score, entry, partyCountry) {
  if (!partyCountry || !entry.countries.length) return score;
  const nudged = entry.countries.includes(partyCountry) ? score + COUNTRY_NUDGE : score - COUNTRY_NUDGE;
  return Math.max(0, Math.min(1, nudged));
}

function isBetter(score, candidate, best) {
  if (score !== best.score) return score > best.score;
  if (candidate.kind !== best.candidate.kind) return candidate.kind === 'name'; // prefer the primary name
  return candidate.entry.uid < best.candidate.entry.uid;
}

function round(score) {
  return Math.round(score * 1000) / 1000;
}

// ---------- result ----------

function describe({ score, candidate }) {
  const { entry } = candidate;
  return {
    sdnName: entry.name,
    uid: entry.uid,
    programs: entry.programs,
    score,
    type: entry.type,
    matchedName: candidate.text,
    matchedOn: candidate.kind, // 'name', 'aka', 'fka' or 'nka'
    countries: entry.countries,
  };
}

function noteFor(status, best, compared, listDate) {
  const list = listDate ? `the OFAC SDN list of ${formatDate(listDate)}` : 'the OFAC SDN list';
  if (status === 'clear') {
    return `No match on ${list} (${compared} similar ${compared === 1 ? 'name' : 'names'} compared).`;
  }
  const alias = best.candidate.kind === 'name' ? '' : `, listed as ${best.candidate.text}`;
  const { programs } = best.candidate.entry;
  const programText = programs.length ? `, ${programs.length === 1 ? 'program' : 'programs'} ${programs.join(', ')}` : '';
  const lead = status === 'match' ? 'Possible match' : 'Similar name';
  return `${lead} on ${list}: ${best.candidate.entry.name}${alias}${programText} (score ${best.score.toFixed(2)}). ` +
    'A person must check it before the papers go out.';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-11-16" -> "16 Nov 2026"
function formatDate(isoDate) {
  const match = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(isoDate);
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}
