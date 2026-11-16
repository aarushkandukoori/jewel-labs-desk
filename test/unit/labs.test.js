// Tests for the lab helpers: detecting the lab, report-check links, reading lab pages, comparing with our stone.
// The page texts below are written for these tests (SAMPLE numbers); they copy only the layout labs use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLab, reportCheckUrl, cleanReportNumber, parseLabPage, compareLab, normalizeColor, normalizeClarity, shapeKey,
  normalizeGrowth, LABS,
} from '../../src/core/labs/index.js';

// GIA style: each label on its own line, a short definition, then the value.
const GIA_PAGE = `GIA Report Check
REPORT DETAIL
GIA Report Number
The unique number of this report
5512345678
Date of Issue
March 03, 2026
Laboratory-Grown Diamond Report
Shape and Cutting Style
The outline and facet arrangement
Round Brilliant
Measurements
6.41 - 6.43 x 3.97 mm
Carat Weight
Weight given in carats
1.01 carat
Color
A grade on the D-to-Z scale
F
Clarity
VS1
Clarity Characteristics
Crystal, Feather
Comments
This is a man-made diamond produced by CVD growth process. It may have been treated after growth.`;

// IGI style: upper case, label and value on one line.
const IGI_PAGE = `VERIFY YOUR REPORT
REPORT NUMBER   LG612345678
DESCRIPTION   LABORATORY GROWN DIAMOND
SHAPE AND CUTTING STYLE   ROUND BRILLIANT
CARAT WEIGHT   1.50 CARATS
COLOR GRADE   E
CLARITY GRADE   VS 1
This Laboratory Grown Diamond was created by High Pressure High Temperature (HPHT) growth process.`;

// HRD style: "N°", colons, European decimal comma, "Colour", "LC" clarity.
const HRD_PAGE = `Find Diamond
N° 260000012345
Shape: Round Brilliant
Carat: 0,72 ct
Colour: E (Rare White+)
Clarity: LC
The stone in accordance with the mentioned number has been identified as a natural gem diamond.`;

// GCAL style: lab name inside the certificate number, dot leaders.
const GCAL_PAGE = `Certificate Search
Certificate # ........ GCAL LG300000001
Shape ........ Emerald Step
Weight ........ 1.58ct
Color ........ F
Clarity ........ VS1
Laboratory Grown Diamond`;

// ---------- detectLab ----------

test('detectLab prefers the lab name, then a prefix, then the number shape', () => {
  assert.equal(detectLab('523456789', 'GIA'), 'GIA', 'the hint wins over the number shape');
  assert.equal(detectLab('LG300000001', 'Gem Certification & Assurance Lab'), 'GCAL');
  assert.equal(detectLab('', 'International Gemological Institute'), 'IGI');
  assert.equal(detectLab(null, 'Gemological Institute of America'), 'GIA');
  assert.equal(detectLab('1234', 'HRD Antwerp'), 'HRD');
  assert.equal(detectLab('GIA 5512345678'), 'GIA');
  assert.equal(detectLab('IGI LG612345678'), 'IGI');
  assert.equal(detectLab('GCAL LG300000001'), 'GCAL');
  assert.equal(detectLab('5512345678'), 'GIA', '10 digits');
  assert.equal(detectLab('260000012345'), 'HRD', '12 digits');
  assert.equal(detectLab('612345678'), 'IGI', '9 digits');
  assert.equal(detectLab('LG612345678'), 'IGI', 'LG + digits');
  assert.equal(detectLab('12345'), null);
  assert.equal(detectLab(''), null);
  assert.equal(detectLab(undefined, 'some local lab'), null);
  // A lab the papers name but that has no online check is never taken for GIA because of the number's shape.
  assert.equal(detectLab('7391020001', 'Northbridge Gem Laboratory (SAMPLE)'), null);
  assert.equal(detectLab('7391020001', 'NGL'), null);
  assert.equal(detectLab('7391020001', null), 'GIA', 'no lab named: the number shape is the only clue');
});

// ---------- report-check links ----------

test('reportCheckUrl builds each lab link and cleans the number', () => {
  assert.equal(reportCheckUrl('GIA', 'GIA No. 5512 345 678'), 'https://www.gia.edu/report-check?reportno=5512345678');
  assert.equal(reportCheckUrl('igi', 'LG-612345678'), 'https://www.igi.org/Verify-Your-Report/?r=LG612345678');
  assert.equal(reportCheckUrl('HRD', '260000012345'), 'https://my.hrdantwerp.com/?record_number=260000012345');
  assert.equal(reportCheckUrl('GCAL', 'LG300000001'),
    'https://www.gcalusa.com/certificate-search.html?certificate_id=LG300000001');
  assert.equal(reportCheckUrl('GIA', ''), LABS.GIA.landingUrl, 'no number: the report-check page');
  assert.equal(reportCheckUrl('XYZ', '123'), null);
  assert.equal(reportCheckUrl(null, '123'), null);
});

