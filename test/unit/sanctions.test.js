// Tests for the sanctions agent: OFAC SDN loading (bundled snapshot, cache, refresh) and name screening.
// Everything runs offline: the real snapshot in assets/ofac/ and fake fetch functions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadSdn, screen, buildSdnIndex, normalizeName, nameTokens, jaroWinkler, countryCode, wordSimilarity, THRESHOLDS,
  OFAC_SDN_URL, OFAC_ALT_URL,
} from '../../src/core/sanctions/index.js';
import { parseCsv, cleanValue } from '../../src/core/sanctions/csv.js';
import { countriesOfEntry } from '../../src/core/sanctions/countries.js';
import { ASSETS_DIR } from '../../src/core/config.js';

const OFAC_DIR = path.join(ASSETS_DIR, 'ofac');
let index; // the bundled snapshot, loaded once for the whole file
let snapshot; // assets/ofac/snapshot.json
let tmpDir;

before(async () => {
  index = await loadSdn({ fetch: null }); // null: do not try to download
  snapshot = JSON.parse(await fs.readFile(path.join(OFAC_DIR, 'snapshot.json'), 'utf8'));
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jl-sanctions-'));
});

after(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------- CSV, normalization, Jaro-Winkler ----------

test('parseCsv handles quotes, doubled quotes, CRLF and the Ctrl-Z end byte', () => {
  const text = '1,"A, B",-0- \r\n2,"say ""hi""",x\r\n\x1a';
  assert.deepEqual(parseCsv(text), [['1', 'A, B', '-0- '], ['2', 'say "hi"', 'x']]);
  assert.equal(cleanValue('-0- '), '');
  assert.equal(cleanValue(' CUBA '), 'CUBA');
});

test('normalizeName drops legal forms, accents and punctuation', () => {
  assert.equal(normalizeName('M/s Kavya Gems Pvt. Ltd.'), 'KAVYA GEMS');
  assert.equal(normalizeName('KAVYA GEMS PRIVATE LIMITED'), 'KAVYA GEMS');
  assert.equal(normalizeName('Lumen Diamant B.V.'), 'LUMEN DIAMANT');
  assert.equal(normalizeName('Société Générale S.A.'), 'SOCIETE GENERALE');
  assert.equal(normalizeName('Lumen & Sons BVBA'), 'LUMEN');
  assert.equal(normalizeName('Kavya Exports L.L.C.'), 'KAVYA');
  assert.equal(normalizeName('Public Joint Stock Company Sample'), 'SAMPLE');
  assert.deepEqual(nameTokens('AL-ZAWAHIRI, Dr. Ayman'), ['AL', 'ZAWAHIRI', 'AYMAN']);
  assert.equal(normalizeName('The Company'), 'THE COMPANY', 'a name of only legal words keeps its words');
  assert.equal(normalizeName(''), '');
});

test('jaroWinkler gives the textbook values', () => {
  assert.equal(jaroWinkler('MARTHA', 'MARTHA'), 1);
  assert.ok(Math.abs(jaroWinkler('MARTHA', 'MARHTA') - 0.961) < 0.001);
  assert.ok(Math.abs(jaroWinkler('DIXON', 'DICKSONX') - 0.813) < 0.001);
  assert.ok(Math.abs(jaroWinkler('DWAYNE', 'DUANE') - 0.84) < 0.001);
  assert.equal(jaroWinkler('ABC', ''), 0);
  assert.equal(jaroWinkler('ABC', 'XYZ'), 0);
});

test('wordSimilarity: same word 1, near spelling high, look-alike short words low', () => {
  assert.equal(wordSimilarity('RUHMEER', 'RUHMEER'), 1);
  assert.ok(wordSimilarity('RUHMEER', 'RUMHEER') > 0.9);
  assert.ok(wordSimilarity('KIRAN', 'KSIAN') < THRESHOLDS.review);
  assert.equal(wordSimilarity('ALI', 'ALY'), 0, 'short words must match exactly');
  assert.equal(wordSimilarity('1380079', '1380097'), 0, 'numbers must match exactly');
});

test('countryCode and countriesOfEntry read OFAC country wording', () => {
  assert.equal(countryCode('India'), 'IN');
  assert.equal(countryCode('in'), 'IN');
  assert.equal(countryCode('Korea, North'), 'KP');
  assert.equal(countryCode('Burma'), 'MM');
  assert.equal(countryCode('St. Kitts & Nevis'), 'KN');
  assert.equal(countryCode('Atlantis'), null);
  const codes = countriesOfEntry('DOB 1960; nationality Iran; Tax ID No. 77 (Russia); Registration (MSN).', 'Panama');
  assert.deepEqual(codes.sort(), ['IR', 'PA', 'RU']);
});

// ---------- the bundled snapshot ----------

test('the bundled snapshot parses into about 19,500 entries with the snapshot date', async () => {
  const sdnText = await fs.readFile(path.join(OFAC_DIR, 'sdn.csv'), 'utf8');
  const dataRows = sdnText.split('\n').filter((line) => /^\d+,/.test(line)).length;
  assert.equal(index.count, dataRows, 'one entry per data row');
  assert.ok(index.count > 15000 && index.count < 25000, `count ${index.count}`);
  assert.equal(index.entries.length, index.count);
  assert.equal(index.date, snapshot.downloaded);
  assert.equal(index.sourceKind, 'bundled');
  assert.match(index.source, /Bundled snapshot/);

  const anglo = index.entries.find((entry) => entry.uid === 173);
  assert.equal(anglo.name, 'ANGLO-CARIBBEAN CO., LTD.', 'quoted commas stay inside the name');
  const cuba = index.entries.find((entry) => entry.uid === 306);
  assert.deepEqual(cuba.programs, ['CUBA']);
  assert.ok(cuba.aliases.some((alias) => alias.name === 'NATIONAL BANK OF CUBA' && alias.type === 'aka'));
  const twoPrograms = index.entries.find((entry) => entry.programs.length >= 2);
  assert.ok(twoPrograms.programs.every((program) => !/[[\]]/.test(program)), 'brackets are stripped');
  const types = new Set(index.entries.map((entry) => entry.type));
  assert.deepEqual([...types].sort(), ['aircraft', 'entity', 'individual', 'vessel']);
});

test('building the index takes under 2 seconds', async () => {
  const [sdnCsv, altCsv] = await Promise.all([
    fs.readFile(path.join(OFAC_DIR, 'sdn.csv'), 'utf8'),
    fs.readFile(path.join(OFAC_DIR, 'alt.csv'), 'utf8'),
  ]);
  const started = performance.now();
  const built = buildSdnIndex({ sdnCsv, altCsv, date: '2026-01-01' });
  const ms = performance.now() - started;
  assert.equal(built.count, index.count);
  assert.ok(ms < 2000, `index build took ${Math.round(ms)} ms`);
});

// ---------- screening ----------

test('an exact SDN entity name from the file is a match', () => {
  const entity = index.entries.find((entry) => entry.type === 'entity' && entry.name.split(' ').length >= 2);
  const result = screen(entity.name, index);
  assert.equal(result.status, 'match');
  assert.equal(result.best.score, 1);
  assert.equal(normalizeName(result.best.matchedName), normalizeName(entity.name));

  const bank = screen('Banco Nacional de Cuba', index);
  assert.equal(bank.status, 'match');
  assert.equal(bank.best.uid, 306);
  assert.equal(bank.best.sdnName, 'BANCO NACIONAL DE CUBA');
  assert.deepEqual(bank.best.programs, ['CUBA']);
  assert.equal(bank.best.matchedOn, 'name');
});

test('an alias from alt.csv is a match and points to its entry', () => {
  const result = screen('National Bank of Cuba', index);
  assert.equal(result.status, 'match');
  assert.equal(result.best.uid, 306);
  assert.equal(result.best.matchedOn, 'aka');
  assert.equal(result.best.matchedName, 'NATIONAL BANK OF CUBA');

  // Any alias of an entity, taken from the file.
  const entry = index.entries.find((e) => e.type === 'entity' && e.aliases.some((a) => a.name.split(' ').length >= 2));
  const alias = entry.aliases.find((a) => a.name.split(' ').length >= 2);
  const aliasResult = screen(alias.name, index);
  assert.equal(aliasResult.status, 'match');
  assert.equal(normalizeName(aliasResult.best.matchedName), normalizeName(alias.name));
});

test('a person listed as "LAST, First" matches "First Last"', () => {
  const person = index.entries.find((entry) => entry.type === 'individual' && /^[A-Z-]+, [A-Za-z]+$/.test(entry.name));
  const [last, first] = person.name.split(', ');
  const result = screen(`${first} ${last}`, index);
  assert.equal(result.status, 'match');
  assert.equal(result.best.type, 'individual');
});

test('fictional sample houses are clear', () => {
  for (const name of ['Kavya Gems LLP', 'Lumen Diamant BV', 'Aravalli Facet Works LLP', 'Brugge Lumen Stones BVBA']) {
    const result = screen(name, index, { country: 'IN' });
    assert.equal(result.status, 'clear', `${name}: ${result.best?.sdnName} ${result.best?.score}`);
    assert.ok(result.compared >= 0);
    assert.match(result.note, /^No match on the OFAC SDN list of/);
  }
});

test('a near-miss spelling is a review, not a match and not clear', () => {
  for (const name of ['Banko Nasional de Cuba', 'Ruhmaer Diamonds']) {
    const result = screen(name, index);
    assert.equal(result.status, 'review', `${name}: ${result.best?.score}`);
    assert.ok(result.best.score >= THRESHOLDS.review && result.best.score < THRESHOLDS.match);
    assert.match(result.note, /A person must check it/);
  }
  assert.equal(screen('Banko Nasional de Cuba', index).best.uid, 306);
});

test('trade words weigh little: an SDN entry named only "DIAMOND" does not catch a diamond house', () => {
  const result = screen('Lumen Diamonds', index, { includeVessels: true });
  assert.equal(result.status, 'clear', `${result.best?.sdnName} ${result.best?.score}`);
});

test("the party's country nudges the score a little", () => {
  const plain = screen('Ruhmaer Diamonds', index).best; // RUHMEER DIAMONDS DMCC, registered in the UAE
  assert.ok(plain.countries.includes('AE'));
  const sameCountry = screen('Ruhmaer Diamonds', index, { country: 'United Arab Emirates' }).best;
  const otherCountry = screen('Ruhmaer Diamonds', index, { country: 'India' }).best;
  assert.equal(sameCountry.uid, plain.uid);
  assert.equal(otherCountry.uid, plain.uid);
  // 0.02 up or down (scores are rounded to 3 places, hence the small slack).
  assert.ok(Math.abs(sameCountry.score - plain.score - 0.02) <= 0.0011, `${sameCountry.score} vs ${plain.score}`);
  assert.ok(Math.abs(plain.score - otherCountry.score - 0.02) <= 0.0011, `${plain.score} vs ${otherCountry.score}`);
  assert.equal(screen('Ruhmaer Diamonds', index, { country: 'Atlantis' }).best.score, plain.score, 'unknown country: no change');
});

test('names written together or apart still match', () => {
  const person = index.entries.find((entry) => entry.type === 'individual' && /^AL-[A-Z]{4,}, [A-Za-z]+$/.test(entry.name));
  const [last, first] = person.name.split(', ');
  const result = screen(`${first} ${last.replace('-', '')}`, index); // "AL-XYZ" written "ALXYZ"
  assert.equal(result.status, 'match', `${first} ${last} -> ${result.best?.score}`);
});

test('a name of only very short words is at most a review', () => {
  const short = index.entries.find((entry) => entry.type === 'entity' && /^[A-Z]{3}$/.test(normalizeName(entry.name)));
  const result = screen(normalizeName(short.name), index);
  assert.equal(result.best.score, 1);
  assert.equal(result.status, 'review');
});

test('vessels and aircraft are left out unless asked for', () => {
  const partyNames = new Set(index.entries.filter((entry) => entry.type === 'entity' || entry.type === 'individual')
    .map((entry) => normalizeName(entry.name)));
  const vessel = index.entries.find((entry) => entry.type === 'vessel' && entry.name.split(' ').length >= 2
    && !partyNames.has(normalizeName(entry.name)));
  const people = screen(vessel.name, index);
  assert.notEqual(people.best?.type, 'vessel');
  const withVessels = screen(vessel.name, index, { includeVessels: true });
  assert.equal(withVessels.status, 'match');
  assert.equal(withVessels.best.type, 'vessel');
});

test('every result carries the list date and never claims more than the list', () => {
  const result = screen('Kavya Gems LLP', index);
  assert.equal(result.listDate, index.date);
  assert.equal(result.name, 'Kavya Gems LLP');
  assert.ok(['clear', 'review', 'match'].includes(result.status));
  assert.match(result.note, /16 Nov 2026|OFAC SDN list of/);

  const empty = screen('  ', index);
  assert.deepEqual([empty.status, empty.best, empty.compared], ['clear', null, 0]);
  assert.equal(empty.note, 'No name to screen.');
  const otherScript = screen('Сампл Трейд', index); // Cyrillic: nothing to compare with the Latin list
  assert.equal(otherScript.status, 'review');
  assert.match(otherScript.note, /no Latin letters/);
  assert.throws(() => screen('Kavya Gems', null), /not loaded/);
});

test('screen() takes under 20 ms per name once the index is built', () => {
  const names = ['Kavya Gems LLP', 'Lumen Diamant BV', 'Banco Nacional de Cuba', 'Mohammad Ali Trading Company',
    'International Trading Group Holding', 'Al Ahmad Al Mohammed General Trading', 'Star Diamonds', 'Shree Gems',
    'Alexander Ivanovich Petrov', 'Ruhmaer Diamonds', 'Sample Polished Exports Pvt Ltd', 'Zzyzx Qwerty',
    'Brugge Lumen Stones BVBA', 'New York Diamond Center', 'Dubai Gold and Jewellery Trading LLC', 'Hong Kong Gems'];
  const times = [];
  for (let round = 0; round < 3; round++) {
    for (const name of names) {
      const started = performance.now();
      screen(name, index, { country: 'IN' });
      times.push(performance.now() - started);
    }
  }
  times.sort((a, b) => a - b);
  const average = times.reduce((sum, ms) => sum + ms, 0) / times.length;
  const p95 = times[Math.floor(times.length * 0.95)];
  assert.ok(average < 20, `average ${average.toFixed(1)} ms`);
  assert.ok(p95 < 20, `95th percentile ${p95.toFixed(1)} ms (slowest ${times.at(-1).toFixed(1)} ms)`);
});

// ---------- loading: refresh, cache, fallback ----------

// A small fake SDN list (SAMPLE names) big enough to pass the download check.
function fakeLists(count = 1200) {
  const rows = [];
  for (let i = 1; i <= count; i++) {
    rows.push(`${i},"SAMPLE TEST ENTITY ${i}",-0- ,"SDGT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"Registration ID ${i} (Panama)."`);
  }
  return {
    sdn: `${rows.join('\r\n')}\r\n\x1a`,
    alt: '1,1,"aka","SAMPLE ALIAS ONE",-0- \r\n\x1a',
  };
}

function fakeResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
}

