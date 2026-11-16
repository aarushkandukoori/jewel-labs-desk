// "Onboard a house": the desk's Connect modal from the walkthrough. Past clients (the house form),
// Connect email, Upload records, WhatsApp (a QR code that opens the chat on a phone).
import { html, useEffect, useRef, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { go } from '../lib/router.js';
import { Modal, Field, Check, Button, Chip } from '../components/ui.js';
import { EmailForm } from './home.js';
import { useUpload, DropZone } from '../components/upload.js';
import { phoneDigits, screeningStatus } from '../lib/format.js';

const COMMODITIES = ['Diamonds', 'Gold', 'Silver', 'Platinum', 'Copper', 'Steel'];
const ROLES = [['exporter', 'Exporter'], ['importer', 'Importer'], ['manufacturer', 'Manufacturer'], ['trader', 'Trader'], ['supplier', 'Supplier']];

export function OnboardModal({ onClose }) {
  const [tab, setTab] = useState('clients');
  const tabs = [['clients', 'Past clients'], ['email', 'Connect email'], ['upload', 'Upload records'], ['whatsapp', 'WhatsApp']];
  const [result, setResult] = useState(null);
  const [form, setForm] = useState({
    name: '', legalName: '', country: '', city: '', role: 'exporter', commodities: ['Diamonds'], contactEmails: '', contactName: '',
    whatsapp: '', portalUser: '', portalEmail: '',
    may: { mailbox: true, whatsapp: true, drafts: false, ofac: true }, autopilot: true,
  });
  const kyc = useRef(null);

  return html`<${Modal} title="Connect: past clients, your email, or upload records" onClose=${onClose} size="wide" label="Onboard a house"
    tabs=${html`<div class="modal-tabs" role="tablist">${tabs.map(([id, label]) => html`<button type="button" role="tab" aria-selected=${tab === id ? 'true' : 'false'} class=${tab === id ? 'active' : ''} onClick=${() => setTab(id)}>${label}</button>`)}</div>`}
    footer=${tab === 'clients' ? html`<${Check} checked=${form.autopilot} onChange=${(on) => setForm({ ...form, autopilot: on })}>Build statements automatically<//>
      <${OnboardButton} form=${form} kyc=${kyc} onDone=${setResult} />` : null}>
    ${tab === 'clients' ? html`<${HouseForm} form=${form} setForm=${setForm} kyc=${kyc} result=${result} onTab=${setTab} onClose=${onClose} />` : null}
    ${tab === 'email' ? html`<div class="modal-sub">Connect the mailbox the agents search for this house’s mail</div><${EmailForm} onDone=${() => setTab('clients')} />` : null}
    ${tab === 'upload' ? html`<${UploadTab} />` : null}
    ${tab === 'whatsapp' ? html`<${WhatsAppTab} numbers=${form.whatsapp} />` : null}
  <//>`;
}

function OnboardButton({ form, kyc, onDone }) {
  const { jl, call, toast } = useApp();
  async function onboard() {
    if (!form.name.trim()) return toast('Name the house first', 'House name is the one field the agents need.', 'warn');
    const list = (text) => String(text || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    const emails = list(form.contactEmails).filter((e) => e.includes('@'));
    const profile = {
      name: form.name.trim(), legalName: form.legalName.trim() || undefined, country: form.country.trim() || undefined,
      city: form.city.trim() || undefined, role: form.role, commodities: form.commodities,
      contactEmails: emails, contactName: form.contactName.trim() || undefined,
      emailDomains: [...new Set(emails.map((e) => e.split('@')[1]))],
      whatsapp: list(form.whatsapp).map(phoneDigits).filter(Boolean),
      portal: form.portalEmail ? { userName: form.portalUser.trim() || undefined, email: form.portalEmail.trim() } : undefined,
      permissions: { searchMailbox: form.may.mailbox, readWhatsapp: form.may.whatsapp, draftRequests: form.may.drafts, screenOfac: form.may.ofac },
      autopilot: form.autopilot,
    };
    const r = await call(jl.desk.onboard(profile));
    if (r) onDone({ ...r, kycFiles: Array.from(kyc.current?.files || []) });
    return undefined;
  }
  return html`<${Button} kind="primary" onClick=${onboard}>Onboard the house<//>`;
}

function HouseForm({ form, setForm, kyc, result, onTab, onClose }) {
  const { jl, call } = useApp();
  const [qr, setQr] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.value });
  const firstNumber = phoneDigits(String(form.whatsapp).split(/[,;]/)[0]);
  const bottom = useRef(null);

  // A QR code for the first WhatsApp number: scanning it opens the chat on the phone.
  useEffect(() => {
    let live = true;
    if (firstNumber.length < 8) { setQr(null); return undefined; }
    const timer = setTimeout(async () => {
      const url = await call(jl.app.qr(`https://wa.me/${firstNumber}`), { quiet: true });
      if (live) setQr(typeof url === 'string' ? url : null);
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [firstNumber]);

  useEffect(() => { if (result) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [result]);

  const toggleCommodity = (c) => setForm({ ...form, commodities: form.commodities.includes(c) ? form.commodities.filter((x) => x !== c) : [...form.commodities, c] });
  const may = (k) => (on) => setForm({ ...form, may: { ...form.may, [k]: on } });

  return html`<div>
    <div class="modal-sub">Onboard a new house</div>
    <div class="form-grid">
      <${Field} label="House name"><input class="input" value=${form.name} onInput=${set('name')} placeholder="As the house trades" /><//>
      <${Field} label="Legal entity"><input class="input" value=${form.legalName} onInput=${set('legalName')} placeholder="As registered" /><//>
      <${Field} label="Country"><input class="input" value=${form.country} onInput=${set('country')} placeholder="India" /><//>
      <${Field} label="City"><input class="input" value=${form.city} onInput=${set('city')} placeholder="Surat" /><//>
      <${Field} label="Role"><select class="select" value=${form.role} onChange=${set('role')}>${ROLES.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select><//>
      <div class="field"><span>Commodities</span><div class="checks inline" style=${{ paddingTop: '6px' }}>${COMMODITIES.map((c) => html`<${Check} checked=${form.commodities.includes(c)} onChange=${() => toggleCommodity(c)}>${c}<//>`)}</div></div>
      <${Field} label="Contact emails" hint="The agents search your mailbox for these email domains."><input class="input" value=${form.contactEmails} onInput=${set('contactEmails')} placeholder="trader@house.com, accounts@house.com" /><//>
      <${Field} label="Contact name"><input class="input" value=${form.contactName} onInput=${set('contactName')} /><//>
      <${Field} label="WhatsApp numbers, with country code" class="span-all"><input class="input" value=${form.whatsapp} onInput=${set('whatsapp')} placeholder="+91 98250 00000" /><//>
    </div>
    ${qr ? html`<div class="qr-card"><img src=${qr} alt=${`QR code for wa.me/${firstNumber}`} />
      <div><div class="num">+${firstNumber}</div><p>Scan with your phone. The chat opens; tap the name, then Export chat, Include media, and drop the zip under WhatsApp.</p>
        <button class="link-btn small" type="button" onClick=${() => call(jl.app.openExternal(`https://wa.me/${firstNumber}`))}>wa.me/${firstNumber}</button></div></div>` : null}
    <div class="modal-sub space">Customer portal login (optional)</div>
    <div class="form-grid">
      <${Field} label="Login user name"><input class="input" value=${form.portalUser} onInput=${set('portalUser')} placeholder="housename" /><//>
      <${Field} label="Their email: invite codes and papers go here"><input class="input" type="email" value=${form.portalEmail} onInput=${set('portalEmail')} placeholder="ops@house.com" /><//>
    </div>
    <div class="modal-sub space">KYC and company documents (trade licence, registration, IDs of owners)</div>
    <input type="file" multiple ref=${kyc} class="input" style=${{ paddingTop: '6px' }} aria-label="KYC files" />
    <div class="modal-sub space">What the agents may do for this house</div>
    <div class="checks" style=${{ padding: '12px', border: '1px solid var(--line-2)', borderRadius: '8px' }}>
      <${Check} checked=${form.may.mailbox} onChange=${may('mailbox')}>Search my connected mailbox for emails from and to these domains<//>
      <${Check} checked=${form.may.whatsapp} onChange=${may('whatsapp')}>Read the WhatsApp chat exports I upload for these numbers<//>
      <${Check} checked=${form.may.drafts} onChange=${may('drafts')}>Draft document requests to these contacts (never sent automatically)<//>
      <${Check} checked=${form.may.ofac} onChange=${may('ofac')}>Screen the house against the OFAC SDN list<//>
    </div>
    ${result ? html`<${OnboardResult} result=${result} onTab=${onTab} onClose=${onClose} />` : null}
    <div ref=${bottom}></div>
  </div>`;
}

function OnboardResult({ result, onTab, onClose }) {
  const { jl, call, toast } = useApp();
  const ws = result.workspace || {};
  const s = result.screening || {};
  const status = screeningStatus(s.status);
  const invite = result.invite;

  async function open() {
    const r = await call(jl.workspaces.select(ws.id));
    if (!r) return;
    if (result.kycFiles?.length) await call(jl.docs.add(result.kycFiles));
    onClose();
    go('desk');
    toast(`Now filing for ${ws.name}`, result.kycFiles?.length ? 'The KYC files went to the agents.' : 'Upload their records or connect their mailbox to begin.', 'ok');
  }

  return html`<div class="result-box" role="status">
    <div class="t">${ws.name} is onboarded.</div>
    <div class="row-flex"><${Chip} tone=${status.tone} small>${status.text}<//>
      <span>${s.status === 'clear' ? `No match on the OFAC SDN list (${s.compared ?? 0} similar names compared).` : s.best ? `Closest SDN name: ${s.best.sdnName}. A person checks it before any paper is built.` : s.note || s.error || 'The screening finishes when the agents run.'}</span></div>
    <div class="row-flex wrap">
      <button class="btn btn-sm btn-primary" type="button" onClick=${() => onTab('email')}>Connect your mailbox</button>
      <button class="btn btn-sm" type="button" onClick=${() => onTab('whatsapp')}>Upload their WhatsApp export</button>
      <button class="btn btn-sm" type="button" onClick=${open}>Open in the dashboard</button>
    </div>
    <div class="row-flex"><${Chip} small tone=${invite?.code ? 'info' : 'muted'}>Login<//>
      <span>${invite?.code ? html`Invite code created: <span class="mono strong">${invite.code}</span>. Send it to them; it works once.` : invite?.error ? invite.error : 'Portal logins need a signed-in desk account. The house can still use the app on its own computer.'}</span></div>
  </div>`;
}

function UploadTab() {
  const upload = useUpload();
  return html`<div>${upload.input}
    <div class="modal-sub">Upload records</div>
    <p class="soft small" style=${{ marginBottom: '4px' }}>The whole shipment folder as a .zip, or any papers. The agents group them into shipments for the open house.</p>
    <${DropZone} upload=${upload} title="Drop the house’s records here, or click to choose" />
  </div>`;
}

function WhatsAppTab({ numbers }) {
  const { jl, call } = useApp();
  const upload = useUpload();
  const [qr, setQr] = useState(null);
  const first = phoneDigits(String(numbers || '').split(/[,;]/)[0]);
  useEffect(() => {
    if (first.length >= 8) call(jl.app.qr(`https://wa.me/${first}`), { quiet: true }).then((u) => setQr(typeof u === 'string' ? u : null));
  }, [first]);
  return html`<div>${upload.input}
    <div class="modal-sub">WhatsApp</div>
    <p class="soft small">In the chat, choose Export chat, then Include media, and add the .zip here. The agents read the messages and the files in it.</p>
    ${qr ? html`<div class="qr-card"><img src=${qr} alt=${`QR code for wa.me/${first}`} /><div><div class="num">+${first}</div><p>Scan with your phone to open the chat.</p></div></div>` : null}
    <div class="form-actions"><button class="btn btn-primary" type="button" onClick=${() => upload.choose('chat')}>Add a chat export</button></div>
  </div>`;
}
