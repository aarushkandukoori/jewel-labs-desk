// Shared constants and data shapes for every module. Plain JS + JSDoc so it is easy to read.

/** Kinds of documents the agents recognise. */
export const DOC_TYPES = [
  'commercial_invoice', // export or sale invoice for the goods in the parcel
  'proforma_invoice',
  'packing_list', // stone-by-stone or lot list
  'lab_report', // GIA, IGI, HRD ... grading report
  'kp_certificate', // Kimberley Process certificate (rough)
  'supplier_invoice', // invoice from the rough or polished supplier
  'supplier_declaration', // system of warranties / origin declaration from a supplier
  'g7_gf_declaration', // Diamond Office G7 / grandfathered declaration
  'shipping_bill', // export customs declaration (India: shipping bill with Let Export Order)
  'bill_of_entry', // import customs declaration
  'air_waybill', // HAWB / MAWB
  'insurance_certificate',
  'customs_declaration', // any other customs form
  'purchase_order',
  'factory_record', // manufacturing / assortment records
  'whatsapp_chat',
  'email',
  'kyc_document', // trade licence, registration, IDs
  'other',
];

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

/** Canonical field keys the reading agent fills. Values are strings as printed (numbers parsed later). */
export const FIELD_KEYS = [
  'doc.number', 'doc.date',
  'exporter.name', 'exporter.address', 'exporter.country', 'exporter.taxId',
  'consignee.name', 'consignee.address', 'consignee.country',
  'buyer.name', 'buyer.address', 'buyer.country',
  'supplier.name', 'supplier.address', 'supplier.country',
  'carrier.name', 'broker.name', 'insurer.name', 'insured.name',
  'invoice.number', 'invoice.date', 'po.number', 'payment.terms',
  'shippingBill.number', 'shippingBill.date', 'leo.date', 'leo.number',
  'billOfEntry.number', 'billOfEntry.date',
  'awb.hawb', 'awb.mawb', 'awb.flight', 'awb.date', 'awb.route',
  'kp.certificateNumber', 'kp.exportingCountry', 'kp.importingCountry', 'kp.countriesOfMining',
  'kp.issueDate', 'kp.expiryDate', 'kp.carats', 'kp.value',
  'goods.description', 'goods.nature', 'goods.form', 'goods.hsCode', 'goods.totalPieces', 'goods.totalCarats',
  'goods.totalValue', 'goods.currency', 'goods.countryOfOrigin', 'goods.destinationCountry', 'goods.incoterm',
  'goods.portOfLoading', 'goods.portOfDischarge', 'goods.grossWeight', 'goods.netWeight', 'goods.packages',
  'lab.name', 'lab.reportNumber', 'lab.reportDate', 'lab.shape', 'lab.carat', 'lab.color', 'lab.clarity',
  'lab.cut', 'lab.polish', 'lab.symmetry', 'lab.fluorescence', 'lab.measurements', 'lab.growthMethod',
  'lab.inscription',
  'insurance.policyNumber', 'insurance.insuredValue',
  'declaration.text',
];

/** Human labels for fields (used on the page highlights and in the record sheet). */
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

/** The agents, in pipeline order. Colours match the cursors in the live view. */
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

export const SHIPMENT_STATUS = ['collecting', 'reading', 'questions', 'held_for_review', 'ready_to_sign', 'signed', 'sent'];
export const SHIPMENT_STATUS_LABELS = {
  collecting: 'Collecting papers', reading: 'Agents reading', questions: 'Questions open',
  held_for_review: 'Held for review', ready_to_sign: 'Ready to sign', signed: 'Signed', sent: 'Sent',
};

export const PAPER_KINDS = [
  'export_pack', 'import_pack', 'eu_dds', 'us_cbp_certificate', 'g7_gf_declaration', 'packing_list_draft',
];
export const PAPER_KIND_LABELS = {
  export_pack: 'Export pack', import_pack: 'Import pack', eu_dds: 'EU Due Diligence Statement (draft)',
  us_cbp_certificate: 'US CBP self-certification', g7_gf_declaration: 'G7 / GF declaration note',
  packing_list_draft: 'Packing list (drafted by agents)',
};
export const PAPER_STATUS = ['draft', 'held_for_review', 'ready_to_sign', 'signed', 'sent'];

export const CHECK_SEVERITY = ['pass', 'info', 'warn', 'fail'];
export const QUESTION_KINDS = ['missing_document', 'missing_field', 'mismatch', 'confirm'];
export const ROLES = ['owner', 'preparer', 'viewer', 'desk'];
export const SOURCE_KINDS = ['upload', 'folder', 'email', 'whatsapp', 'forward', 'generated', 'sample'];

export const COLLECTIONS = [
  'documents', 'shipments', 'stones', 'checks', 'questions', 'papers', 'parties', 'activity', 'messages', 'events',
];

