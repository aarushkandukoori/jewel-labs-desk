// Pure helpers for the "Agents reading" view: which agent's cursor goes to a field, where it
// points, where idle cursors park, and the one-line texts under the page. No DOM here, so tests can check it.
import { agentOf, FIELD_LABELS } from './labels.js';

// The agents that have a cursor on the page, in the order they park (bottom-left, going up).
export const CURSOR_AGENTS = ['intake', 'records', 'review', 'sanctions', 'origin'];

// Who looks at which field. Intake reads everything; the others each check their own part:
// Sanctions screens the names, Records ties the numbers to a shipment, Origin checks where it came from.
const FIELD_OWNERS = [
  [/^(exporter|consignee|buyer|supplier|carrier|broker|insurer)\.name$/, 'sanctions'],
  [/^(invoice\.number|shippingBill\.number|awb\.(hawb|mawb)|kp\.certificateNumber|lab\.reportNumber|po\.number|billOfEntry\.number|leo\.number|doc\.number|insurance\.policyNumber)$/, 'records'],
  [/^(kp\.countriesOfMining|kp\.exportingCountry|goods\.countryOfOrigin|goods\.nature|lab\.growthMethod|goods\.destinationCountry|leo\.date)$/, 'origin'],
];

/** The agent shown for a field: Review when the reading is unsure, else the field's owner, else Intake. */
export function displayAgent(key, fallback = 'intake', confidence = null) {
  if (typeof confidence === 'number' && confidence < 0.75) return 'review';
  for (const [pattern, agent] of FIELD_OWNERS) if (pattern.test(String(key || ''))) return agent;
  return CURSOR_AGENTS.includes(fallback) ? fallback : 'intake';
}

/** Where a cursor's tip goes for a box: a little inside its lower half, in percent of the page. */
export function cursorPoint(box) {
  const [x0, y0, x1, y1] = box.map(Number);
  return { x: (x0 + (x1 - x0) * 0.42) * 100, y: (y0 + (y1 - y0) * 0.78) * 100 };
}

/** Idle cursors wait stacked at the bottom-left of the page, like a pile of pointers. */
export function parkPoint(agentId) {
  const i = Math.max(0, CURSOR_AGENTS.indexOf(agentId));
  return { x: 4 + i * 2.6, y: 95 - i * 3.6 };
}

export function parkedCursors() {
  return Object.fromEntries(CURSOR_AGENTS.map((id) => [id, { ...parkPoint(id), parked: true }]));
}

/** Waiting time between field events: slower when there is little to show, faster with a backlog. */
export function pace(backlog) {
  if (backlog > 30) return 90;
  if (backlog > 12) return 260;
  if (backlog > 4) return 480;
  return 720;
}

/** "Intake agent read Invoice number: KG/26-27/041". */
export function readLine(agentId, label, value) {
  return `${agentOf(agentId).name} agent read ${label}: ${value}`;
}

/** Field boxes of one page of a read document, for the still view. */
export function boxesOf(doc, page = 1) {
  return (doc?.fields || [])
    .filter((f) => (f.page || 1) === page && Array.isArray(f.box) && f.box.length === 4 && f.value !== null && f.value !== '')
    .map((f) => {
      const agent = displayAgent(f.key, f.agent || 'intake', f.confidence);
      return {
        id: `${doc.id}:${f.key}:${page}:${f.box.join(',')}`,
        key: f.key,
        page,
        box: f.box,
        label: `${FIELD_LABELS[f.key] || f.key}: ${f.value}`,
        value: f.value,
        agent,
        color: agentOf(agent).color,
        shown: true,
      };
    });
}

/** The page of a document with the most field boxes (where the reading is best shown). */
export function bestPage(doc) {
  const counts = {};
  for (const f of doc?.fields || []) if (Array.isArray(f.box)) counts[f.page || 1] = (counts[f.page || 1] || 0) + 1;
  const pages = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return pages.length ? Number(pages[0][0]) : 1;
}

// The fields worth a label when a whole page is shown at once (the rest keep just their outline).
export const KEY_FIELDS = [
  'exporter.name', 'consignee.name', 'invoice.number', 'shippingBill.number', 'leo.date', 'awb.mawb', 'awb.hawb', 'carrier.name',
  'kp.certificateNumber', 'kp.countriesOfMining', 'goods.totalCarats', 'goods.totalValue', 'lab.carat', 'lab.reportNumber', 'doc.number', 'supplier.name',
];

/**
 * Decides where each box's label chip goes so chips do not cover each other: right of the box, else left,
 * below or above, else no chip (the outline stays, the label shows on hover). Only the last `max` boxes get a
 * chip, newest first. Box and chip sizes are fractions of the page.
 */
