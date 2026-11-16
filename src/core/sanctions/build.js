// Builds the in-memory OFAC index from the two Treasury CSV files.
//   sdn.csv  one row per entry: ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign, Vess_type, Tonnage, GRT,
//            Vess_flag, Vess_owner, Remarks
//   alt.csv  aliases: ent_num, alt_num, alt_type (aka, fka, nka), alt_name, alt_remarks
// Every primary name and alias becomes a searchable "name" that points back to its entry.
import { parseCsv, cleanValue } from './csv.js';
import { nameTokens, isLowWeightWord } from './normalize.js';
import { countriesOfEntry } from './countries.js';

// Trade and place words always weigh this much. A normal word weighs 3 (very common on the list,
// like "AL") to 11 (never on the list), so a trade word counts for a fraction of a real name word.
const LOW_WORD_WEIGHT = 1.5;

/**
 * @returns {{ count:number, date:string|null, source:string, entries:object[], names:object[],
 *   postings:Map<string, number[]>, entryFrequency:Map<string, number>, wordsByStart:Map<string, string[]>,
 *   buildMs:number }}
 */
export function buildSdnIndex({ sdnCsv, altCsv = '', date = null, source = '' }) {
  const startedAt = Date.now();
  const entries = readEntries(sdnCsv);
  addAliases(entries, altCsv);

  // One searchable name per primary name and per alias.
  const names = [];
  for (const entry of entries) {
    addName(names, entry, entry.name, 'name');
    for (const alias of entry.aliases) addName(names, entry, alias.name, alias.type);
  }

  // Word -> the names that contain it (the "postings"), and in how many entries each word appears.
  // Two neighbouring words written together are indexed too, so "ALZAWAHIRI" finds "AL-ZAWAHIRI".
  const postings = new Map();
  const entryFrequency = new Map();
  const lastEntrySeen = new Map(); // the names of one entry sit next to each other, so each entry counts once
  names.forEach((name, nameIndex) => {
    for (const word of new Set([...name.tokens, ...joinedPairs(name.tokens)])) {
      if (!postings.has(word)) postings.set(word, []);
      postings.get(word).push(nameIndex);
      if (lastEntrySeen.get(word) !== name.entry.uid) {
        lastEntrySeen.set(word, name.entry.uid);
        entryFrequency.set(word, (entryFrequency.get(word) || 0) + 1);
      }
    }
  });

  const index = { count: entries.length, date, source, entries, names, postings, entryFrequency, wordsByStart: null };

  // Each word's weight: rare words weigh more (IDF), trade and place words weigh less.
  for (const name of names) {
    name.weights = name.tokens.map((word) => wordWeight(word, index));
    name.totalWeight = name.weights.reduce((sum, weight) => sum + weight, 0);
  }

  // Single words grouped by first letter and length, so fuzzy lookup only compares words that could be
  // close. (Joined pairs are only found by exact lookup; that keeps fuzzy lookup fast.)
  const singleWords = new Set();
  for (const name of names) for (const word of name.tokens) singleWords.add(word);
  index.wordsByStart = new Map();
  for (const word of singleWords) {
    const key = startKey(word[0], word.length);
    if (!index.wordsByStart.has(key)) index.wordsByStart.set(key, []);
    index.wordsByStart.get(key).push(word);
  }

  index.buildMs = Date.now() - startedAt;
  return index;
}

/** Weight of one word: the log of how rare it is on the list (inverse document frequency). */
export function wordWeight(word, index) {
  if (isLowWeightWord(word)) return LOW_WORD_WEIGHT;
  const entriesWithWord = index.entryFrequency.get(word) || 0.5; // unseen words count as rarer than any seen word
  return Math.log(1 + index.count / entriesWithWord);
}

export function startKey(firstLetter, length) {
  return firstLetter + length;
}

/** ["AL", "ZAWAHIRI", "AYMAN"] -> ["ALZAWAHIRI", "ZAWAHIRIAYMAN"] */
export function joinedPairs(tokens) {
  const pairs = [];
  for (let i = 0; i + 1 < tokens.length; i++) pairs.push(tokens[i] + tokens[i + 1]);
  return pairs;
}

function readEntries(sdnCsv) {
  const entries = [];
  for (const row of parseCsv(sdnCsv || '')) {
    if (row.length < 4 || !/^\d+$/.test(row[0].trim())) continue; // skip a header or junk line
    const remarks = cleanValue(row[11]);
    entries.push({
      uid: Number(row[0]),
      name: cleanValue(row[1]),
      type: entryType(cleanValue(row[2])),
      programs: splitPrograms(cleanValue(row[3])),
      title: cleanValue(row[4]),
      remarks,
      countries: countriesOfEntry(remarks, cleanValue(row[9])),
      aliases: [],
    });
  }
  return entries;
}

function addAliases(entries, altCsv) {
  const byUid = new Map(entries.map((entry) => [entry.uid, entry]));
  for (const row of parseCsv(altCsv || '')) {
    const entry = byUid.get(Number(row[0]));
    const name = cleanValue(row[3]);
    if (entry && name) entry.aliases.push({ name, type: cleanValue(row[2]).toLowerCase() || 'aka' });
  }
}

function addName(names, entry, text, kind) {
  const tokens = nameTokens(text);
  if (!tokens.length) return;
  names.push({ entry, text, kind, tokens });
}

// OFAC leaves the type empty ("-0-") for companies and other entities.
function entryType(rawType) {
  const type = rawType.toLowerCase();
  return type === 'individual' || type === 'vessel' || type === 'aircraft' ? type : 'entity';
}

// "FTO] [SDGT" -> ["FTO", "SDGT"] (the file drops the outer brackets of "[FTO] [SDGT]").
function splitPrograms(rawPrograms) {
  return rawPrograms.split(/\]\s*\[/).map((program) => program.replace(/[[\]]/g, '').trim()).filter(Boolean);
}
