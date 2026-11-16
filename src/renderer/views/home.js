// House home, the customer portal: 1. Connect, 2. Documents (with the agents reading live),
// 3. Tell the agents, 4. Back from Jewel Labs. Laid out like the walkthrough video.
import { html, useEffect, useMemo, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { Section, Button, Chip, Dot, Field, Check, StatusChip } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { AgentsReading } from '../components/reader.js';
import { TellTheAgents } from '../components/chat.js';
import { QuestionRow } from '../components/questions.js';
import { useUpload, DropZone } from '../components/upload.js';
import { usePaperActions, PaperButtons, paperNote } from '../components/paper-actions.js';
import { agentStripCounts, stillNeeded, busyAgents } from '../lib/store.js';
import { activityChip, actorName } from '../lib/reading.js';
import { plural, clock, ago, paperStatus, shipmentStatus } from '../lib/format.js';

export function HomeView() {
  const { state } = useApp();
  const upload = useUpload();
  const name = state.workspace?.name || 'Your house';
  return html`<div class="page-inner">
    ${upload.input}
    <header class="portal-head">
      <div class="eyebrow">Customer portal${state.workspace?.sample ? ' · Sample workspace' : ''}</div>
      <h1>${name}</h1>
    </header>
    <${ConnectSection} upload=${upload} />
    <${DocumentsSection} upload=${upload} />
    <${TellTheAgents} title="3. Tell the agents" id="tell" />
    <${BackFromJewelLabs} />
    <p class="footnote">What you upload stays in your workspace and is filed under your house only.</p>
  </div>`;
}

// ───────── 1. Connect ─────────

const PROVIDERS = [
  { value: 'gmail', label: 'Gmail or Google Workspace', help: 'myaccount.google.com/apppasswords' },
  { value: 'outlook', label: 'Outlook or Microsoft 365', help: 'account.microsoft.com, Security, App passwords' },
  { value: 'icloud', label: 'iCloud Mail', help: 'account.apple.com, Sign-In and Security, App-Specific Passwords' },
  { value: 'yahoo', label: 'Yahoo Mail', help: 'login.yahoo.com/account/security, Generate app password' },
  { value: 'zoho', label: 'Zoho Mail', help: 'accounts.zoho.com, Security, App Passwords' },
  { value: 'custom', label: 'Other (IMAP)', help: 'your provider’s settings page' },
];

function ConnectSection({ upload }) {
  const { jl, call, toast, state } = useApp();
  const [mail, setMail] = useState(null);
  const [folder, setFolder] = useState(null);
  const [form, setForm] = useState(false);

  async function refresh() {
    const [m, f] = await Promise.all([call(jl.mail.status(), { quiet: true }), call(jl.folder.status(), { quiet: true })]);
    setMail(m);
    setFolder(f);
  }
  useEffect(() => { refresh(); }, [state.workspace?.id]);

  async function chooseFolder() {
    const result = await call(jl.folder.choose());
    if (result && !result.canceled) {
      setFolder(result);
      toast('Watching the folder', 'New files there go to the agents on their own.', 'ok');
    }
  }

  async function checkNow() {
    const result = await call(jl.mail.pollNow());
    if (result) {
      setMail(result);
      toast('Mailbox checked', result.pulled ? `${plural(result.pulled, 'new email')} brought in.` : 'No new shipment mail.', 'ok');
    }
  }

  async function disconnect() {
    const result = await call(jl.mail.disconnect());
    if (result !== null) {
      setMail(typeof result === 'object' ? result : { connected: false });
      toast('Mailbox disconnected', 'The agents stop checking it. The app password was removed from this computer.', 'ok');
    }
  }

  const connected = mail?.connected;
  return html`<${Section} title="1. Connect">
    <div class="rows">
      <div>
        <div class="row">
          <div class="row-main">
            <div class="row-title">Email</div>
            <div class="row-sub">${connected
              ? html`Connected to <b class="strong">${mail.email}</b>. The agents check it every 5 minutes${mail.lastPollAt ? `, last ${ago(mail.lastPollAt)}` : ''}.`
              : mail?.needsPassword
                ? html`${mail.email}: enter the app password again to keep checking it.`
                : 'Gmail, Google Workspace, iCloud, Yahoo or Zoho. The agents read your shipment mail and file it.'}</div>
          </div>
          <div class="row-actions">
            ${connected ? html`<${Button} size="sm" onClick=${checkNow} icon=${Icon.refresh}>Check now<//><${Button} size="sm" kind="ghost" onClick=${disconnect}>Disconnect<//>`
              : html`<button class="btn btn-sm" type="button" onClick=${() => setForm(!form)} aria-expanded=${form ? 'true' : 'false'}>${form ? 'Close' : 'Connect email'}</button>`}
          </div>
        </div>
        ${form && !connected ? html`<${EmailForm} onDone=${(m) => { setForm(false); if (m) setMail(m); refresh(); }} />` : null}
      </div>
      <div class="row">
        <div class="row-main"><div class="row-title">WhatsApp</div><div class="row-sub">In the chat, choose Export chat with media, then add the .zip here.</div></div>
        <div class="row-actions"><button class="btn btn-sm" type="button" onClick=${() => upload.choose('chat')}>Add a chat export</button></div>
      </div>
      <div class="row">
        <div class="row-main"><div class="row-title">Watched folder</div>
          <div class="row-sub">${folder?.watching
            ? html`Watching <span class="mono small strong">${folder.path}</span>${folder.lastScanAt ? `, looked ${ago(folder.lastScanAt)}` : ''}.`
            : 'Pick a folder on this computer. Anything saved there goes to the agents on its own.'}</div></div>
        <div class="row-actions"><button class="btn btn-sm" type="button" onClick=${chooseFolder}>${folder?.watching ? 'Change folder' : 'Choose a folder'}</button></div>
      </div>
      <div class="row">
        <div class="row-main"><div class="row-title">Forward</div>
          <div class="row-sub">${state.workspace?.forwardAddress
            ? html`Forward invoices and shipping mail from any provider to <span class="mono strong">${state.workspace.forwardAddress}</span>.`
            : 'Forward invoices and shipping mail from any provider to your Jewel Labs inbox. Ask Jewel Labs for your house’s address.'}</div></div>
      </div>
    </div>
  <//>`;
}