export function layoutChips(boxes, { max = 4, charWidth = 0.0112, chipHeight = 0.026 } = {}) {
  const out = boxes.map((b) => ({ ...b, chip: false }));
  const placed = [];
  const order = out.map((_, i) => i).slice(-max).reverse();
  for (const i of order) {
    const b = out[i];
    if (!b.label || !Array.isArray(b.box)) continue;
    const w = Math.min(0.55, b.label.length * charWidth + 0.018);
    const [x0, y0, x1, y1] = b.box.map(Number);
    const options = [
      ['right', [x1 + 0.008, y0 - 0.002, x1 + 0.008 + w, y0 - 0.002 + chipHeight]],
      ['left', [x0 - 0.008 - w, y0 - 0.002, x0 - 0.008, y0 - 0.002 + chipHeight]],
      ['below', [x0, y1 + 0.004, x0 + w, y1 + 0.004 + chipHeight]],
      ['above', [x0, y0 - 0.004 - chipHeight, x0 + w, y0 - 0.004]],
    ];
    const inside = (r) => r[0] >= 0 && r[2] <= 1 && r[1] >= 0 && r[3] <= 1;
    const free = (r) => !placed.some((p) => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1]);
    const choice = options.find(([, r]) => inside(r) && free(r));
    if (choice) {
      b.chip = choice[0];
      placed.push(choice[1]);
    }
  }
  return out;
}

/** For a still page: label the key fields (at most max), outline the rest. */
export function labelKeyFields(boxes, max = 5) {
  const key = boxes.filter((b) => KEY_FIELDS.includes(b.key)).sort((a, b) => KEY_FIELDS.indexOf(b.key) - KEY_FIELDS.indexOf(a.key));
  const rest = boxes.filter((b) => !KEY_FIELDS.includes(b.key));
  return layoutChips([...rest.map((b) => ({ ...b, label: b.label })), ...key], { max: Math.min(max, key.length) });
}

/** Is this a chat or an email (shown as text, not as a page)? */
export function isConversation(doc) {
  return doc?.kind === 'chat' || doc?.kind === 'email' || doc?.docType === 'whatsapp_chat' || doc?.docType === 'email';
}

/** The latest document worth showing in the still view: read, with field boxes. */
export function latestReadDocument(documents) {
  const time = (d) => String(d.readAt || d.updatedAt || d.createdAt || '');
  return (documents || [])
    .filter((d) => d.status === 'read' && !isConversation(d) && (d.fields || []).some((f) => Array.isArray(f.box)))
    .sort((a, b) => time(b).localeCompare(time(a)))[0] || null;
}

/** A box on the page whose value appears in a message (the Sanctions agent screening a name, say). */
export function boxMentioned(boxes, message) {
  const text = String(message || '').toLowerCase();
  if (!text) return null;
  return boxes.find((b) => b.value && String(b.value).length > 3 && text.includes(String(b.value).toLowerCase())) || null;
}

// Activity rows get a small chip, like the walkthrough: READ, FILED, MISSING, SENT ...
const ACTION_CHIPS = {
  received: 'Received', read: 'Read', filed: 'Filed', opened: 'Opened', skipped: 'On file', missing: 'Missing',
  question: 'Asked', asked: 'Asked', answered: 'Answered', screened: 'Screened', screen: 'Screened', checked: 'Checked',
  check: 'Checked', built: 'Built', paper: 'Built', signed: 'Signed', sent: 'Sent', approved: 'Approved', held: 'Held',
  connected: 'Connected', disconnected: 'Mailbox', folder: 'Folder', request: 'Request', whatsapp: 'WhatsApp', error: 'Error',
  'lab check': 'Lab', autopilot: 'Autopilot', edited: 'Edited', 'shipment.edit': 'Edited', 'document.remove': 'Removed',
  'question.dismiss': 'Dismissed', traced: 'Traced', matched: 'Matched',
};
const ACTION_TONES = { Missing: 'warn', Error: 'fail', Held: 'warn', Signed: 'ok', Sent: 'info', Approved: 'ok', Asked: 'warn' };

export function activityChip(action) {
  const key = String(action || '').toLowerCase();
  const text = ACTION_CHIPS[key] || (key ? key.split(/[ ._]/)[0] : 'Note');
  const label = text.charAt(0).toUpperCase() + text.slice(1);
  return { text: label, tone: ACTION_TONES[label] || 'muted' };
}

/** Who did it, as the feed shows it: "Intake", "Records", a person's name, or "Jewel Labs". */
export function actorName(actor) {
  if (!actor) return 'Agents';
  if (typeof actor === 'string') return actor;
  return actor.name || (actor.type === 'agent' ? 'Agents' : 'Someone');
}

/** The agent id for an activity actor ({ type: 'agent', name: 'Intake' } -> 'intake'), else null. */
export function actorAgentId(actor) {
  if (!actor || actor.type !== 'agent') return null;
  const name = String(actor.name || '').toLowerCase();
  return CURSOR_AGENTS.concat(['retrieval', 'paperwork']).find((id) => id === name || agentOf(id).name.toLowerCase() === name) || null;
}
