// Exact wording for the origin statements, and the official sources it comes from.
// Wording checked on 15 Nov 2026. If a regulator changes a template, change it here and bump WORDING_VERSION.

export const WORDING_VERSION = '2026-11-15';

/** Every legal source the papers cite. Each URL was opened and read when the wording was checked. */
export const SOURCES = {
  eu_regulation: {
    title: 'Council Regulation (EU) No 833/2014, Article 3p',
    publisher: 'EUR-Lex',
    url: 'https://eur-lex.europa.eu/eli/reg/2014/833/oj/eng',
    usedFor: 'The EU ban on Russian diamonds and the 0.5 carat threshold.',
  },
  eu_faq: {
    title: 'Restrictions on diamonds, frequently asked questions (as of 17 December 2025)',
    publisher: 'European Commission',
    url: 'https://finance.ec.europa.eu/system/files/2023-12/faqs-sanctions-russia-diamonds_en.pdf',
    usedFor: 'Question 23 gives the Due Diligence Statement template. Question 14 lists what importers need from 1 January 2026.',
  },
  dds_template: {
    title: 'Due Diligence Statement of Diamond Origin, template (February 2026)',
    publisher: 'Antwerp World Diamond Centre, for the Diamond Office',
    url: 'https://www.awdc.be/sites/default/files/2026-02/Due%20Dilligence%20Statement_2026.pdf',
    usedFor: 'Field names used in Belgium: VAT number, HAWB number, date of declaration.',
  },
  awdc_guidelines: {
    title: 'EU import guidelines, update 1 January 2026',
    publisher: 'Antwerp World Diamond Centre',
    url: 'https://www.awdc.be/sites/default/files/2025-12/EU%20Import%20Guidelines%20-%20Update%201%20January%202026.pdf',
    usedFor: 'Evidence an importer keeps, the 5 year retention, and the G7/GF template for lab-grown goods.',
  },
  awdc_update: {
    title: 'Update 1 January 2026, quick step-by-step plan',
    publisher: 'Antwerp World Diamond Centre',
    url: 'https://www.awdc.be/update-january-1-2026',
    usedFor: 'Diamond Office templates for natural polished goods and for grandfathered goods.',
  },
  cbp_csms: {
    title: 'CSMS # 61912001, Executive Order 14068, additional guidance on non-industrial diamonds and diamond jewelry and unsorted diamonds (23 August 2024)',
    publisher: 'U.S. Customs and Border Protection',
    url: 'https://content.govdelivery.com/accounts/USDHSCBP/bulletins/3b0b3c1',
    usedFor: 'The exact self-certification sentences and how the certificate is uploaded (ACE DIS, DocCode CBP03).',
  },
  ofac_determinations: {
    title: 'Determinations on imports of certain categories of diamonds (8 February 2024)',
    publisher: 'U.S. Treasury, OFAC',
    url: 'https://ofac.treasury.gov/recent-actions/20240208',
    usedFor: 'The US import ban the certificate answers to.',
  },
  ace_dis: {
    title: 'ACE Document Image System (DIS) implementation guide',
    publisher: 'U.S. Customs and Border Protection',
    url: 'https://www.cbp.gov/document/guidance/ace-dis-implementation-guide',
    usedFor: 'How importers and brokers upload supporting documents.',
  },
  ofac_sdn: {
    title: 'Specially Designated Nationals and Blocked Persons List (SDN)',
    publisher: 'U.S. Treasury, OFAC',
    url: 'https://sanctionslist.ofac.treas.gov/Home/SdnList',
    usedFor: 'Every party in the shipment is screened against this list.',
  },
};

/**
 * EU statement. The wording is the official template, copied word for word:
 * European Commission FAQ "Restrictions on diamonds" (17 December 2025), Question 23. The Diamond Office
 * template (February 2026) has the same three paragraphs and adds the VAT number and HAWB number fields.
 */
const EU_DDS = {
  title: 'Due Diligence Statement of Diamond Origin',
  officialTemplate: true,
  scope: 'Natural polished diamonds of 0.50 ct and up entering the EU, from 1 January 2026. One statement per shipment.',
  fields: {
    company: 'Importing company name',
    address: 'Address',
    eori: 'EORI number',
    vat: 'VAT number',
    hawb: 'HAWB number',
    shipmentRef: 'Shipment reference / Invoice number',
    date: 'Date of declaration',
  },
  paragraphs: [
    'I, the undersigned, hereby declare that the non-industrial, natural polished diamonds in this shipment were not mined, extracted, produced, or manufactured wholly or in part in the Russian Federation, notwithstanding whether such diamonds have been substantially transformed into other products outside of the Russian Federation.',
    'I confirm that reasonable steps have been taken to verify the declared origin and to avoid aggregation of diamonds of unknown origin with traceable goods.',
    'I further confirm that these efforts and internal controls conform to the requirements and principles of the Due Diligence on Diamond Origin (as referred to in Questions 24 and 25 of the FAQ “Restrictions on diamonds”).',
  ],
  signature: {
    heading: 'Signed by',
    name: 'Name',
    position: 'Position',
    date: 'Date',
    signature: 'Signature',
    stamp: '(Company stamp if applicable)',
  },
  // What the importer keeps (AWDC guidelines, FAQ section 3).
  retention: 'The importer keeps this statement for 5 years. The evidence above is shown to the authorities on request.',
  wordingNote: 'Official wording: European Commission FAQ on restrictions on diamonds (17 Dec 2025), Question 23, and the Diamond Office template (Feb 2026).',
  sources: ['eu_faq', 'dds_template', 'eu_regulation', 'awdc_guidelines'],
};