export function EmailForm({ onDone }) {
  const { jl, call, toast } = useApp();
  const [provider, setProvider] = useState('gmail');
  const [email, setEmail] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [since, setSince] = useState('');
  const [keep, setKeep] = useState(true);
  const [host, setHost] = useState('');
  const help = PROVIDERS.find((p) => p.value === provider)?.help;

  async function connect() {
    const result = await call(jl.mail.connect({ provider, email: email.trim(), appPassword, since: since || undefined, keepConnected: keep, host: host || undefined }));
    if (!result) return;
    toast('Mailbox connected', result.warning || `The agents check ${email.trim()} every 5 minutes and file new consignment mail.`, result.warning ? 'warn' : 'ok');
    setAppPassword('');
    onDone(result);
  }

  return html`<form class="connect-form" onSubmit=${(e) => { e.preventDefault(); connect(); }}>
    <div class="form-grid cols-4">
      <${Field} label="Provider"><select class="select" value=${provider} onChange=${(e) => setProvider(e.currentTarget.value)}>
        ${PROVIDERS.map((p) => html`<option value=${p.value}>${p.label}</option>`)}</select><//>
      <${Field} label="Email"><input class="input" type="email" value=${email} onInput=${(e) => setEmail(e.currentTarget.value)} autocomplete="email" placeholder="you@yourhouse.com" /><//>
      <${Field} label="App password"><input class="input" type="password" value=${appPassword} onInput=${(e) => setAppPassword(e.currentTarget.value)} autocomplete="off" /><//>
      <${Field} label="Emails since"><input class="input" type="date" value=${since} onInput=${(e) => setSince(e.currentTarget.value)} /><//>
      ${provider === 'custom' ? html`<${Field} label="IMAP server" class="span-2"><input class="input" value=${host} onInput=${(e) => setHost(e.currentTarget.value)} placeholder="imap.yourhouse.com" /><//>` : null}
    </div>
    <div class="mt-12"><${Check} checked=${keep} onChange=${setKeep}>Keep connected: the agents check it every 5 minutes and file new consignment mail on their own<//></div>
    <div class="form-actions">
      <${Button} kind="primary" size="sm" onClick=${connect} disabled=${!email.trim() || !appPassword}>Connect and bring in<//>
      <button class="btn btn-sm" type="button" onClick=${() => onDone(null)}>Cancel</button>
    </div>
    <div class="form-help">Use an app password, not your normal one (${help}). With Keep connected it is stored encrypted on this computer until you disconnect.</div>
  </form>`;
}

// ───────── 2. Documents ─────────

function DocumentsSection({ upload }) {
  const { state, nav } = useApp();
  const counts = agentStripCounts(state);
  const busy = busyAgents(state);
  const needs = stillNeeded(state);
  const questions = state.data.questions.filter((q) => q.status === 'open' && q.kind !== 'missing_document');
  const complete = state.data.shipments.filter((s) => s.status === 'ready_to_sign' || s.status === 'held_for_review');
  const sentCount = state.data.documents.filter((d) => d.source?.kind !== 'generated').length;

  const intakeText = counts.reading ? `Reading ${counts.reading.fileName}` : counts.total ? `${plural(counts.read, 'document')} read` : 'Waiting';
  const recordsText = counts.total ? `${counts.filed} filed${counts.unfiled ? `, ${counts.unfiled} waiting for a shipment` : ''}` : 'Waiting';
  const reviewText = counts.missing ? `${plural(counts.missing, 'document')} still missing` : questions.length ? `${plural(questions.length, 'question')} for you` : counts.total ? 'Nothing missing' : 'Waiting';

  return html`<section class="section" aria-label="2. Documents">
    <div class="section-head"><div class="label">2. Documents</div><div class="counter">${plural(sentCount, 'document')} sent</div></div>
    <${DropZone} upload=${upload} />
    <div class="agent-strip">
      <div><div class="name"><${Dot} agent="intake" pulse=${Boolean(busy.intake)} />Intake agent</div><div class="what">${intakeText}</div></div>
      <div><div class="name"><${Dot} agent="records" pulse=${Boolean(busy.records)} />Records agent</div><div class="what">${recordsText}</div></div>
      <div><div class="name"><${Dot} agent="review" pulse=${Boolean(busy.review)} />Review agent</div><div class="what">${reviewText}</div></div>
    </div>
    <${AgentsReading} documents=${state.data.documents} onOpen=${(docId, key) => nav.document(docId, key)} />
    <${Feed} />
    <div class="needs">
      ${!state.data.documents.length
        ? html`<div class="section-note">The agents ask first for the commercial invoice and the packing list for your parcel. Drop them above.</div>`
        : html`<div class="needs-head"><span class="t">${needs.length || questions.length ? 'Your documents are filed. A few things are still needed.' : 'Your documents are filed. Now tell the agents what you need.'}</span>
            <button class="btn btn-sm" type="button" onClick=${() => document.getElementById('tell')?.scrollIntoView({ behavior: 'smooth' })}>Tell the agents</button></div>`}
      ${complete.map((s) => html`<div class="needs-row" key=${s.id}>
        <div class="what"><button class="link-btn strong" type="button" onClick=${() => nav.shipment(s.id)}>${s.ref}</button><span>${s.status === 'held_for_review' ? 'every document is on file. Jewel Labs is reviewing the pack.' : 'every document is on file.'}</span></div>
        <${StatusChip} status=${shipmentStatus(s.status)} small />
      </div>`)}
      ${needs.map(({ shipment, missing }) => html`<div class="needs-group" key=${shipment.id}>
        <div class="gtitle">For <b>${shipment.ref}</b>, the agents still need:</div>
        ${missing.map((q) => html`<div class="needs-row" key=${q.id}>
          <div class="what"><${Chip} tone="warn" small>Missing<//><span class="ellipsis">${q.text}</span></div>
          <button class="btn btn-sm" type="button" onClick=${() => upload.choose()}>Upload it</button>
        </div>`)}
      </div>`)}
      ${questions.length ? html`<div class="needs-group">
        <div class="gtitle">The agents ask:</div>
        ${questions.map((q) => html`<${QuestionRow} key=${q.id} question=${q} onUpload=${() => upload.choose()} />`)}
      </div>` : null}
    </div>
  </section>`;
}

/** The latest steps by the agents and people, each with a small chip (READ, FILED, MISSING ...). */
function Feed() {
  const { state, nav } = useApp();
  const rows = useMemo(() => state.data.activity.slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 7), [state.data.activity]);
  if (!rows.length) return null;
  return html`<div class="feed" aria-label="Latest activity">
    ${rows.map((a) => {
      const chip = activityChip(a.action);
      return html`<div class="feed-row" key=${a.id}>
        <span class="who ellipsis">${actorName(a.actor)}</span>
        <${Chip} tone=${chip.tone} small>${chip.text}<//>
        <span class="what">${a.detail}</span>
        <span class="when">${clock(a.at)}</span>
      </div>`;
    })}
    <div class="feed-row" style=${{ gridTemplateColumns: '1fr' }}><button class="link-btn small" type="button" onClick=${() => nav.activity()}>All activity (${state.data.activity.length})</button></div>
  </div>`;
}

// ───────── 4. Back from Jewel Labs ─────────

function BackFromJewelLabs() {
  const { state, nav } = useApp();
  const actions = usePaperActions();
  const papers = state.data.papers
    .slice()
    .sort((a, b) => String(b.updatedAt || b.builtAt || '').localeCompare(String(a.updatedAt || a.builtAt || '')))
    .slice(0, 6);
  return html`<${Section} title="4. Back from Jewel Labs" right=${html`<button class="btn btn-sm" type="button" onClick=${() => nav.papers()}>All papers</button>`}>
    ${!papers.length
      ? html`<div class="section-note soft">Nothing back yet. When the agents finish a shipment, its papers come back here ready to sign.</div>`
      : html`<div class="rows">${papers.map((p) => {
          const shipment = state.data.shipments.find((s) => s.id === p.shipmentId);
          return html`<div class="paper-row" key=${p.id}>
            <div class="main">
              <div class="line1"><span class="ref">${p.ref}</span>${shipment ? html`<span class="muted">·</span><span class="strong">${shipment.ref}</span>` : null}
                <${StatusChip} status=${paperStatus(p.status)} small /></div>
              <div class="note">${paperNote(p)}</div>
            </div>
            <${PaperButtons} paper=${p} actions=${actions} />
          </div>`;
        })}</div>`}
    ${actions.modals}
  <//>`;
}
