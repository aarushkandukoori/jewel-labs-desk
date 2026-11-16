// Grading reports from Northbridge Gem Laboratory (SAMPLE), a made-up lab with its own simple design.
// One stone per report: results on the left, a proportions sketch and clarity plot on the right,
// colour and clarity scales across the page, a QR code to an example.com address at the bottom.
import {
  newPdf, addPage, paperDate, write, paragraph, rect, line, svg, roundStamp, sign, qr, guilloche, markPage, rgb,
  A4, INK, GREY,
} from './kit.js';
import { LAB, longDate, carats } from './facts.js';

const TEAL = rgb(0.04, 0.33, 0.37);
const TEAL_LIGHT = rgb(0.85, 0.92, 0.92);
const VIOLET = rgb(0.36, 0.2, 0.52); // lab-grown reports use violet so they are easy to tell apart
const RED = rgb(0.78, 0.12, 0.12);
const GREEN = rgb(0.1, 0.5, 0.25);

const COLOUR_SCALE = [
  ['Colourless', ['D', 'E', 'F']],
  ['Near colourless', ['G', 'H', 'I', 'J']],
  ['Faint', ['K', 'L', 'M']],
  ['Very light', ['N-R']],
  ['Light', ['S-Z']],
];
const CLARITY_SCALE = [
  ['Flawless', ['FL', 'IF']],
  ['Very very slightly included', ['VVS1', 'VVS2']],
  ['Very slightly included', ['VS1', 'VS2']],
  ['Slightly included', ['SI1', 'SI2']],
  ['Included', ['I1', 'I2', 'I3']],
];

/** The labelled results, in the order the report prints them. */
export function reportRows(stone, { labGrown }) {
  const rows = [
    ['Report Date', longDate(stone.reportDate)],
    ['Report Number', stone.report],
    ['Shape and Cutting Style', stone.labShape],
    ['Measurements', stone.measurements],
    ['Carat Weight', `${carats(stone.labCarat ?? stone.carat)} carat`],
    ['Colour Grade', stone.color],
    ['Clarity Grade', stone.clarity],
  ];
  if (stone.cut) rows.push(['Cut Grade', stone.cut]);
  const more = [
    ['Polish', stone.polish],
    ['Symmetry', stone.symmetry],
    ['Fluorescence', stone.fluorescence],
    ['Inscription(s)', `${labGrown ? 'LAB-GROWN ' : ''}${LAB.short} ${stone.report}`],
    ['Origin', labGrown ? 'Laboratory-grown diamond' : 'Natural diamond'],
  ];
  if (labGrown) more.push(['Growth Method', 'CVD']);
  return { results: rows, additional: more };
}