/** US certificate. Sentences copied exactly from CBP CSMS # 61912001. */
const US_CBP = {
  title: 'US CBP self-certification',
  scope: 'Non-industrial diamonds of 0.5 ct and up, diamond jewelry and unsorted diamonds entering the United States.',
  // "For non-industrial diamonds with a weight of 0.5 carat or greater, effective September 1, 2024"
  diamonds: 'I certify that the non-industrial diamonds in this shipment were not mined, extracted, produced, or manufactured wholly or in part in the Russian Federation, notwithstanding whether such diamonds have been substantially transformed into other products outside of the Russian Federation.',
  // "For diamond jewelry and unsorted diamonds"
  jewelry: 'I certify that the diamond jewelry and unsorted diamonds in this shipment are not of Russian Federation origin and were not exported from the Russian Federation.',
  howItIsLodged: [
    'On official company letterhead, saved as a PDF.',
    'One certificate per entry, entry summary or FTZ admission.',
    'The importer or its customs broker uploads it to the ACE Document Image System (DIS): agency code CBP, document name, type and label code Other, DocCode CBP03.',
  ],
  ace: { agencyCode: 'CBP', documentName: 'Other', documentType: 'Other', documentLabelCode: 'Other', docCode: 'CBP03' },
  signature: { name: 'Name', title: 'Title', date: 'Date', signature: 'Signature' },
  wordingNote: 'Certification sentences copied exactly from CBP CSMS # 61912001 (23 August 2024).',
  sources: ['cbp_csms', 'ofac_determinations', 'ace_dis'],
};

// Grandfathered goods: the cut-off is the day the ban on them applied (EC FAQ Questions 2 and 17).
const GRANDFATHERED = 'The same template covers grandfathered goods: diamonds a company already held outside Russia before '
  + 'the ban on them applied, which is 1 January 2024, or for diamonds processed outside Russia 1 March 2024 (1.0 ct and up) '
  + 'and 1 September 2024 (0.5 ct and up) (EC FAQ Questions 2 and 17).';
const COPY_FACTS = 'Copy the facts below into the template. The importer signs it, and it goes with the shipment papers.';

/**
 * A note pointing to the Diamond Office G7/GF template, with the facts filled in. Two kinds of goods use it:
 * lab-grown rough and polished, and natural rough (EC FAQ Questions 11, 14 and 15; AWDC guidelines).
 */
const G7_GF = {
  title: 'G7 / GF declaration note',
  // Lab-grown goods.
  scope: 'Lab-grown goods use the Diamond Office G7/GF declaration, not the Due Diligence Statement.',
  paragraphs: [
    'Lab-grown (synthetic) rough and polished diamonds entering the EU through the Diamond Office use the Diamond Office G7/GF declaration template.',
    'The papers name the country where the stones were grown, or a signed supplier declaration says none of 0.5 ct and up was made in Russia (EC FAQ Question 15).',
    GRANDFATHERED,
    COPY_FACTS,
  ],
  // Natural rough.
  rough: {
    scope: 'Natural rough entering the EU is verified by the Diamond Office in Antwerp and uses the Diamond Office G7/GF declaration template.',
    paragraphs: [
      'Natural rough diamonds (HS 7102 10 and 7102 31) of 0.5 ct and up entering the EU, through any member state, are presented to the Diamond Office in Antwerp (FPS Economy, Hoveniersstraat 22, 2018 Antwerpen) for verification, and get a G7 certificate there (EC FAQ Question 11).',
      'They travel with a Kimberley Process certificate that lists every country of mining. A certificate without them is not accepted, except for grandfathered goods (EC FAQ Questions 9 and 14).',
      GRANDFATHERED,
      COPY_FACTS,
    ],
  },
  wordingNote: 'Based on the AWDC EU import guidelines (update 1 January 2026) and the EC FAQ on diamonds (17 Dec 2025). This note is not the template itself.',
  sources: ['awdc_guidelines', 'awdc_update', 'eu_faq'],
};

export const TEMPLATES = {
  version: WORDING_VERSION,
  eu_dds: EU_DDS,
  us_cbp_certificate: US_CBP,
  g7_gf_declaration: G7_GF,
  sources: SOURCES,
};
