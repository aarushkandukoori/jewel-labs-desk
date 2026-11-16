// The insurance certificate for shipment A, from a made-up specie insurer. This clean PDF is only
// the starting point: generate.js turns it into a scanned-looking, image-only PDF (see images.js),
// so the agents must read it with the vision model or OCR.
import {
  newPdf, addPage, paperDate, write, paragraph, rect, line, roundStamp, sign, markPage, rgb, A4, MARGIN, GREY,
} from './kit.js';
import { HOUSE, INSURER, SHIPMENTS, totals, dmy, money, carats } from './facts.js';

const GREEN = rgb(0.1, 0.3, 0.22);

/** Insured value: 110% of the CIF invoice value, rounded to cents. */
export function insuredValue() {
  const s = SHIPMENTS.A;
  return Math.round(totals(s).value * s.insurance.cover * 100) / 100;
}

/** The rows of the certificate, in print order. */
export function insuranceRows() {
  const s = SHIPMENTS.A;
  const sum = totals(s);
  const flights = s.awb.legs.map((leg) => leg.flight).join(' / ');
  return [
    ['Insurer', INSURER.name],
    ['Insured', `${HOUSE.name}, ${HOUSE.address}`],
    ['For account of', `${HOUSE.name} and/or ${s.buyer.name}`],
    ['Conveyance', 'Secured air freight, door to door'],
    ['Flight No. and Date', `${flights} on ${dmy(s.awb.date)}`],
    ['From', 'Surat, India, via Mumbai and Dubai'],
    ['To', s.finalDestination],
    ['MAWB / HAWB No.', `${s.awb.mawb} / ${s.awb.hawb}`],
    ['Invoice No.', `${s.invoice} dated ${dmy(s.invoiceDate)}`],
    ['Insured Interest', `${s.goods}, 1 parcel, ${sum.pieces} pcs, ${carats(sum.carats)} ct`],
    ['Insured Value', `USD ${money(insuredValue())} (110% of CIF value USD ${money(sum.value)})`],
    ['Conditions', 'All risks of physical loss or damage from any external cause, door to door, subject to the terms and exclusions of the policy.'],
    ['Claims', `Notify ${INSURER.claimsAgent} within 7 days of arrival.`],
  ];
}

export async function buildInsuranceCertificate() {
  const s = SHIPMENTS.A;
  const ins = s.insurance;
  const { pdf, fonts } = await newPdf({
    title: `Certificate of insurance ${ins.certificate} (SAMPLE)`, author: INSURER.name, date: paperDate(ins.date, '13:15:00'),
  });
  const page = addPage(pdf);

  // Letterhead.
  write(page, INSURER.name, MARGIN, 58, { font: fonts.serifBold, size: 16, color: GREEN });
  write(page, `${INSURER.address}   |   Tel ${INSURER.phone}`, MARGIN, 72, { font: fonts.serif, size: 8.5 });
  line(page, MARGIN, 82, A4.width - MARGIN, 82, { color: GREEN, width: 1.2 });
  write(page, 'CERTIFICATE OF INSURANCE', 0, 112, { font: fonts.serifBold, size: 15, align: 'center', width: A4.width });
  write(page, 'Marine and transit cargo (specie)', 0, 126, { font: fonts.serifItalic, size: 9.5, align: 'center', width: A4.width });

  const refs = [
    ['Certificate No.', ins.certificate],
    ['Date of Issue', dmy(ins.date)],
    ['Policy No.', ins.policy],
  ];
  refs.forEach(([label, value], i) => {
    write(page, label, MARGIN, 156 + i * 14, { font: fonts.serif, size: 10 });
    write(page, `: ${value}`, MARGIN + 100, 156 + i * 14, { font: fonts.serifBold, size: 10 });
  });

  let y = paragraph(page, 'This is to certify that insurance has been effected under the above open policy for the shipment '
    + 'described below, on the terms of the policy and of this certificate.', MARGIN, 210,
  { font: fonts.serif, size: 10, width: A4.width - MARGIN * 2, lineHeight: 13 });

  y += 10;
  for (const [label, value] of insuranceRows()) {
    write(page, label, MARGIN, y, { font: fonts.serif, size: 10 });
    write(page, ':', MARGIN + 118, y, { font: fonts.serif, size: 10 });
    y = paragraph(page, value, MARGIN + 126, y, { font: fonts.serifBold, size: 10, width: A4.width - MARGIN * 2 - 126, lineHeight: 12.5 }) + 4.5;
  }

  y += 16;
  rect(page, MARGIN, y, A4.width - MARGIN * 2, 40, { stroke: GREEN, lineWidth: 0.6 });
  paragraph(page, 'In the event of loss or damage, the original certificate, the invoice, the air waybill and the survey report '
    + 'must be sent with the claim. This certificate is not valid unless signed below.', MARGIN + 8, y + 15,
  { font: fonts.serifItalic, size: 9, width: A4.width - MARGIN * 2 - 16, lineHeight: 11 });

  y += 70;
  write(page, `For ${INSURER.name}`, A4.width - MARGIN - 230, y, { font: fonts.serifBold, size: 10 });
  roundStamp(page, { cx: A4.width - MARGIN - 190, cy: y + 44, r: 31, top: 'SAMPLE SPECIE INSURANCE', bottom: 'MUMBAI * SAMPLE',
    middle: ['CARGO'], color: rgb(0.15, 0.35, 0.25), rotate: -6 });
  sign(page, A4.width - MARGIN - 150, y + 48, { seed: 1187, width: 92, height: 17 });
  write(page, 'Authorised signatory', A4.width - MARGIN - 140, y + 84, { font: fonts.serif, size: 9.5 });
  write(page, `Issued at Mumbai on ${dmy(ins.date)}`, MARGIN, y + 84, { font: fonts.serif, size: 9.5 });
  paragraph(page, 'This certificate is a fictional sample made for the Jewel Labs demo. It is not an insurance contract.',
    MARGIN, y + 112, { font: fonts.serifItalic, size: 8.5, width: A4.width - MARGIN * 2, color: GREY });
  markPage(page, fonts);
  return pdf.save();
}
