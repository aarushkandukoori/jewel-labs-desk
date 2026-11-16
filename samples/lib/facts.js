// Every fact in the SAMPLE shipment, in one place. The papers are drawn from these facts and
// answers.json is written from them, so the answer key always matches the papers.
//
// Everything here is fictional: companies carry "(SAMPLE)" in their names, phone numbers use 555,
// emails use example.com, and the grading lab, the KP office and the customs station do not exist.

export const FOOTER = 'Fictional sample document for the Jewel Labs demo';

// ---------- the house (the exporter that uses the app) ----------

export const HOUSE = {
  name: 'Kavya Gems LLP (SAMPLE)',
  lines: ['Plot 12, Sample Diamond Park, Katargam', 'Surat 395004, Gujarat, India'],
  address: 'Plot 12, Sample Diamond Park, Katargam, Surat 395004, Gujarat, India',
  country: 'India',
  iec: 'SAMPLE00012',
  email: 'ops@kavya-gems.example.com',
  phone: '+91 555 010 0012',
};

// ---------- other companies ----------

export const BUYER_EU = {
  name: 'Lumen Diamant BV (SAMPLE)',
  lines: ['Hoveniersstraat 99', '2018 Antwerpen, Belgium'],
  address: 'Hoveniersstraat 99, 2018 Antwerpen, Belgium',
  country: 'Belgium',
  eori: 'BE0999999999',
  email: 'buying@lumen-diamant.example.com',
  phone: '+32 3 555 01 99',
};

export const BUYER_UAE = {
  name: 'Mirage Crystals FZCO (SAMPLE)',
  lines: ['Unit 7, Sample Free Zone Tower', 'Dubai Airport Free Zone, Dubai, United Arab Emirates'],
  address: 'Unit 7, Sample Free Zone Tower, Dubai Airport Free Zone, Dubai, United Arab Emirates',
  country: 'United Arab Emirates',
  email: 'trade@mirage-crystals.example.com',
  phone: '+971 4 555 0142',
};

export const BUYER_US = {
  name: 'Hudson Fine Jewels Inc. (SAMPLE)',
  lines: ['120 Sample Avenue, Suite 1500', 'New York, NY 10036, United States'],
  address: '120 Sample Avenue, Suite 1500, New York, NY 10036, United States',
  country: 'United States',
  email: 'imports@hudson-fine.example.com',
  phone: '+1 212 555 0143',
};

export const ROUGH_SUPPLIER = {
  name: 'Sample Rough Trading DMCC (SAMPLE)',
  lines: ['Office 1204, Sample Gem Tower', 'Dubai, United Arab Emirates'],
  address: 'Office 1204, Sample Gem Tower, Dubai, United Arab Emirates',
  country: 'United Arab Emirates',
  email: 'sales@sample-rough.example.com',
  phone: '+971 4 555 0177',
  licence: 'DMCC-SAMPLE-30412',
};

// A made-up grading lab with its own simple report design (no real lab look-alike).
export const LAB = {
  name: 'Northbridge Gem Laboratory (SAMPLE)',
  short: 'NGL',
  address: 'Unit 5, Sample Gem Plaza, Mumbai 400051, India',
  verifyUrl: 'https://verify.northbridge-lab.example.com/r/',
};

export const LOGISTICS = {
  name: 'Sample Secure Logistics LLP (SAMPLE)',
  city: 'Mumbai',
  address: 'Office 21, Sample Bourse, Mumbai 400051, India',
  iata: '14-3-SAMPLE',
};

export const INSURER = {
  name: 'Sample Specie Insurance Co. Ltd (SAMPLE)',
  address: 'Sample House, 8 Example Road, Mumbai 400001, India',
  phone: '+91 555 010 0400',
  claimsAgent: 'Sample Claims Agent BV (SAMPLE), Antwerp',
};

export const BROKER = { name: 'Sample Clearing Agents Pvt Ltd (SAMPLE)', licence: 'CHA/SAMPLE/0099' };

export const CUSTOMS = {
  name: 'Sample Diamond Bourse Customs Station (SAMPLE)',
  city: 'Mumbai',
  portCode: 'INSMP1',
};

export const KP_OFFICE = { name: 'Sample KP Office (SAMPLE)', city: 'Dubai, United Arab Emirates' };

// ---------- the rough: where shipment A's stones came from ----------

