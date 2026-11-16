// Names the screens show. Copies of lists in src/core, because the website demo ships only this folder.
// test/unit/renderer.test.js checks that every copy stays the same as its original: AGENTS and the label maps
// (src/core/types.js), SOURCE_LABELS and ROLE_LABELS (types.js SOURCE_KINDS and ROLES), and HISTORY_STEPS
// (src/core/records/history.js HISTORY_STAGES).

export const AGENTS = [
  { id: 'retrieval', name: 'Retrieval', letter: 'R', color: '#93b4ff', does: 'pulls mail, chats and folders' },
  { id: 'intake', name: 'Intake', letter: 'I', color: '#7dd3fc', does: 'reads every document' },
  { id: 'records', name: 'Records', letter: 'R', color: '#86efac', does: 'files papers and traces every stone' },
  { id: 'sanctions', name: 'Sanctions', letter: 'S', color: '#c4b5fd', does: 'OFAC SDN screen' },
  { id: 'origin', name: 'Origin', letter: 'O', color: '#fde68a', does: 'checks origin against the rules' },
  { id: 'review', name: 'Review', letter: 'R', color: '#f9a8d4', does: 'flags what is missing' },
  { id: 'paperwork', name: 'Paperwork', letter: 'P', color: '#fdba74', does: 'writes and cites' },
];
export const AGENT_BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

export function agentOf(id) {
  return AGENT_BY_ID[id] || { id: id || 'agent', name: id ? capitalize(id) : 'Agent', letter: 'A', color: '#99a2b2', does: '' };
}

function capitalize(text) {
  return String(text).charAt(0).toUpperCase() + String(text).slice(1);
}

export const DOC_TYPE_LABELS = {
  commercial_invoice: 'Commercial invoice',
  proforma_invoice: 'Proforma invoice',
  packing_list: 'Packing list',
  lab_report: 'Grading report',
  kp_certificate: 'Kimberley Process certificate',
  supplier_invoice: 'Supplier invoice',
  supplier_declaration: 'Supplier declaration',
  g7_gf_declaration: 'G7 / GF declaration',
  shipping_bill: 'Shipping bill',
  bill_of_entry: 'Bill of entry',
  air_waybill: 'Air waybill',
  insurance_certificate: 'Insurance certificate',
  customs_declaration: 'Customs declaration',
  purchase_order: 'Purchase order',
  factory_record: 'Factory record',
  whatsapp_chat: 'WhatsApp chat',
  email: 'Email',
  kyc_document: 'KYC document',
  other: 'Other document',
};

export const FIELD_LABELS = {
  'doc.number': 'Document number', 'doc.date': 'Date',
  'exporter.name': 'Exporter', 'exporter.address': 'Exporter address', 'exporter.country': 'Exporter country',
  'exporter.taxId': 'Exporter tax ID',
  'consignee.name': 'Consignee', 'consignee.address': 'Consignee address', 'consignee.country': 'Consignee country',
  'buyer.name': 'Buyer', 'buyer.address': 'Buyer address', 'buyer.country': 'Buyer country',
  'supplier.name': 'Supplier', 'supplier.address': 'Supplier address', 'supplier.country': 'Supplier country',
  'carrier.name': 'Carrier', 'broker.name': 'Customs broker', 'insurer.name': 'Insurer', 'insured.name': 'Insured',
  'invoice.number': 'Invoice number', 'invoice.date': 'Invoice date', 'po.number': 'Purchase order',
  'payment.terms': 'Payment terms',
  'shippingBill.number': 'Shipping bill number', 'shippingBill.date': 'Shipping bill date',
  'leo.date': 'Let Export Order', 'leo.number': 'LEO number',
  'billOfEntry.number': 'Bill of entry', 'billOfEntry.date': 'Bill of entry date',
  'awb.hawb': 'House air waybill', 'awb.mawb': 'Master air waybill', 'awb.flight': 'Flight',
  'awb.date': 'Air waybill date', 'awb.route': 'Route',
  'kp.certificateNumber': 'KP certificate', 'kp.exportingCountry': 'KP exporting country',
  'kp.importingCountry': 'KP importing country', 'kp.countriesOfMining': 'Countries of mining',
  'kp.issueDate': 'KP issued', 'kp.expiryDate': 'KP expires', 'kp.carats': 'KP carats', 'kp.value': 'KP value',
  'goods.description': 'Goods', 'goods.nature': 'Natural or lab-grown', 'goods.form': 'Rough, polished or jewelry',
  'goods.hsCode': 'HS code', 'goods.totalPieces': 'Pieces', 'goods.totalCarats': 'Carats', 'goods.totalValue': 'Value',
  'goods.currency': 'Currency', 'goods.countryOfOrigin': 'Country of origin',
  'goods.destinationCountry': 'Destination', 'goods.incoterm': 'Incoterm', 'goods.portOfLoading': 'Port of loading',
  'goods.portOfDischarge': 'Port of discharge', 'goods.grossWeight': 'Gross weight', 'goods.netWeight': 'Net weight',
  'goods.packages': 'Packages',
  'lab.name': 'Lab', 'lab.reportNumber': 'Report number', 'lab.reportDate': 'Report date', 'lab.shape': 'Shape',
  'lab.carat': 'Carat', 'lab.color': 'Colour', 'lab.clarity': 'Clarity', 'lab.cut': 'Cut', 'lab.polish': 'Polish',
  'lab.symmetry': 'Symmetry', 'lab.fluorescence': 'Fluorescence', 'lab.measurements': 'Measurements',
  'lab.growthMethod': 'Growth method', 'lab.inscription': 'Inscription',
  'insurance.policyNumber': 'Policy number', 'insurance.insuredValue': 'Insured value',
  'declaration.text': 'Declaration',
};