test('cleanReportNumber keeps letters and digits and drops lab names and "No."', () => {
  assert.equal(cleanReportNumber('GIA2141438171'), '2141438171');
  assert.equal(cleanReportNumber('Report No: 5512345678'), '5512345678');
  assert.equal(cleanReportNumber('IGI LG-612 345 678'), 'LG612345678');
  assert.equal(cleanReportNumber('HRD Antwerp 260000012345'), '260000012345');
  assert.equal(cleanReportNumber(5512345678), '5512345678');
  assert.equal(cleanReportNumber(null), '');
});

test('every lab says whether its link pattern was confirmed', () => {
  for (const lab of Object.values(LABS)) {
    assert.equal(typeof lab.urlConfirmed, 'boolean');
    assert.match(lab.checkUrl, /^https:\/\//);
    assert.match(lab.landingUrl, /^https:\/\//);
  }
});

// ---------- parseLabPage ----------

test('parseLabPage reads a GIA style page with definitions between label and value', () => {
  const parsed = parseLabPage('GIA', GIA_PAGE);
  assert.equal(parsed.found, true);
  assert.equal(parsed.lab, 'GIA');
  assert.equal(parsed.reportNumber, '5512345678');
  assert.equal(parsed.reportDate, 'March 03, 2026');
  assert.equal(parsed.carat, 1.01);
  assert.equal(parsed.color, 'F', 'the "D-to-Z" definition is not read as a colour');
  assert.equal(parsed.clarity, 'VS1');
  assert.equal(parsed.shape, 'Round Brilliant');
  assert.equal(parsed.growth, 'lab-grown');
  assert.equal(parsed.growthMethod, 'CVD');
});

test('parseLabPage reads an IGI style page with values on the label line', () => {
  const parsed = parseLabPage('IGI', IGI_PAGE);
  assert.equal(parsed.found, true);
  assert.equal(parsed.reportNumber, 'LG612345678');
  assert.equal(parsed.carat, 1.5);
  assert.equal(parsed.color, 'E');
  assert.equal(parsed.clarity, 'VS1', '"VS 1" is tidied');
  assert.equal(parsed.shape, 'ROUND BRILLIANT');
  assert.equal(parsed.growth, 'lab-grown');
  assert.equal(parsed.growthMethod, 'HPHT');
});

test('parseLabPage reads an HRD style page (N°, comma decimals, Colour)', () => {
  const parsed = parseLabPage('HRD', HRD_PAGE);
  assert.equal(parsed.found, true);
  assert.equal(parsed.reportNumber, '260000012345');
  assert.equal(parsed.carat, 0.72);
  assert.equal(parsed.color, 'E');
  assert.equal(parsed.clarity, 'LC');
  assert.equal(parsed.growth, 'natural');
  assert.equal(parsed.growthMethod, null);
});

test('parseLabPage reads a GCAL style page with dot leaders', () => {
  const parsed = parseLabPage('GCAL', GCAL_PAGE);
  assert.equal(parsed.found, true);
  assert.equal(parsed.reportNumber, 'LG300000001');
  assert.equal(parsed.carat, 1.58);
  assert.equal(parsed.shape, 'Emerald Step');
  assert.equal(parsed.growth, 'lab-grown');
});

test('parseLabPage is tolerant to spacing and case in labels', () => {
  const parsed = parseLabPage('GIA', 'carat   weight :  2.03 Carats\nCOLOUR GRADE: g\nclarity grade - si 2\nshape & cutting style: oval brilliant');
  assert.equal(parsed.found, true);
  assert.equal(parsed.carat, 2.03);
  assert.equal(parsed.color, 'G');
  assert.equal(parsed.clarity, 'SI2');
  assert.equal(parsed.shape, 'oval brilliant');
  assert.equal(parsed.growth, null, 'no growth words: unknown, not assumed natural');
});

test('parseLabPage: a natural stone with an HPHT treatment comment is not called lab-grown', () => {
  const parsed = parseLabPage('GIA', 'Natural Diamond Grading Report\nCarat Weight\n0.90 carat\nColor\nH\nClarity\nVVS2\nComments: HPHT PROCESSED');
  assert.equal(parsed.growth, 'natural');
  assert.equal(parsed.growthMethod, null);
});

test('parseLabPage says not found, challenge or no result when there is no report', () => {
  const missing = parseLabPage('GIA', 'Report Check\nThe report number you entered could not be found. Please check the report number.');
  assert.deepEqual(missing, { found: false, lab: 'GIA', reason: 'not_found' });
  assert.equal(parseLabPage('IGI', 'No results found for LG000000000').reason, 'not_found');
  assert.equal(parseLabPage('HRD', 'Invalid report number').reason, 'not_found');
  assert.equal(parseLabPage('IGI', 'Just a moment...\nEnable JavaScript and cookies to continue').reason, 'challenge');
  assert.equal(parseLabPage('GIA', 'Loading...').reason, 'no_result');
  assert.equal(parseLabPage('GIA', '').found, false);
  assert.equal(parseLabPage('GIA', null).found, false);
});

// ---------- compareLab ----------

const SAMPLE_STONE = { reportNumber: '612345678', lab: 'IGI', shape: 'RBC', carat: 1.5, color: 'E', clarity: 'VS1',
  growth: 'lab-grown' };

test('compareLab: matching stone within the carat tolerance', () => {
  const result = compareLab({ ...SAMPLE_STONE, carat: 1.505 }, parseLabPage('IGI', IGI_PAGE));
  assert.equal(result.status, 'match');
  assert.deepEqual(result.diffs, []);
  assert.deepEqual(result.compared, ['reportNumber', 'carat', 'color', 'clarity', 'shape', 'growth']);
});

test('compareLab: every differing field is listed', () => {
  const ours = { reportNumber: '612345679', carat: 1.49, color: 'F', clarity: 'VS2', shape: 'Oval', growth: 'natural' };
  const result = compareLab(ours, parseLabPage('IGI', IGI_PAGE));
  assert.equal(result.status, 'mismatch');
  assert.deepEqual(result.diffs.map((diff) => diff.field), ['reportNumber', 'carat', 'color', 'clarity', 'shape', 'growth']);
  assert.deepEqual(result.diffs.find((diff) => diff.field === 'growth'), { field: 'growth', ours: 'natural', lab: 'lab-grown' });
  assert.deepEqual(result.diffs.find((diff) => diff.field === 'carat'), { field: 'carat', ours: 1.49, lab: 1.5 });
});

test('compareLab: an undeclared lab-grown stone is caught', () => {
  const result = compareLab({ carat: 1.01, color: 'F', clarity: 'VS1', growth: 'Natural' }, parseLabPage('GIA', GIA_PAGE));
  assert.equal(result.status, 'mismatch');
  assert.deepEqual(result.diffs, [{ field: 'growth', ours: 'natural', lab: 'lab-grown' }]);
});

test('compareLab: only fields known on both sides are compared', () => {
  const result = compareLab({ carat: '0.72' }, parseLabPage('HRD', HRD_PAGE));
  assert.equal(result.status, 'match');
  assert.deepEqual(result.compared, ['carat']);
  assert.equal(compareLab({ carat: 0.72 }, parseLabPage('GIA', 'not found')).status, 'not_found');
  assert.deepEqual(compareLab({ carat: 0.72 }, null), { status: 'not_found', diffs: [], compared: [] });
});

test('compareLab: carat tolerance is 0.005', () => {
  const parsed = { found: true, carat: 1.0 };
  assert.equal(compareLab({ carat: 1.005 }, parsed).status, 'match');
  assert.equal(compareLab({ carat: 0.995 }, parsed).status, 'match');
  assert.equal(compareLab({ carat: 1.006 }, parsed).status, 'mismatch');
});

test('colour, clarity, shape and growth normalization', () => {
  assert.equal(normalizeColor('f'), 'F');
  assert.equal(normalizeColor('F colour'), 'F');
  assert.equal(normalizeColor('E (Rare White+)'), 'E');
  assert.equal(normalizeColor('w - x'), 'W-X');
  assert.equal(normalizeColor('Fancy  Intense Yellow'), 'FANCY INTENSE YELLOW');
  assert.equal(normalizeClarity('vs 1'), 'VS1');
  assert.equal(normalizeClarity('VVS-2'), 'VVS2');
  assert.equal(normalizeClarity('LC'), 'IF', 'HRD loupe clean = internally flawless');
  assert.equal(normalizeClarity('Flawless'), 'FL');
  assert.equal(normalizeClarity('P1'), 'I1');
  assert.equal(shapeKey('Round Brilliant'), 'ROUND');
  assert.equal(shapeKey('RBC'), 'ROUND');
  assert.equal(shapeKey('Square Modified Brilliant'), 'PRINCESS');
  assert.equal(shapeKey('Cut-Cornered Rectangular Modified Brilliant'), 'RADIANT');
  assert.equal(shapeKey('Cut-Cornered Square Step Cut'), 'ASSCHER');
  assert.equal(shapeKey('Cushion Modified Brilliant'), 'CUSHION');
  assert.equal(shapeKey('Emerald Step'), 'EMERALD');
  assert.equal(shapeKey('PS'), 'PEAR');
  assert.equal(shapeKey('Briolette'), null);
  assert.equal(normalizeGrowth('LGD'), 'lab-grown');
  assert.equal(normalizeGrowth('CVD'), 'lab-grown');
  assert.equal(normalizeGrowth('Laboratory-Grown'), 'lab-grown');
  assert.equal(normalizeGrowth('natural'), 'natural');
  assert.equal(normalizeGrowth('HPHT treated natural'), 'natural');
  assert.equal(normalizeGrowth(''), null);
  assert.equal(normalizeGrowth(null), null);
});

test('compareLab: shape is a loose match', () => {
  const parsed = { found: true, shape: 'Round Brilliant' };
  assert.equal(compareLab({ shape: 'RD' }, parsed).status, 'match');
  assert.equal(compareLab({ shape: 'round' }, parsed).status, 'match');
  assert.equal(compareLab({ shape: 'Pear' }, parsed).status, 'mismatch');
  assert.equal(compareLab({ shape: 'Briolette drop' }, { found: true, shape: 'Briolette' }).status, 'match');
});