/** EU member states (ISO 3166-1 alpha-2). Imports into any of these need EU rules. */
export const EU_MEMBER_STATES = {
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', HR: 'Croatia', CY: 'Cyprus', CZ: 'Czechia', DK: 'Denmark',
  EE: 'Estonia', FI: 'Finland', FR: 'France', DE: 'Germany', GR: 'Greece', HU: 'Hungary', IE: 'Ireland',
  IT: 'Italy', LV: 'Latvia', LT: 'Lithuania', LU: 'Luxembourg', MT: 'Malta', NL: 'Netherlands', PL: 'Poland',
  PT: 'Portugal', RO: 'Romania', SK: 'Slovakia', SI: 'Slovenia', ES: 'Spain', SE: 'Sweden',
};

/**
 * @typedef {{ x0:number, y0:number, x1:number, y1:number, page:number, text:string, conf?:number }} Word
 * @typedef {{ key:string, value:string|null, quote:string|null, page:number|null, confidence:number, box?:number[]|null, agent?:string }} Field
 * @typedef {{ lineNo:number|null, description:string|null, reportNumber:string|null, lab:string|null, shape:string|null,
 *   carat:number|null, color:string|null, clarity:string|null, pieces:number|null, rate:number|null, amount:number|null,
 *   growth:string|null, quote:string|null }} Line
 * @typedef {{ kind:string, ref?:string, receivedAt:string, from?:string, chatAuthor?:string, chatAt?:string }} Source
 * @typedef {{ id:string, workspaceId:string, fileName:string, mime:string, size:number, sha256:string, fileKey:string,
 *   source:Source, parentId?:string|null, kind:string, pages:number, hasTextLayer:boolean, docType:string,
 *   classifyConfidence:number, classifyReason?:string|null, summary?:string, fields:Field[], lines:Line[],
 *   declarations:string[], warnings?:string[], shipmentId:string|null, status:'new'|'reading'|'read'|'error',
 *   error?:string, readBy?:string, readAt?:string, aiError?:string|null, needsAiRead?:boolean, aiRereads?:number,
 *   createdAt:string, updatedAt:string }} DocumentRecord
 * @typedef {{ name:string|null, address?:string|null, country?:string|null }} Party
 * @typedef {{ id:string, workspaceId:string, ref:string, direction:'export'|'import'|'unknown',
 *   exporter:Party, consignee:Party, buyer?:Party, supplier?:Party,
 *   originCountry:string|null, destinationCountry:string|null, route:string|null,
 *   invoiceNumber?:string|null, invoiceDate?:string|null, shippingBillNumber?:string|null, leoDate?:string|null,
 *   hawb?:string|null, mawb?:string|null, flight?:string|null,
 *   goods:{ nature:string, form:string, hsCodes:string[], description?:string|null },
 *   totals:{ pieces:number|null, carats:number|null, value:number|null, currency:string|null },
 *   documentIds:string[], status:string, required:Array<{kind:string, reason:string, signer:string, regime:string}>,
 *   summary?:{passed:number,total:number}, createdAt:string, updatedAt:string }} Shipment
 * @typedef {{ id:string, workspaceId:string, shipmentId:string, ref:string, reportNumber:string|null, lab:string|null,
 *   shape:string|null, carat:number|null, color:string|null, clarity:string|null, growth:string|null,
 *   sources:Array<{docId:string, kind:string, lineNo?:number|null}>, kp?:{ certificateNumber:string|null, countries:string[] },
 *   labCheck?:{ status:string, checkedAt?:string, diffs?:Array<{field:string, ours:any, lab:any}> } }} Stone
 * @typedef {{ at:string|null, kind:string, title:string, detail:string, docId?:string|null, field?:string|null }} HistoryEvent
 * @typedef {{ id:string, shipmentId:string, code:string, severity:'pass'|'info'|'warn'|'fail', title:string, detail:string,
 *   evidence:Array<{docId:string, key?:string}>, rule:string }} Check
 * @typedef {{ id:string, shipmentId:string|null, kind:string, text:string, key?:string|null, docId?:string|null,
 *   options?:string[], status:'open'|'answered'|'dismissed', answer?:string, answeredBy?:string, answeredAt?:string }} Question
 * @typedef {{ id:string, shipmentId:string, kind:string, ref:string, version:number, status:string, fileKey:string,
 *   sha256:string, pages:number, contents:Array<{title:string, docId?:string}>, signedBy?:string, signedAt?:string,
 *   sentTo?:string, sentAt?:string, deskEdits:number, houseEdits:number, deskNote?:string }} Paper
 * @typedef {{ id:string, at:string, shipmentId?:string|null, actor:{ type:'agent'|'person'|'system', name:string },
 *   action:string, detail:string }} Activity
 * @typedef {{ agent:string, action:string, docId?:string, shipmentId?:string, page?:number, key?:string, label?:string,
 *   value?:string, box?:number[], message:string }} AgentEvent
 */
