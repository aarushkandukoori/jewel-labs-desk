# Design reference

The app and the site share the Jewel Labs look: pitch black, thin white hairlines, Inter for text, Geist for big
headings, Geist Mono for references (JL-EXP-1115-01), small uppercase labels with wide letter spacing, glassy buttons.
Calm, dense, no colour except the agent colours and status chips.

## Tokens (from jewellabs.io)

```css
--bg: #000000;  --bg-2: #070708;  --panel: #0c0d0f;  --panel-2: #111214;
--text: #e9ecf2; --text-2: #99a2b2; --text-3: #5d6473;
--line: rgba(255,255,255,0.07); --line-2: rgba(255,255,255,0.13);
--accent: #c4c6ca; --accent-soft: rgba(196,198,202,0.12);
--glass: rgba(255,255,255,0.07); --glass-2: rgba(255,255,255,0.11); --glass-line: rgba(255,255,255,0.15);
--radius: 16px (cards) / 14px (buttons) / 10px (inputs) / 6px (chips)
--font: 'Inter', system-ui, sans-serif;  headings: 'Geist';  mono: 'Geist Mono'
--ease: cubic-bezier(0.22, 1, 0.36, 1);
body letter-spacing: -0.011em; labels: 11px, uppercase, letter-spacing 0.16em, color --text-3
status: ok #86efac, warn #fde68a, fail #fca5a5, info #93b4ff (text on a 12% tint of the same colour, 1px border at 35%)
agents: retrieval #93b4ff, intake #7dd3fc, records #86efac, sanctions #c4b5fd, origin #fde68a, review #f9a8d4, paperwork #fdba74
```
Grid background: `linear-gradient(to right, rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.02) 1px, transparent 1px)` at 64px.
Glass button: 1px `--glass-line` border, `--glass` fill, `backdrop-filter: blur(22px) saturate(180%)`, inner top highlight
`linear-gradient(180deg, rgba(255,255,255,0.12), transparent 48%)`, radius 14px. Primary action button in the app: solid
`#f2f3f5` with black text (as in the walkthrough video's "Onboard the house").

## The app screens (match the walkthrough video)

**Desk dashboard** (Jewel Labs staff). Left sidebar 240px: logo + "Jewel Labs", house switcher ("Switch house"),
numbered nav (`01 Dashboard`, `02 Data 50`, `03 Papers 1`, `04 Counterparties 1`, `05 Audit trail 10`) with counts
right-aligned in mono, "More tools +", bottom: "Signed in" block + Sign out, "Environment" segmented Sandbox | Live with a
one-line explanation, and a mono stack of engine versions. Top bar: house name, small live ticker, a long "LIVE" status
field, buttons Review (count), Generate, Connect (white = primary), Autopilot (A). Page header: small label
"JEWEL LABS DASHBOARD", title "Shipment records for <House>", agent avatars (coloured circles with letters R I S P R and
little cursor arrows under them), "Email sending on", "Connect company email". Panels: "From customers", "Customer
logins", "Agents On <model>" with a timestamped activity list (`08:53  Orchestrator  Client asked: ...`), "Parcel
requests and messages" (each request card: ref, request text, "Agent activity · 9 steps" disclosure, "Review JL-IMP-...",
"Sent to the client" chip, message box + "Approve and send to the client"), pipeline row of five agent cards
(`● Retrieval ON  needs your company email`, `● Intake reads every document`, `● Sanctions OFAC SDN screen` with a toggle,
`● Paperwork writes and cites`, `● Review flags what is missing` with a toggle), "Shipment records" list, "Compliance agent"
chat box. Bottom status bar (mono, 12px): `● Live · Model gpt-5-mini · OCR Tesseract 7 · Rules compliance.js · OFAC 17,589 entries, 2026-11-02 · Audit 10 entries`
and on the right `Space runs the open view. A runs autopilot.`