export const KP = {
  number: 'AE-SAMPLE-0001234',
  exportingCountry: 'United Arab Emirates',
  importingCountry: 'India',
  countriesOfMining: ['Botswana', 'Namibia'],
  issued: '2026-03-02',
  expires: '2026-04-01',
  hsCode: '7102.31',
  carats: 12.8,
  value: 22400,
  parcels: 1,
};

export const SUPPLIER_INVOICE = {
  number: 'SRT-2026-0315',
  date: '2026-03-15',
  memoDate: '2026-03-02', // goods went out on memo with the KP certificate; invoiced once approved
  lot: 'R-0412',
  pieces: 14,
  carats: 12.8,
  rate: 1750,
  value: 22400,
  hsCode: '71023100',
};

export const FACTORY = {
  lot: 'R-0412',
  roughCarats: 12.8,
  roughPieces: 14,
  recordDate: '2026-07-08',
  polishMonths: '2026-06 / 2026-07',
  unit: 'Katargam unit, Surat',
};

// ---------- shipment A: Antwerp, natural polished, needs the EU statement ----------

// carat: what the invoice and packing list say. labCarat: what the lab report says (only when it differs).
// actual: the factory's polished weight. planned: what the factory planned from the rough.
const STONES_A = [
  {
    line: 1, report: '7391020001', shape: 'Round brilliant', shapeKey: 'Round', labShape: 'Round Brilliant',
    carat: 1.02, actual: 1.02, planned: 1.05, color: 'D', clarity: 'VVS1', rate: 14800,
    cut: 'Excellent', polish: 'Excellent', symmetry: 'Excellent', fluorescence: 'None',
    measurements: '6.43 - 6.46 x 3.99 mm', table: '57%', depth: '61.9%', reportDate: '2026-07-14',
    polishedOn: '2026-06-18', roughPiece: 'R-0412-03',
  },
  {
    line: 2, report: '7391020002', shape: 'Oval', shapeKey: 'Oval', labShape: 'Oval Brilliant',
    carat: 0.71, labCarat: 0.7, actual: 0.7, planned: 0.75, color: 'F', clarity: 'VS1', rate: 4650,
    cut: null, polish: 'Excellent', symmetry: 'Very Good', fluorescence: 'Faint',
    measurements: '7.12 x 5.04 x 3.11 mm', table: '58%', depth: '61.7%', reportDate: '2026-07-14',
    polishedOn: '2026-06-22', roughPiece: 'R-0412-07',
  },
  {
    line: 3, report: '7391020003', shape: 'Princess', shapeKey: 'Princess', labShape: 'Princess Cut',
    carat: 0.52, actual: 0.52, planned: 0.55, color: 'G', clarity: 'VS2', rate: 2350,
    cut: null, polish: 'Very Good', symmetry: 'Very Good', fluorescence: 'None',
    measurements: '4.48 x 4.41 x 3.30 mm', table: '68%', depth: '74.8%', reportDate: '2026-07-16',
    polishedOn: '2026-06-25', roughPiece: 'R-0412-02',
  },
  {
    // Below 0.50 ct: no grading report, on purpose.
    line: 4, report: null, shape: 'Round brilliant', shapeKey: 'Round', labShape: null,
    carat: 0.45, actual: 0.45, planned: 0.48, color: 'E', clarity: 'SI1', rate: 2100,
    polishedOn: '2026-06-25', roughPiece: 'R-0412-02',
  },
  {
    // This report reaches the desk only as a phone photo of the printed report.
    line: 5, report: '7391020005', shape: 'Emerald', shapeKey: 'Emerald', labShape: 'Emerald Cut',
    carat: 1.5, actual: 1.5, planned: 1.55, color: 'H', clarity: 'VVS2', rate: 7900,
    cut: null, polish: 'Excellent', symmetry: 'Excellent', fluorescence: 'None',
    measurements: '7.85 x 5.62 x 3.71 mm', table: '64%', depth: '66.0%', reportDate: '2026-07-21',
    polishedOn: '2026-07-02', roughPiece: 'R-0412-11', photoOnly: true,
  },
  {
    line: 6, report: '7391020006', shape: 'Cushion', shapeKey: 'Cushion', labShape: 'Cushion Modified Brilliant',
    carat: 0.9, actual: 0.9, planned: 0.92, color: 'E', clarity: 'VS1', rate: 5400,
    cut: null, polish: 'Excellent', symmetry: 'Very Good', fluorescence: 'Medium Blue',
    measurements: '5.71 x 5.30 x 3.48 mm', table: '62%', depth: '65.7%', reportDate: '2026-07-21',
    polishedOn: '2026-07-06', roughPiece: 'R-0412-05',
  },
];