test('a refresh that fails keeps the bundled snapshot and says so', async () => {
  const cacheDir = path.join(tmpDir, 'offline');
  const failing = async () => { throw new Error('getaddrinfo ENOTFOUND www.treasury.gov'); };
  const result = await loadSdn({ cacheDir, fetch: failing });
  assert.equal(result.sourceKind, 'bundled');
  assert.equal(result.count, index.count);
  assert.equal(result.date, snapshot.downloaded);
  assert.match(result.source, /^Bundled snapshot of .+ Refresh failed: getaddrinfo ENOTFOUND/);
  assert.match(result.refreshError, /ENOTFOUND/);
  assert.equal(screen('Banco Nacional de Cuba', result).status, 'match', 'the fallback index still screens');
});

test('an error page from the server keeps the bundled snapshot', async () => {
  const unavailable = await loadSdn({ cacheDir: path.join(tmpDir, 'down'), fetch: async () => fakeResponse('busy', { status: 503 }) });
  assert.equal(unavailable.sourceKind, 'bundled');
  assert.match(unavailable.source, /503/);

  // A captive portal answers 200 with a web page: far too few entries, so it is refused.
  const portal = await loadSdn({ cacheDir: path.join(tmpDir, 'portal'), fetch: async () => fakeResponse('<html>Sign in to Wi-Fi</html>') });
  assert.equal(portal.sourceKind, 'bundled');
  assert.match(portal.source, /only 0 entries/);
});

