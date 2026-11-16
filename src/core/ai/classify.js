// Cheap document classifier: the file name plus keywords in the text. No AI.
// A document's own title near the top ("PACKING LIST", "Shipping Bill for Export") is the strongest clue.
// Confidence comes from how far the best type is ahead of the next one. Below 0.85 the AI is asked.

import { DOC_TYPE_LABELS } from '../types.js';

// titles: what the paper calls itself. cues: words usually printed inside it. names: file name hints.
// An invoice title must be a line on its own, because "Invoice No" is printed on almost every paper.
const RULES = [
  {
    type: 'shipping_bill',
    titles: [/shipping\s+bill\s+for\s+export/i, /\bshipping\s+bill\b/i, /let\s+export\s+order/i],
    cues: [/\bLEO\s*(?:date|no)/i, /\bICES\b/, /\bSB\s*No\b/i, /port\s+of\s+loading/i, /\bCHA\b/, /drawback|\bDBK\b/i, /\bIEC\b/],
    names: [/shipping[\s_-]*bill/i, /\bLEO\d*\b/i, /\bSB\b/i],
  },
  {
    type: 'bill_of_entry',
    titles: [/bill\s+of\s+entry/i],
    cues: [/\bBE\s*No\b/i, /home\s+consumption/i, /\bIGM\b/, /assessable\s+value/i, /\bduty\b/i],
    names: [/bill[\s_-]*of[\s_-]*entry/i, /\bBOE\b/i],
  },
  {
    type: 'air_waybill',
    titles: [/air\s*way\s*bill/i, /house\s+air\s*way\s*bill/i],
    cues: [/not\s+negotiable/i, /airport\s+of\s+(?:departure|destination)/i, /issuing\s+carrier/i, /\bHAWB\b/,
      /\bMAWB\b/, /shipper'?s\s+name\s+and\s+address/i, /chargeable\s+weight/i, /\b\d{3}-\d{4}\s?\d{4}\b/],
    names: [/\b[HM]?AWB\b/i, /air[\s_-]*way[\s_-]*bill/i],
  },
  {
    type: 'kp_certificate',
    titles: [/kimberley\s+process\s+certificate/i, /\bKP\s+certificate\b/i, /kimberley\s+process/i],
    cues: [/countr(?:y|ies)\s+of\s+(?:mining|origin)/i, /rough\s+diamonds?/i, /\b7102\.?(?:10|21|31)\b/,
      /exporting\s+authority/i, /importing\s+authority/i, /tamper[\s-]proof/i],
    names: [/\bKPC?\b/i, /kimberley/i],
  },
  {
    type: 'lab_report',
    titles: [/grading\s+report/i, /diamond\s+(?:dossier|report|certificate)/i, /laboratory[\s-]grown\s+diamond\s+report/i,
      /gemological\s+institute/i],
    cues: [/carat\s+weight/i, /colou?r\s+grade/i, /clarity\s+grade/i, /\bpolish\b/i, /\bsymmetry\b/i, /\bfluorescence\b/i,
      /\bmeasurements\b/i, /laboratory[\s-]grown/i, /\binscription/i, /\bLG\d{9}\b/, /\b(?:GIA|IGI|HRD|GCAL)\b/],
    names: [/^LG\d{6,}/i, /^\d{9,10}(?:\D|$)/, /\b(?:GIA|IGI|HRD|GCAL)\b/i, /\breport\b/i],
  },
  {
    type: 'packing_list',
    titles: [/(?<!cum\s)packing\s+list/i, /packing\s+slip/i],
    cues: [/gross\s+w(?:eigh)?t/i, /net\s+w(?:eigh)?t/i, /\bpcs\b/i, /\bshape\b/i, /\bclarity\b/i],
    names: [/packing/i, /\bPL\b/],
  },
  {
    type: 'proforma_invoice',
    titles: [/pro[\s-]?forma\s+invoice/i],
    cues: [/\bvalidity\b/i, /advance\s+payment/i],
    names: [/pro[\s_-]?forma/i, /\bPI\b/],
  },
  {
    type: 'commercial_invoice',
    titles: [/^\W*(?:commercial|export|tax|customs|sales|final)?\s*invoice\W*(?:cum\s+packing\s+list\W*)?$/im,
      /commercial\s+invoice/i, /export\s+invoice/i],
    cues: [/invoice\s*(?:no|number|#)/i, /terms\s+of\s+(?:payment|delivery)/i, /\b(?:FOB|CIF|CFR|CIP|DAP)\b/,
      /amount\s+in\s+words/i, /\btotal\b/i, /bank\s+details|swift/i],
    names: [/invoice/i, /\binv\b/i],
  },
  {
    type: 'supplier_invoice',
    titles: [/purchase\s+invoice/i, /supplier\s+invoice/i],
    cues: [],
    names: [/supplier/i, /purchase[\s_-]*inv/i],
  },
  {
    type: 'insurance_certificate',
    titles: [/certificate\s+of\s+insurance/i, /insurance\s+certificate/i, /evidence\s+of\s+insurance/i],
    cues: [/\bpolicy\s*(?:no|number)/i, /\binsured\b/i, /underwriter/i, /\bpremium\b/i, /sum\s+insured/i, /all\s+risks/i],
    names: [/insurance/i, /\bINS\b/i],
  },
  {
    type: 'purchase_order',
    titles: [/purchase\s+order/i],
    cues: [/\bPO\s*(?:no|number|#)/i, /delivery\s+date/i],
    names: [/purchase[\s_-]*order/i, /\bPO\b/],
  },
  {
    type: 'supplier_declaration',
    titles: [/system\s+of\s+warrant(?:y|ies)/i, /warranty\s+declaration/i, /supplier'?s?\s+declaration/i,
      /declaration\s+of\s+origin/i],
    cues: [/conflict[\s-]free/i, /legitimate\s+sources/i, /hereby\s+(?:declare|confirm|certify|guarantee)/i],
    names: [/declaration|warranty|\bSOW\b/i],
  },
  {
    type: 'g7_gf_declaration',
    titles: [/\bG7\b/, /grandfather(?:ed|ing)?/i, /\bGF\s+declaration/i],
    cues: [/diamond\s+office/i, /russian\s+(?:origin|federation)/i, /before\s+1\s+(?:march|september)/i],
    names: [/\bG7\b/i, /\bGF\b/i, /grandfather/i],
  },
  {
    type: 'factory_record',
    titles: [/factory\s+record/i, /manufactur(?:ing|e)\s+(?:record|report)/i, /assortment/i,
      /rough\s+(?:issue|receipt|purchase)\s+(?:register|record)/i, /production\s+(?:record|report)/i],
    cues: [/\bkapan\b/i, /\bmakeable\b/i, /\byield\b/i, /polished\s+output/i],
    names: [/factory|assort|manufactur|production/i],
  },
  {
    type: 'kyc_document',
    titles: [/trade\s+licen[cs]e/i, /certificate\s+of\s+incorporation/i, /import\s*[-/]?\s*export\s+code/i,
      /registration\s+certificate/i, /know\s+your\s+customer|\bKYC\b/i],
    cues: [/\bpassport\b/i, /\bGSTIN\b/i],
    names: [/kyc|licen[cs]e|passport|\bIEC\b|incorporation|registration/i],
  },
  {
    type: 'customs_declaration',
    titles: [/customs\s+declaration/i, /export\s+declaration/i, /import\s+declaration/i, /certificate\s+of\s+origin/i],
    cues: [/customs\s+(?:office|station)/i, /declarant/i],
    names: [/customs|\bCEPA\b|\bCOO\b/i],
  },
];

const TITLE_IN_HEADER = 6; // the paper's own title near the top
const TITLE_IN_BODY = 2; // the title words further down (a reference to another paper)
const FILE_NAME = 3;
const MAX_CUE_POINTS = 4;

/** The top of the document: its first 15 non-empty lines. Titles found here count most. */
function headerOf(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, 15)
    .join('\n');
}

/** Score every doc type for this file. Returns the list best first: [{ type, score, titleInHeader, clues }]. */
export function scoreTypes({ name = '', text = '' }) {
  const header = headerOf(text);
  const body = String(text || '');
  const baseName = String(name).replace(/\.[a-z0-9]+$/i, '');
  const results = RULES.map((rule) => {
    let score = 0;
    const clues = [];
    let titleInHeader = false;
    const headerTitle = rule.titles.map((re) => header.match(re)).find(Boolean);
    const bodyTitle = headerTitle ? null : rule.titles.map((re) => body.match(re)).find(Boolean);
    if (headerTitle) {
      score += TITLE_IN_HEADER;
      titleInHeader = true;
      clues.push(`title "${headerTitle[0].trim()}"`);
    } else if (bodyTitle) {
      score += TITLE_IN_BODY;
      clues.push(`"${bodyTitle[0].trim()}" in the text`);
    }
    const cueCount = rule.cues.filter((re) => re.test(body)).length;
    if (cueCount) {
      score += Math.min(cueCount, MAX_CUE_POINTS);
      clues.push(`${cueCount} keyword${cueCount === 1 ? '' : 's'}`);
    }
    if (rule.names.some((re) => re.test(baseName))) {
      score += FILE_NAME;
      clues.push('file name');
    }
    return { type: rule.type, score, titleInHeader, clues };
  });
  return results.sort((a, b) => b.score - a.score);
}

/**
 * Classify by rules only. Returns { docType, confidence, reason }.
 * Emails and chats are known from how they arrived, so they classify directly.
 */
export function classifyByRules({ name = '', text = '', kind = '' } = {}) {
  if (kind === 'email') return { docType: 'email', confidence: 1, reason: 'Email message' };
  if (kind === 'chat') return { docType: 'whatsapp_chat', confidence: 1, reason: 'WhatsApp chat export' };
  const ranked = scoreTypes({ name, text });
  const top = ranked[0];
  const next = ranked[1] || { score: 0 };
  if (!top || top.score < 2) {
    return { docType: 'other', confidence: 0.3, reason: text ? 'No title or keywords found' : 'No text to read yet' };
  }
  let confidence = 0.4 + 0.06 * (top.score - next.score) + (top.titleInHeader ? 0.2 : 0);
  confidence = Math.round(Math.max(0.3, Math.min(0.97, confidence)) * 100) / 100;
  const label = DOC_TYPE_LABELS[top.type] || top.type;
  return { docType: top.type, confidence, reason: `${label}: ${top.clues.join(', ')}` };
}

/** Which extraction prompt family a doc type uses. */
export const FAMILY_OF = {
  commercial_invoice: 'invoice',
  proforma_invoice: 'invoice',
  supplier_invoice: 'invoice',
  purchase_order: 'invoice',
  packing_list: 'packing_list',
  lab_report: 'lab_report',
  kp_certificate: 'kp',
  shipping_bill: 'customs',
  bill_of_entry: 'customs',
  customs_declaration: 'customs',
  air_waybill: 'air_waybill',
  insurance_certificate: 'insurance',
  supplier_declaration: 'declaration',
  g7_gf_declaration: 'declaration',
  factory_record: 'factory',
  kyc_document: 'other',
  whatsapp_chat: 'other',
  email: 'other',
  other: 'other',
};

export function familyOf(docType) {
  return FAMILY_OF[docType] || 'other';
}