// ---------- shipment B: Dubai, lab-grown polished, two lots ----------

// Each lot holds one graded stone, invoiced on its own line, so every report number is on the invoice.
const STONES_B = [
  {
    line: 1, lot: 1, report: null, description: 'Lab-grown CVD polished, lot 1', shape: 'Round brilliant', shapeKey: 'Round',
    pieces: 119, carat: 94.88, color: 'E-G', clarity: 'VS1-VS2', rate: 85, growth: 'lab-grown',
  },
  {
    line: 2, lot: 1, report: '7392040011', description: 'Lab-grown CVD polished, lot 1', shape: 'Round brilliant',
    shapeKey: 'Round', labShape: 'Round Brilliant', pieces: 1, carat: 1.52, color: 'E', clarity: 'VS1', rate: 120,
    growth: 'lab-grown', cut: 'Excellent', polish: 'Excellent', symmetry: 'Excellent', fluorescence: 'None',
    measurements: '7.36 - 7.40 x 4.55 mm', table: '56%', depth: '61.6%', reportDate: '2026-10-20',
  },
  {
    line: 3, lot: 2, report: null, description: 'Lab-grown CVD polished, lot 2', shape: 'Oval', shapeKey: 'Oval',
    pieces: 79, carat: 59.97, color: 'F-H', clarity: 'VS2-SI1', rate: 70, growth: 'lab-grown',
  },
  {
    line: 4, lot: 2, report: '7392040012', description: 'Lab-grown CVD polished, lot 2', shape: 'Oval', shapeKey: 'Oval',
    labShape: 'Oval Brilliant', pieces: 1, carat: 1.18, color: 'F', clarity: 'VS2', rate: 95, growth: 'lab-grown',
    cut: null, polish: 'Excellent', symmetry: 'Very Good', fluorescence: 'None',
    measurements: '8.71 x 6.12 x 3.80 mm', table: '59%', depth: '62.1%', reportDate: '2026-10-20',
  },
];

// ---------- shipment C: New York, natural polished, two stones ----------

const STONES_C = [
  {
    line: 1, report: '7391030001', shape: 'Round brilliant', shapeKey: 'Round', labShape: 'Round Brilliant',
    carat: 1.21, color: 'F', clarity: 'VS2', rate: 8200, cut: 'Very Good', polish: 'Excellent', symmetry: 'Very Good',
    fluorescence: 'Faint', measurements: '6.82 - 6.86 x 4.21 mm', table: '58%', depth: '61.6%', reportDate: '2026-09-03',
  },
  {
    line: 2, report: '7391030002', shape: 'Pear', shapeKey: 'Pear', labShape: 'Pear Brilliant',
    carat: 0.8, color: 'G', clarity: 'VS1', rate: 4300, cut: null, polish: 'Very Good', symmetry: 'Very Good',
    fluorescence: 'None', measurements: '8.62 x 5.48 x 3.39 mm', table: '57%', depth: '61.9%', reportDate: '2026-09-03',
  },
];