export const SHIPMENT_STATUS_LABELS = {
  collecting: 'Collecting papers', reading: 'Agents reading', questions: 'Questions open',
  held_for_review: 'Held for review', ready_to_sign: 'Ready to sign', signed: 'Signed', sent: 'Sent',
};

export const PAPER_KIND_LABELS = {
  export_pack: 'Export pack', import_pack: 'Import pack', eu_dds: 'EU Due Diligence Statement (draft)',
  us_cbp_certificate: 'US CBP self-certification', g7_gf_declaration: 'G7 / GF declaration note',
  packing_list_draft: 'Packing list (drafted by agents)',
};

export const PAPER_STATUS_LABELS = {
  draft: 'Draft', held_for_review: 'Held for review', ready_to_sign: 'Ready to sign', signed: 'Signed', sent: 'Sent',
};

export const SOURCE_LABELS = {
  upload: 'Upload', folder: 'Folder', email: 'Email', whatsapp: 'WhatsApp', forward: 'Forward', generated: 'Agents', sample: 'Sample',
};

export const ROLE_LABELS = { owner: 'Owner', preparer: 'Preparer', viewer: 'Viewer', desk: 'Jewel Labs desk' };

// The stages of a stone's history, in order (src/core/records/history.js HISTORY_STAGES).
// "grown" stands in for "mined" on lab-grown stones; import clearance shares the "cleared" step.
export const HISTORY_STEPS = [
  { id: 'mined', title: 'Mined', kinds: ['mined', 'grown'], empty: 'Countries of mining are not on file yet.' },
  { id: 'rough', title: 'Rough', kinds: ['rough_purchased'], empty: 'No rough purchase on file yet.' },
  { id: 'factory', title: 'Factory', kinds: ['cut_and_polished'], empty: 'No factory record on file yet.' },
  { id: 'graded', title: 'Graded', kinds: ['graded'], empty: 'No grading report on file yet.' },
  { id: 'invoiced', title: 'Invoiced', kinds: ['invoiced'], empty: 'Not on an invoice yet.' },
  { id: 'packed', title: 'Packed', kinds: ['packed'], empty: 'Not on a packing list yet.' },
  { id: 'cleared', title: 'Cleared', kinds: ['cleared_for_export', 'cleared_for_import'], empty: 'No export clearance on file yet.' },
  { id: 'flown', title: 'Flown', kinds: ['flown'], empty: 'No air waybill on file yet.' },
  { id: 'statement', title: 'Statement', kinds: ['statement_drafted'], empty: 'The statement is not drafted yet.' },
  // An importer's statement drafted by an exporter is checked by the house and signed by the importer.
  { id: 'signed', title: 'Signed or checked', kinds: ['statement_signed'], empty: 'Not signed or checked yet.' },
  { id: 'sent', title: 'Sent', kinds: ['statement_sent'], empty: 'Not sent yet.' },
];