**Onboard a house** modal ("CONNECT: PAST CLIENTS, YOUR EMAIL, OR UPLOAD RECORDS" with tabs Past clients / Connect email
/ Upload records / WhatsApp): house name, legal entity, country, city, role (select), commodities (checkboxes Diamonds,
Gold, Silver, Platinum, Copper, Steel), contact emails, contact name, WhatsApp numbers (renders a QR code for wa.me
with "Scan with your phone. The chat opens; tap the name, then Export chat, Include media, and drop the zip under
WhatsApp."), customer portal login (user name + their email; "Email them their login"), KYC files, "What the agents
may do for this house" checkboxes (search mailbox for these domains, read WhatsApp exports, draft document requests
(never sent automatically), screen the house against OFAC SDN), footer "File statements automatically" + white
"Onboard the house" button. Result box: "<House> is onboarded." + `Clear` chip "No match on the OFAC SDN list (41 similar
names compared)." + buttons "Connect your mailbox", "Upload their WhatsApp export", "Open in the dashboard" + `Login` chip
"Invite code created ...".

**House home** (customer staff, "CUSTOMER PORTAL"): top bar logo + "Signed in as ..." + Sign out; tabs HOME / SHIPMENTS /
PAPERS / STONES (uppercase, 12px, letter-spaced, active underline). Max-width 820px column of bordered sections:
"1. CONNECT" rows (Email: "Gmail, Google Workspace, iCloud, Yahoo or Zoho. The agents read your shipment mail and file
it." + "Connect email" which expands to Provider select / Email / App password / Emails since + "Keep connected: the
agents check it every 5 minutes and file new consignment mail on their own"; WhatsApp: "In the chat, choose Export chat
with media, then add the .zip here." + "Add a chat export"; Folder: watched folder; Forward). "2. DOCUMENTS" with a
dashed drop zone "Drop your documents here, or click to choose" / "Invoices, packing lists, shipping bills, air waybills,
certificates, email threads (.eml), WhatsApp exports, or the whole folder as a .zip", counter "6 DOCUMENTS SENT", then a
three-column agent status strip (`● Intake agent 6 documents read`, `● Records agent 6 new, 0 already on file`,
`● Review agent 1 document still missing`), then "AGENTS READING <file> <doc type>" with the page image and coloured
labelled highlight boxes placed on the real fields ("Shipping bill number: 7955006", "Consignee: ...") and agent cursors
(arrow + name tag in the agent colour) gliding between them. Below: a list of what each shipment still needs with
"Upload it" buttons, status chips (MISSING, ON FILE, EXPORT, SENT NOW, RECEIVED, BACK). "3. TELL THE AGENTS": chat with
suggestion chips ("Prepare the papers for my latest shipment", "What is still missing?", "Prepare the export paper and
the EU statement") and agent replies as step lists (● Sending your request · ● Matching your documents · ● Sanctions
check · ● Checking the documents · ● Building the export paper). "4. BACK FROM JEWEL LABS": papers rows
(`JL-EXP-1105-01 · EXP/26-27/28  HELD FOR REVIEW` + note, buttons Open / Print / Parcel sheets).

**Papers** (the generated PDFs) are light: white page, black hairline tables, small uppercase section labels, the ref in
Geist Mono top right with "PRINTED 05 NOV 2026", "Shipment handover" with Shipper / Carrier / Consignee signature
boxes, "Neutral cover for the outside of the parcel: no contents or values.", "INSIDE THE DOCUMENT ENVELOPE", papers
listed "in the order customs reads them", CHECKS (Status chip HELD FOR REVIEW, "Consistent 19 of 20 checks",
"Not on file ...").

Reference images (local only, never commit them, they contain a real customer's papers):
`~/Projects/jewel-labs-research/hi/*.jpg`, `~/Projects/jewel-labs-research/frames/*.jpg`,
`~/Projects/jewel-labs-research/sheets/*.jpg`; site screenshots `~/Projects/jewel-labs-research/site/shots/*.png`;
the site's own CSS/JS in `~/Projects/jewel-labs-research/site/main/` and `.../site/hw/`.

## Motion

Ease `cubic-bezier(0.22, 1, 0.36, 1)`, 240-600ms. Agent cursors glide (CSS transform transition 700ms) to each field box,
the box fades in with its label chip, then the cursor moves on. Status dots pulse softly while an agent works.
Respect `prefers-reduced-motion` (no gliding, instant placement).