export const SHIPMENTS = {
  A: {
    id: 'A',
    invoice: 'KG/26-27/041',
    fileRef: 'KG-26-27-041', // the invoice number as it can appear in a file name
    invoiceDate: '2026-11-10',
    buyer: BUYER_EU,
    destination: 'Belgium',
    destinationCode: 'BE',
    regime: 'EU',
    nature: 'natural',
    hsCode: '71023910',
    goods: 'Natural cut and polished diamonds',
    incoterm: 'CIF',
    incotermPlace: 'Antwerp',
    payment: '30 days from invoice date by T/T',
    po: { number: 'LDB-7781', date: '2026-11-09' },
    portOfLoading: 'Mumbai (BOM)',
    portOfDischarge: 'Brussels (BRU)',
    finalDestination: 'Antwerp, Belgium',
    stones: STONES_A,
    packingListDate: '2026-11-11',
    shippingBill: { number: '1234567', date: '2026-11-12', leoDate: '2026-11-12', leoNumber: '2611120457' },
    awb: {
      hawb: '99000012345', mawb: '176-12345678', date: '2026-11-13',
      legs: [{ flight: 'EK 501', from: 'BOM', to: 'DXB' }, { flight: 'EK 183', from: 'DXB', to: 'BRU' }],
      route: 'BOM-DXB-BRU', grossKg: 0.85, chargeableKg: 1.0, dims: '20 x 15 x 10 cm',
    },
    insurance: {
      certificate: 'SSI/CRT/26/1187', policy: 'SSI/OP/2026/0031', date: '2026-11-12', cover: 1.1,
    },
  },
  B: {
    id: 'B',
    invoice: 'KG/26-27/042',
    fileRef: 'KG-26-27-042',
    invoiceDate: '2026-11-11',
    buyer: BUYER_UAE,
    destination: 'United Arab Emirates',
    destinationCode: 'AE',
    regime: 'OTHER',
    nature: 'lab-grown',
    hsCode: '71049120',
    goods: 'Laboratory-grown (CVD) cut and polished diamonds',
    incoterm: 'CIF',
    incotermPlace: 'Dubai',
    payment: 'Advance payment by T/T',
    portOfLoading: 'Mumbai (BOM)',
    portOfDischarge: 'Dubai (DXB)',
    finalDestination: 'Dubai, United Arab Emirates',
    stones: STONES_B,
    shippingBill: { number: '1234602', date: '2026-11-13', leoDate: '2026-11-13', leoNumber: '2611130219' },
    awb: {
      hawb: '99000012367', mawb: '176-12345690', date: '2026-11-14',
      legs: [{ flight: 'EK 501', from: 'BOM', to: 'DXB' }],
      route: 'BOM-DXB', grossKg: 0.4, chargeableKg: 0.5, dims: '15 x 10 x 8 cm',
    },
  },
  C: {
    id: 'C',
    invoice: 'KG/26-27/043',
    fileRef: 'KG-26-27-043',
    invoiceDate: '2026-11-12',
    buyer: BUYER_US,
    destination: 'United States',
    destinationCode: 'US',
    regime: 'US',
    nature: 'natural',
    hsCode: '71023910',
    goods: 'Natural cut and polished diamonds',
    incoterm: 'CIF',
    incotermPlace: 'New York',
    payment: '45 days from invoice date by T/T',
    portOfLoading: 'Mumbai (BOM)',
    portOfDischarge: 'New York (JFK)',
    finalDestination: 'New York, United States',
    stones: STONES_C,
    awb: {
      hawb: '99000012389', mawb: '176-12345701', date: '2026-11-14',
      legs: [{ flight: 'EK 501', from: 'BOM', to: 'DXB' }, { flight: 'EK 201', from: 'DXB', to: 'JFK' }],
      route: 'BOM-DXB-JFK', grossKg: 0.3, chargeableKg: 0.5, dims: '15 x 10 x 8 cm',
    },
  },
};

// ---------- small helpers every paper uses ----------

/** Money is kept in cents so sums never drift: 1.02 ct x 14,800 = 15,096.00. */
export function lineAmount(stone) {
  return Math.round(stone.carat * stone.rate * 100) / 100;
}

/** Pieces, carats and value of a whole invoice. */
export function totals(shipment) {
  let pieces = 0;
  let caratsX100 = 0;
  let cents = 0;
  for (const stone of shipment.stones) {
    pieces += stone.pieces || 1;
    caratsX100 += Math.round(stone.carat * 100);
    cents += Math.round(lineAmount(stone) * 100);
  }
  return { pieces, carats: caratsX100 / 100, value: cents / 100 };
}

/** The factory's polished weight for the whole lot (its own scale, so 0.70 for stone 2, not 0.71). */
export function factoryTotal() {
  return STONES_A.reduce((sum, stone) => sum + Math.round(stone.actual * 100), 0) / 100;
}

/** "2026-11-10" -> "10/11/2026", the way Indian papers print dates. */
export function dmy(iso) {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];

/** "2026-07-14" -> "14 July 2026". */
export function longDate(iso) {
  const [year, month, day] = iso.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

/** "2026-11-13" -> "13 NOV 2026", as typed on air waybills. */
export function shortDate(iso) {
  const [year, month, day] = iso.split('-');
  return `${day} ${MONTHS[Number(month) - 1].slice(0, 3).toUpperCase()} ${year}`;
}

/** 37274.5 -> "37,274.50". */
export function money(value) {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 1.5 -> "1.50". Carats are always printed with two decimals. */
export function carats(value) {
  return value.toFixed(2);
}
