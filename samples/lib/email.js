// The buyer's email "PO LDB-7781 from Lumen Diamant.eml": a plain-text note asking for the EU statement,
// with purchase order LDB-7781 attached as a PDF. Written by hand (headers, one fixed MIME boundary,
// base64 attachment) so the file is the same on every run.
import { HOUSE, BUYER_EU, SHIPMENTS } from './facts.js';

export const EMAIL_FILE = 'PO LDB-7781 from Lumen Diamant.eml';
export const PO_FILE = 'PO LDB-7781.pdf';
export const SUBJECT = 'PO LDB-7781 from Lumen Diamant';
export const SENT_AT = 'Mon, 09 Nov 2026 10:14:22 +0100';

export const BODY = [
  'Dear Ravi,',
  '',
  'Please find attached our purchase order LDB-7781 for the six polished stones you offered under your',
  'reference KG/26-27/041.',
  '',
  'Since 1 January 2026 we need a signed Due Diligence Statement on Diamond Origin for every natural',
  'polished diamond of 0.50 ct and up. Please send the signed EU statement with the parcel, together with',
  'the grading reports and the KP certificate details of the rough. Our broker in Antwerp will not release',
  'the goods without it.',
  '',
  'Please ship by 13 November.',
  '',
  'Kind regards,',
  'Buying desk',
  BUYER_EU.name,
  BUYER_EU.address,
  BUYER_EU.phone,
].join('\r\n');

const BOUNDARY = '=_sample_ldb7781_boundary';

/** Builds the .eml bytes around the purchase order PDF. */
export function buildEmail(poPdfBytes) {
  const base64 = Buffer.from(poPdfBytes).toString('base64').replace(/.{76}/g, '$&\r\n');
  const lines = [
    `From: Lumen Diamant buying desk <${BUYER_EU.email}>`,
    `To: Ravi <${HOUSE.email}>`,
    `Subject: ${SUBJECT}`,
    `Date: ${SENT_AT}`,
    `Message-ID: <ldb-7781.20261109101422@lumen-diamant.example.com>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
    '',
    'This is a multi-part message in MIME format.',
    '',
    `--${BOUNDARY}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    BODY,
    '',
    `--${BOUNDARY}`,
    `Content-Type: application/pdf; name="${PO_FILE}"`,
    `Content-Disposition: attachment; filename="${PO_FILE}"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64.replace(/\r\n$/, ''),
    '',
    `--${BOUNDARY}--`,
    '',
  ];
  return new TextEncoder().encode(lines.join('\r\n'));
}

/** What the reading agent should find in the email. */
export function emailFacts() {
  const s = SHIPMENTS.A;
  return {
    from: BUYER_EU.email,
    to: HOUSE.email,
    subject: SUBJECT,
    date: '2026-11-09T09:14:22.000Z',
    refs: [s.po.number, s.invoice],
    request: 'Send the signed EU Due Diligence Statement on Diamond Origin with the parcel.',
  };
}