/** One grading report as PDF bytes. */
export async function buildLabReport(stone, { labGrown = false } = {}) {
  const accent = labGrown ? VIOLET : TEAL;
  const { pdf, fonts } = await newPdf({
    title: `${LAB.name} report ${stone.report}`, author: LAB.name, date: paperDate(stone.reportDate, '15:20:00'),
  });
  const page = addPage(pdf);

  // Frame and a light security pattern across the top.
  rect(page, 28, 28, A4.width - 56, 778, { stroke: accent, lineWidth: 0.9 });
  rect(page, 31.5, 31.5, A4.width - 63, 771, { stroke: accent, lineWidth: 0.3 });
  guilloche(page, { x: 32, y: 32, w: A4.width - 64, h: 76, color: labGrown ? rgb(0.92, 0.89, 0.95) : TEAL_LIGHT, seed: Number(stone.report.slice(-4)) });

  // Header: hexagon mark, lab name, report number.
  svg(page, hexagon(17, 25, 17) + hexagon(17, 25, 10), 48, 34, { stroke: accent, lineWidth: 1.4 });
  write(page, LAB.name.toUpperCase(), 92, 60, { font: fonts.sansBold, size: 13, color: accent });
  write(page, `Independent diamond grading   |   ${LAB.address}`, 92, 73, { font: fonts.sans, size: 7.5, color: GREY });
  write(page, 'Report Number', A4.width - 48 - 150, 54, { font: fonts.sans, size: 7.5, color: GREY, align: 'right', width: 150 });
  write(page, stone.report, A4.width - 48 - 150, 72, { font: fonts.monoBold, size: 15, align: 'right', width: 150 });

  rect(page, 32, 112, A4.width - 64, 24, { fill: accent });
  write(page, labGrown ? 'LABORATORY-GROWN DIAMOND REPORT' : 'DIAMOND GRADING REPORT', 48, 128, { font: fonts.sansBold, size: 12, color: rgb(1, 1, 1) });
  write(page, labGrown ? 'LABORATORY-GROWN' : 'NATURAL DIAMOND', A4.width - 48 - 200, 128,
    { font: fonts.sansBold, size: 9, color: rgb(1, 1, 1), align: 'right', width: 200 });

  // Results on the left.
  const { results, additional } = reportRows(stone, { labGrown });
  let y = sectionTitle(page, fonts, 'GRADING RESULTS', 48, 162, 262, accent);
  y = resultRows(page, fonts, results, 48, y);
  y = sectionTitle(page, fonts, 'ADDITIONAL GRADING INFORMATION', 48, y + 10, 262, accent);
  y = resultRows(page, fonts, additional, 48, y);
  write(page, 'Comments:', 48, y + 6, { font: fonts.sans, size: 8, color: GREY });
  const commentsEnd = paragraph(page, labGrown
    ? 'This is a laboratory-grown diamond produced by CVD (chemical vapour deposition). It shows no evidence of post-growth treatment.'
    : 'Clouds are not shown. Pinpoints are not shown.', 100, y + 6, { font: fonts.sans, size: 8, width: 210, lineHeight: 10 });

  // Proportions and clarity plot on the right.
  const right = 340;
  sectionTitle(page, fonts, 'PROPORTIONS', right, 162, 207, accent);
  proportions(page, fonts, stone, right + 18, 180);
  sectionTitle(page, fonts, 'CLARITY CHARACTERISTICS', right, 310, 207, accent);
  const plot = outlineFor(stone.shapeKey);
  svg(page, plot, right + 22, 326, { stroke: INK, lineWidth: 0.7 });
  svg(page, plot, right + 122, 326, { stroke: INK, lineWidth: 0.7 });
  svg(page, 'M30 30 a2.2 2.2 0 1 0 0.1 0 Z M58 52 l7 -5', right + 22, 326, { stroke: RED, lineWidth: 0.9 });
  svg(page, 'M40 62 l9 4', right + 122, 326, { stroke: GREEN, lineWidth: 0.9 });
  write(page, 'Key to symbols:', right, 426, { font: fonts.sans, size: 7.5, color: GREY });
  svg(page, 'M4 -3 a2 2 0 1 0 0.1 0 Z', right + 60, 426, { stroke: RED, lineWidth: 0.9 });
  write(page, 'Crystal', right + 70, 426, { font: fonts.sans, size: 7.5 });
  svg(page, 'M0 -2 l7 -4', right + 105, 426, { stroke: RED, lineWidth: 0.9 });
  write(page, 'Feather', right + 116, 426, { font: fonts.sans, size: 7.5 });
  svg(page, 'M0 -4 l8 3', right + 152, 426, { stroke: GREEN, lineWidth: 0.9 });
  write(page, 'Needle', right + 164, 426, { font: fonts.sans, size: 7.5 });

  // Grading scales across the page, below whichever column ends lower.
  const scaleTop = Math.max(480, commentsEnd + 30);
  scale(page, fonts, 'COLOUR SCALE', COLOUR_SCALE, stone.color, 48, scaleTop, accent);
  scale(page, fonts, 'CLARITY SCALE', CLARITY_SCALE, stone.clarity, 48, scaleTop + 76, accent);

  // Verification and signature.
  qr(page, LAB.verifyUrl + stone.report, 48, 650, 70);
  write(page, 'Check this report online', 130, 664, { font: fonts.sansBold, size: 8.5 });
  write(page, `${LAB.verifyUrl}${stone.report}`, 130, 677, { font: fonts.sans, size: 7.5, color: GREY });
  write(page, 'Scan the code or type the address. The online record must match this paper.', 130, 690, { font: fonts.sans, size: 7.5, color: GREY });
  roundStamp(page, { cx: A4.width - 150, cy: 682, r: 30, top: 'NORTHBRIDGE GEM LAB', bottom: 'SAMPLE * MUMBAI', middle: ['GRADED'],
    color: accent, rotate: 8, opacity: 0.55 });
  sign(page, A4.width - 128, 700, { seed: Number(stone.report.slice(-6)), width: 72, height: 14 });
  line(page, A4.width - 200, 712, A4.width - 48, 712, { width: 0.5, color: GREY });
  write(page, 'Laboratory director', A4.width - 200, 724, { font: fonts.sans, size: 7.5, color: GREY });

  paragraph(page, 'This report describes the diamond as examined on the report date with the methods of the laboratory at '
    + 'that time. It is a fictional sample made for the Jewel Labs demo: Northbridge Gem Laboratory (SAMPLE) is not a real '
    + 'laboratory and this is not a real grading report.', 48, 758, { font: fonts.sans, size: 7, width: A4.width - 96, color: GREY, lineHeight: 9 });
  markPage(page, fonts);
  return pdf.save();
}

function sectionTitle(page, fonts, title, x, y, width, color) {
  write(page, title, x, y, { font: fonts.sansBold, size: 8.5, color });
  line(page, x, y + 4, x + width, y + 4, { color, width: 0.8 });
  return y + 20;
}