test('a refresh follows redirects, caches the list, and the cache is used while fresh', async () => {
  const cacheDir = path.join(tmpDir, 'cache');
  const lists = fakeLists();
  const requested = [];
  const fakeFetch = async (url) => {
    requested.push(url);
    if (url === OFAC_SDN_URL) return fakeResponse(null, { status: 302, headers: { location: 'https://lists.example.test/sdn.csv' } });
    if (url === OFAC_ALT_URL) return fakeResponse(null, { status: 302, headers: { location: '/alt.csv' } });
    if (url === 'https://lists.example.test/sdn.csv') {
      return fakeResponse(lists.sdn, { headers: { 'last-modified': 'Fri, 13 Nov 2026 16:32:59 GMT' } });
    }
    if (url === 'https://www.treasury.gov/alt.csv') return fakeResponse(lists.alt);
    return fakeResponse('missing', { status: 404 });
  };
  const now = new Date('2026-11-20T10:00:00Z');

  const fresh = await loadSdn({ cacheDir, fetch: fakeFetch, now });
  assert.deepEqual(requested, [OFAC_SDN_URL, 'https://lists.example.test/sdn.csv', OFAC_ALT_URL, 'https://www.treasury.gov/alt.csv']);
  assert.equal(fresh.sourceKind, 'download');
  assert.equal(fresh.count, 1200);
  assert.equal(fresh.date, '2026-11-13', 'the list date is the Last-Modified date');
  assert.match(fresh.source, /Downloaded from treasury.gov on 2026-11-20/);
  assert.equal(fresh.entries[0].aliases[0].name, 'SAMPLE ALIAS ONE');
  const meta = JSON.parse(await fs.readFile(path.join(cacheDir, 'ofac-snapshot.json'), 'utf8'));
  assert.equal(meta.downloaded, '2026-11-20');

  // Within maxAgeHours: the cache is used and nothing is downloaded.
  let calls = 0;
  const counting = async () => { calls++; throw new Error('should not be called'); };
  const cached = await loadSdn({ cacheDir, fetch: counting, now: new Date('2026-11-20T20:00:00Z') });
  assert.equal(cached.sourceKind, 'cache');
  assert.equal(cached.count, 1200);
  assert.equal(calls, 0);

  // Older than maxAgeHours and offline: the old cache is still newer than the bundled snapshot.
  const stale = await loadSdn({ cacheDir, fetch: counting, now: new Date('2026-11-23T10:00:00Z') });
  assert.equal(calls, 1);
  assert.equal(stale.sourceKind, 'cache');
  assert.match(stale.source, /^Cached copy of 2026-11-20\. Refresh failed: should not be called\./);
});
