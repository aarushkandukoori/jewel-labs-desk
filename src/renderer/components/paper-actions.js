// What a person does with a paper: open, print, sign (typed name, title, drawn signature, "I am
// authorised"), send (from the house's own mailbox) and download. Shared by Home, Papers and Shipment.
import { html, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { Modal, Field, Check, Button } from './ui.js';
import { SignaturePad } from './signature-pad.js';
import { Icon } from './icons.js';
import { paperKindLabel, day, dayTime } from '../lib/format.js';
import { paperFile, downloadBytes } from '../lib/files.js';

/** The one-line note under a paper: what happens next. */
export function paperNote(paper) {
  if (paper.deskNote && paper.status !== 'sent') return paper.deskNote;
  switch (paper.status) {
    case 'held_for_review': return 'Held for review: Jewel Labs checks it before you sign. You get a message when it is approved.';
    case 'ready_to_sign': return 'Ready to sign. Check it, then sign it and send it from your own mailbox.';
    case 'signed': return `Signed by ${paper.signedBy || 'you'}${paper.signedAt ? ` on ${day(paper.signedAt)}` : ''}. Send it to your broker or download it.`;
    case 'sent': return `Sent to ${paper.sentTo || 'your broker'}${paper.sentAt ? ` on ${dayTime(paper.sentAt)}` : ''}.`;
    case 'draft': return 'A draft from the agents. Check it before you use it.';
    default: return '';
  }
}

/** Hook: { open, print, download, sign, send, modals } for a paper. Render `modals` somewhere in the tree. */
export function usePaperActions() {
  const { jl, call, nav, toast, state } = useApp();
  const [signing, setSigning] = useState(null);
  const [sending, setSending] = useState(null);

  async function print(paper) {
    const result = await call(jl.papers.print(paper.id));
    if (result && result.printed === false) toast('Opened in your PDF app', 'Printing from Jewel Labs did not work, so the paper opened where you can print it.', 'info');
  }

  async function download(paper) {
    if (!state.demo) {
      const result = await call(jl.papers.save(paper.id));
      if (result?.path) {
        const parts = result.path.split(/[\\/]/);
        const where = parts.length > 1 ? ` in ${parts[parts.length - 2]}` : '';
        const label = /Mac/i.test(navigator.platform || navigator.userAgent || '') ? 'Show in Finder' : 'Show in folder';
        toast('Saved', `${parts[parts.length - 1]}${where}`, 'ok', { label, run: () => call(jl.app.showItem(result.path)) });
      }
      return;
    }
    const file = await paperFile(paper).catch((e) => (toast('Could not download', e.message, 'error'), null));
    if (file) downloadBytes(file.bytes, file.name || `${paper.ref}-v${paper.version}.pdf`);
  }

  async function openExternal(paper) {
    await call(jl.papers.open(paper.id));
  }

  const modals = html`
    ${signing ? html`<${SignModal} paper=${signing} onClose=${() => setSigning(null)} onSigned=${(p) => { setSigning(null); if (p) setSending(p); }} />` : null}
    ${sending ? html`<${SendModal} paper=${sending} onClose=${() => setSending(null)} onDownload=${download} />` : null}
  `;

  return {
    open: (paper, query) => nav.paper(paper.id, query),
    openExternal,
    print,
    download,
    sign: (paper) => setSigning(paper),
    send: (paper) => setSending(paper),
    modals,
  };
}

/** The buttons for one paper, as on the walkthrough: Open / Print / Parcel sheets / Sign / Send. */
export function PaperButtons({ paper, actions, compact }) {
  const hasHandover = (paper.contents || []).some((c) => /handover|parcel|envelope/i.test(c.title || ''));
  return html`<div class="actions">
    <button class="btn btn-sm" type="button" onClick=${() => actions.open(paper)} title="Open the paper here">Open</button>
    <button class="btn btn-sm" type="button" onClick=${() => actions.print(paper)} title="Print the paper">Print</button>
    ${!compact && (hasHandover || paper.kind === 'export_pack' || paper.kind === 'import_pack')
      ? html`<button class="btn btn-sm" type="button" onClick=${() => actions.open(paper, { page: 'handover' })} title="The neutral parcel cover and the handover record">Parcel sheets</button>` : null}
    ${paper.status === 'ready_to_sign' ? html`<button class="btn btn-sm btn-primary" type="button" onClick=${() => actions.sign(paper)}>${Icon.pen()}Sign</button>` : null}
    ${paper.status === 'signed' ? html`<button class="btn btn-sm btn-primary" type="button" onClick=${() => actions.send(paper)}>${Icon.send()}Send</button>` : null}
    ${paper.status === 'sent' ? html`<button class="btn btn-sm" type="button" onClick=${() => actions.send(paper)}>Send again</button>` : null}
  </div>`;
}

export function SignModal({ paper, onClose, onSigned }) {
  const { jl, call, state, toast } = useApp();
  const house = state.workspace?.legalEntity || state.workspace?.name || 'the house';
  const [name, setName] = useState(state.settings?.userName || state.auth?.user?.name || '');
  const [title, setTitle] = useState(state.settings?.signerTitle || 'Director');
  const [signature, setSignature] = useState(null);
  const [authorised, setAuthorised] = useState(false);
  const [error, setError] = useState(null);

  async function sign() {
    setError(null);
    if (!name.trim()) return setError('Type the name of the person signing.');
    if (!authorised) return setError(`Confirm that you are authorised to sign for ${house}.`);
    const signed = await call(jl.papers.sign(paper.id, { name: name.trim(), title: title.trim(), signatureDataUrl: signature || undefined }));
    if (!signed) return undefined;
    toast(`Signed ${paper.ref}`, 'The pack is locked: its SHA-256 fingerprint is recorded. Send it when you are ready.', 'ok');
    onSigned?.(signed && signed.id ? signed : { ...paper, status: 'signed', signedBy: name });
    return undefined;
  }

  return html`<${Modal} title=${`Sign ${paper.ref} v${paper.version || 1}`} onClose=${onClose} size="narrow"
    footer=${html`<span class="muted small">${paperKindLabel(paper.kind)}</span>
      <div class="row-flex"><button class="btn" type="button" onClick=${onClose}>Cancel</button>
      <${Button} kind="primary" onClick=${sign} icon=${Icon.pen}>Sign the paper<//></div>`}>
    <div class="form-grid">
      <${Field} label="Name of the person signing"><input class="input" value=${name} onInput=${(e) => setName(e.currentTarget.value)} autocomplete="name" /><//>
      <${Field} label="Title"><input class="input" value=${title} onInput=${(e) => setTitle(e.currentTarget.value)} placeholder="Director" /><//>
      <div class="span-all"><span class="field-label">Signature</span><div class="mt-8"><${SignaturePad} onChange=${setSignature} /></div></div>
      <div class="span-all"><${Check} checked=${authorised} onChange=${setAuthorised}>I am authorised to sign for ${house}.<//></div>
    </div>
    <div class="form-help">Signing locks this version of the pack. Any change after this makes a new version that needs a new signature.</div>
    ${error ? html`<div class="form-error" role="alert">${error}</div>` : null}
  <//>`;
}

export function SendModal({ paper, onClose, onDownload }) {
  const { jl, call, state, toast, nav } = useApp();
  const shipment = state.data.shipments.find((s) => s.id === paper.shipmentId);
  const house = state.workspace?.name || 'our house';
  const [to, setTo] = useState(paper.sentTo || state.workspace?.brokerEmail || '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(`${paperKindLabel(paper.kind)} ${paper.ref}${shipment?.ref ? ` for ${shipment.ref}` : ''}`);
  const [body, setBody] = useState(
    `Hello,\n\nAttached is the signed ${paperKindLabel(paper.kind).toLowerCase()} ${paper.ref}${shipment?.ref ? ` for shipment ${shipment.ref}` : ''}`
    + `${shipment?.consignee?.name ? ` to ${shipment.consignee.name}` : ''}. The originals follow in the order customs reads them.\n\n`
    + `Please lodge it with the declaration.\n\nRegards,\n${state.settings?.userName || ''}\n${house}`.trimEnd(),
  );
  const [problem, setProblem] = useState(null);

  async function send() {
    setProblem(null);
    const result = await jl.papers.send(paper.id, { to, cc: cc || undefined, subject, body }).catch((e) => ({ error: e.message }));
    if (result?.error) {
      setProblem(result);
      return;
    }
    toast(`Sent ${paper.ref}`, `To ${to}, from your mailbox.`, 'ok');
    onClose();
  }

  return html`<${Modal} title=${`Send ${paper.ref}`} onClose=${onClose}
    footer=${html`<button class="btn" type="button" onClick=${() => onDownload(paper)}>${Icon.download()}Download instead</button>
      <div class="row-flex"><button class="btn" type="button" onClick=${onClose}>Cancel</button>
      <${Button} kind="primary" onClick=${send} icon=${Icon.send} disabled=${!to.trim()}>Send from my mailbox<//></div>`}>
    <div class="form-grid">
      <${Field} label="To" class="span-2"><input class="input" type="email" multiple value=${to} onInput=${(e) => setTo(e.currentTarget.value)} placeholder="broker@example.com" /><//>
      <${Field} label="Cc" class="span-2"><input class="input" value=${cc} onInput=${(e) => setCc(e.currentTarget.value)} placeholder="Optional" /><//>
      <${Field} label="Subject" class="span-2"><input class="input" value=${subject} onInput=${(e) => setSubject(e.currentTarget.value)} /><//>
      <${Field} label="Message" class="span-2"><textarea class="textarea" rows="8" value=${body} onInput=${(e) => setBody(e.currentTarget.value)}></textarea><//>
    </div>
    <div class="row-flex mt-12 small soft">${Icon.lock({ class: 'soft' })}<span>The signed PDF goes as an attachment. Jewel Labs never lodges it: your broker or your house does.</span></div>
    ${problem ? html`<div class="form-error" role="alert">${problem.error}
      ${problem.code === 'no_mailbox' ? html` <button class="link-btn" type="button" onClick=${() => { onClose(); nav.settings('mailbox'); }}>Connect a mailbox</button>` : null}</div>` : null}
  <//>`;
}