// "Label ........ value" rows; the dots are drawn as shapes so they stay out of the text.
function resultRows(page, fonts, rows, x, y) {
  rows.forEach(([label, value], i) => {
    const baseline = y + i * 16.5;
    write(page, label, x, baseline, { font: fonts.sans, size: 8.5 });
    const from = x + fonts.sans.widthOfTextAtSize(label, 8.5) + 4;
    line(page, from, baseline, x + 146, baseline, { color: GREY, width: 0.6, dash: [0.6, 2.4] });
    write(page, value, x + 152, baseline, { font: fonts.sansBold, size: 9 });
  });
  return y + rows.length * 16.5;
}

function hexagon(cx, cy, r) {
  const points = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    points.push(`${(cx + r * Math.cos(angle)).toFixed(2)} ${(cy + r * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join(' L')} Z `;
}

// Side view of the stone with table and depth percentages.
function proportions(page, fonts, stone, x, y) {
  const profile = 'M0 30 L32 14 L92 14 L124 30 L62 92 Z M0 30 H124 M32 14 L50 30 L62 14 L74 30 L92 14';
  svg(page, profile, x + 20, y, { stroke: INK, lineWidth: 0.8 });
  line(page, x + 52, y + 8, x + 112, y + 8, { width: 0.4 });
  write(page, stone.table, x + 72, y + 4, { font: fonts.sans, size: 7.5 });
  line(page, x + 160, y + 14, x + 160, y + 92, { width: 0.4 });
  write(page, stone.depth, x + 165, y + 56, { font: fonts.sans, size: 7.5 });
  write(page, 'Girdle: medium, faceted   |   Culet: none', x, y + 108, { font: fonts.sans, size: 7.5, color: GREY });
}

// A simple top-view outline for each shape, in an 80 x 80 box.
function outlineFor(shape) {
  switch (shape) {
    case 'Oval':
      return 'M40 4 C64 4 72 22 72 40 C72 58 64 76 40 76 C16 76 8 58 8 40 C8 22 16 4 40 4 Z M40 22 C52 22 56 32 56 40 C56 48 52 58 40 58 C28 58 24 48 24 40 C24 32 28 22 40 22 Z';
    case 'Princess':
      return 'M6 6 H74 V74 H6 Z M22 22 H58 V58 H22 Z M6 6 L22 22 M74 6 L58 22 M74 74 L58 58 M6 74 L22 58';
    case 'Emerald':
      return 'M18 6 H62 L72 16 V64 L62 74 H18 L8 64 V16 Z M24 16 H56 L62 22 V58 L56 64 H24 L18 58 V22 Z M30 26 H50 L52 28 V52 L50 54 H30 L28 52 V28 Z';
    case 'Cushion':
      return 'M20 6 H60 C70 6 74 10 74 20 V60 C74 70 70 74 60 74 H20 C10 74 6 70 6 60 V20 C6 10 10 6 20 6 Z M26 26 H54 V54 H26 Z M6 20 L26 26 M74 20 L54 26 M74 60 L54 54 M6 60 L26 54';
    case 'Pear':
      return 'M40 2 C52 20 72 38 72 54 C72 70 58 78 40 78 C22 78 8 70 8 54 C8 38 28 20 40 2 Z M40 24 C48 36 58 46 58 56 C58 64 50 68 40 68 C30 68 22 64 22 56 C22 46 32 36 40 24 Z';
    default: // round
      return 'M40 4 A36 36 0 1 0 40.01 4 Z M40 20 L54 26 L60 40 L54 54 L40 60 L26 54 L20 40 L26 26 Z M40 4 L40 20 M72 30 L60 40 M40 76 L40 60 M8 50 L20 40';
  }
}

// A grading scale: groups of grades in cells, the stone's grade filled in.
function scale(page, fonts, title, groups, grade, x, y, accent) {
  write(page, title, x, y, { font: fonts.sansBold, size: 8.5, color: accent });
  const cells = groups.flatMap(([, grades]) => grades);
  const width = (A4.width - 96) / cells.length;
  let index = 0;
  for (const [name, grades] of groups) {
    const groupX = x + index * width;
    write(page, name, groupX, y + 16, { font: fonts.sans, size: 6.5, color: GREY, align: 'center', width: grades.length * width });
    for (const g of grades) {
      const cellX = x + index * width;
      const isGrade = g === grade || (g.includes('-') && grade.length === 1 && inRange(grade, g));
      rect(page, cellX, y + 22, width, 18, { fill: isGrade ? accent : undefined, stroke: GREY, lineWidth: 0.5 });
      write(page, g, cellX, y + 34, { font: fonts.sansBold, size: 8, color: isGrade ? rgb(1, 1, 1) : INK, align: 'center', width });
      index += 1;
    }
  }
  return y + 46;
}

function inRange(grade, range) {
  const [from, to] = range.split('-');
  return grade >= from && grade <= to;
}
