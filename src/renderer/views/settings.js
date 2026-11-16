// Settings: the house profile and letterhead, the team, the AI the agents use, the mailbox and
// watched folder, autopilot, start at login, Sandbox or Live, and About.
import { html, useEffect, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { Button, Field, Toggle, Segmented, CopyButton, Chip } from '../components/ui.js';
import { Icon } from '../components/icons.js';
import { EmailForm } from './home.js';
import { ROLE_LABELS } from '../lib/labels.js';
import { ago, initials } from '../lib/format.js';

const SECTIONS = [
  ['profile', 'House profile'], ['team', 'Team'], ['ai', 'AI'], ['mailbox', 'Mailbox'], ['folder', 'Watched folder'],
  ['agents', 'Autopilot'], ['environment', 'Sandbox or Live'], ['about', 'About'],
];

export function SettingsView({ section }) {
  const { nav } = useApp();
  const active = SECTIONS.some(([id]) => id === section) ? section : 'profile';
  useEffect(() => {
    document.getElementById(`settings-${active}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [active]);
  return html`<div class="page-inner wide">
    <div class="page-head"><div><div class="eyebrow">Settings</div><h1>Your house, your team, your agents</h1></div></div>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        ${SECTIONS.map(([id, label]) => html`<button type="button" class=${active === id ? 'active' : ''} onClick=${() => nav.settings(id)}>${label}</button>`)}
      </nav>
      <div>
        <${Profile} /><${Team} /><${AISettings} /><${Mailbox} /><${Folder} /><${Agents} /><${Environment} /><${About} />
      </div>
    </div>
  </div>`;
}

function Profile() {
  const { state, jl, call, dispatch, toast } = useApp();
  const ws = state.workspace || {};
  const [form, setForm] = useState({});
  useEffect(() => {
    setForm({
      name: ws.name || '', legalName: ws.legalName || '', address: ws.address || '', city: ws.city || '', country: ws.country || '',
      eori: ws.eori || '', taxId: ws.taxId || '', letterhead: ws.letterhead || '', brokerEmail: ws.brokerEmail || '',
    });
  }, [ws.id, ws.updatedAt]);
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.value });

  async function save() {
    const saved = await call(jl.workspaces.update(form));
    if (saved) {
      dispatch({ type: 'workspace', workspace: { ...ws, ...saved } });
      toast('Profile saved', 'It goes on every statement and pack the agents build.', 'ok');
    }
  }

  return html`<section class="section" id="settings-profile" aria-label="House profile">
    <div class="section-head"><div class="label">House profile and letterhead</div><div class="right-side">Goes on every statement</div></div>
    <div class="section-body">
      <div class="form-grid">
        <${Field} label="House name"><input class="input" value=${form.name} onInput=${set('name')} /><//>
        <${Field} label="Legal entity"><input class="input" value=${form.legalName} onInput=${set('legalName')} placeholder="As registered" /><//>
        <${Field} label="Registered address" class="span-2"><input class="input" value=${form.address} onInput=${set('address')} /><//>
        <${Field} label="City"><input class="input" value=${form.city} onInput=${set('city')} /><//>
        <${Field} label="Country"><input class="input" value=${form.country} onInput=${set('country')} placeholder="IN" /><//>
        <${Field} label="EORI number" hint="Needed for imports into the EU"><input class="input input-mono" value=${form.eori} onInput=${set('eori')} /><//>
        <${Field} label="Tax or exporter ID" hint="IEC, GSTIN, VAT or EIN"><input class="input input-mono" value=${form.taxId} onInput=${set('taxId')} /><//>
        <${Field} label="Letterhead line" class="span-2" hint="One line under your name at the top of each paper"><input class="input" value=${form.letterhead} onInput=${set('letterhead')} placeholder="Diamond exporters since 1998 · Surat" /><//>
        <${Field} label="Your broker's email" class="span-2" hint="Filled in when you send a signed pack"><input class="input" type="email" value=${form.brokerEmail} onInput=${set('brokerEmail')} /><//>
      </div>
      <div class="form-actions"><${Button} kind="primary" size="sm" onClick=${save}>Save the profile<//></div>
    </div>
  </section>`;
}

function Team() {
  const { state, jl, call } = useApp();
  const [members, setMembers] = useState(null);
  const [role, setRole] = useState('preparer');
  const [code, setCode] = useState(null);
  useEffect(() => { call(jl.workspaces.members(), { quiet: true }).then((m) => setMembers(Array.isArray(m) ? m : [])); }, [state.workspace?.id]);

  async function invite() {
    const result = await call(jl.workspaces.invite(role));
    if (result?.code) setCode(result);
  }

  const signedIn = state.auth?.signedIn;
  return html`<section class="section" id="settings-team" aria-label="Team">
    <div class="section-head"><div class="label">Team</div><div class="right-side">${members ? `${members.length} ${members.length === 1 ? 'person' : 'people'}` : ''}</div></div>
    <div class="rows">
      ${(members || []).map((m, i) => html`<div class="row compact" key=${m.id || m.email || i}>
        <div class="row-flex"><span class="avatar" style=${{ background: '#c4c6ca', marginLeft: 0, width: '26px', height: '26px' }}>${initials(m.name || m.email)}</span>
          <div><div class="row-title">${m.name || m.email}${m.you ? html` <span class="muted">(you)</span>` : null}</div><div class="row-sub">${m.email || 'On this computer'}</div></div></div>
        <${Chip} small>${ROLE_LABELS[m.role] || m.role}<//>
      </div>`)}
    </div>
    <div class="section-body" style=${{ borderTop: '1px solid var(--line)' }}>
      ${signedIn ? html`<div class="row-flex wrap">
          <span class="soft">Invite someone as</span>
          <select class="select input-sm" style=${{ width: '150px', height: '30px' }} value=${role} onChange=${(e) => setRole(e.currentTarget.value)}>
            <option value="preparer">Preparer</option><option value="viewer">Viewer</option><option value="owner">Owner</option>
          </select>
          <${Button} size="sm" onClick=${invite} icon=${Icon.plus}>Create an invite code<//>
        </div>
        ${code ? html`<div class="code-box mt-12"><span>${code.code}</span><span class="spacer" style=${{ flex: 1 }}></span><${CopyButton} text=${code.code} /></div>
          <div class="form-help">They install Jewel Labs, choose Create an account, and paste this code. It works once.</div>` : null}`
        : html`<div class="soft">Your work is on this computer only. ${state.demo ? 'In the desktop app, sign in' : html`<button class="link-btn" type="button" onClick=${() => location.assign('#/welcome')}>Sign in</button>`} to share one workspace with your whole team.</div>`}
    </div>
  </section>`;
}

function AISettings() {
  const { state, jl, call, toast, refreshInfo } = useApp();
  const s = state.settings || {};
  const ai = state.info?.ai || {};
  const [key, setKey] = useState('');

  async function saveKey() {
    const result = await call(jl.settings.set({ openaiKey: key.trim() }));
    if (result) {
      setKey('');
      toast('Key saved', result.warning || 'Stored encrypted on this computer. The agents use it from now on.', result.warning ? 'warn' : 'ok');
      refreshInfo();
    }
  }
  async function removeKey() {
    const result = await call(jl.settings.set({ openaiKey: '' }));
    if (result) { toast('Key removed', 'The agents use the Jewel Labs cloud when you are signed in, else the offline reader.', 'ok'); refreshInfo(); }
  }
  async function setModel(model) {
    const result = await call(jl.settings.set({ model: model || null }));
    if (result) { toast('Model changed', model || 'The default model', 'ok'); refreshInfo(); }
  }

  const modeText = ai.mode === 'direct' ? 'Your own OpenAI key' : ai.mode === 'proxy' ? 'Jewel Labs cloud' : ai.mode === 'demo' ? 'Demo (recorded answers)' : 'Offline reader (no AI)';
  return html`<section class="section" id="settings-ai" aria-label="AI">
    <div class="section-head"><div class="label">AI</div><div class="right-side"><${Chip} small tone=${ai.mode === 'off' ? 'warn' : 'ok'}>${modeText}<//></div></div>
    <div class="setting-row">
      <div><div class="t">Who reads the papers</div><div class="d">Signed in, the agents use the Jewel Labs cloud (OpenAI, billed to Jewel Labs). With your own OpenAI key, calls go straight from this computer to OpenAI. With neither, an offline reader reads the text layer and OCR; it is less accurate.</div></div>
    </div>
    <div class="setting-row">
      <div style=${{ flex: 1 }}><div class="t">Your own OpenAI key</div><div class="d">${s.hasOpenAIKey ? 'A key is saved, encrypted on this computer.' : 'Optional. Stored encrypted with the system keychain, never in plain text.'}</div>
        <div class="row-flex mt-8"><input class="input input-mono" type="password" value=${key} onInput=${(e) => setKey(e.currentTarget.value)} placeholder="sk-..." autocomplete="off" aria-label="OpenAI API key" style=${{ maxWidth: '380px' }} />
          <${Button} size="sm" onClick=${saveKey} disabled=${!key.trim()}>Save key<//>
          ${s.hasOpenAIKey ? html`<${Button} size="sm" kind="ghost" onClick=${removeKey}>Remove<//>` : null}</div></div>
    </div>
    <div class="setting-row">
      <div><div class="t">Model</div><div class="d">Now: <span class="mono">${ai.model || 'default'}</span>. The cheapest capable model is the default; the app falls back down the list if one is not available.</div></div>
      <div class="ctl"><select class="select input-sm" style=${{ width: '190px', height: '30px' }} value=${s.model || ''} onChange=${(e) => setModel(e.currentTarget.value)}>
        <option value="">Default</option>${(s.models || []).map((m) => html`<option value=${m}>${m}</option>`)}</select></div>
    </div>
  </section>`;
}

function Mailbox() {
  const { jl, call, toast, state } = useApp();
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(false);
  const refresh = () => call(jl.mail.status(), { quiet: true }).then(setStatus);
  useEffect(() => { refresh(); }, [state.workspace?.id]);
  return html`<section class="section" id="settings-mailbox" aria-label="Mailbox">
    <div class="section-head"><div class="label">Mailbox</div><div class="right-side">${status?.connected ? html`<${Chip} small tone="ok">Connected<//>` : html`<${Chip} small>Not connected<//>`}</div></div>
    <div class="setting-row">
      <div><div class="t">${status?.connected ? status.email : 'Connect your company email'}</div>
        <div class="d">${status?.connected ? `Checked every 5 minutes${status.lastPollAt ? `, last ${ago(status.lastPollAt)}` : ''}. Signed packs are sent from this mailbox.` : 'The agents check it every 5 minutes, file new consignment mail, and send signed packs from it.'}
          ${status?.lastError ? html`<div class="fail small mt-4">${status.lastError}</div>` : null}</div></div>
      <div class="ctl">${status?.connected
        ? html`<${Button} size="sm" onClick=${async () => { const r = await call(jl.mail.pollNow()); if (r) { setStatus(r); toast('Mailbox checked', '', 'ok'); } }}>Check now<//>
            <${Button} size="sm" kind="ghost" onClick=${async () => { await call(jl.mail.disconnect()); refresh(); }}>Disconnect<//>`
        : html`<button class="btn btn-sm" type="button" onClick=${() => setForm(!form)}>${form ? 'Close' : 'Connect email'}</button>`}</div>
    </div>
    ${form && !status?.connected ? html`<${EmailForm} onDone=${(r) => { setForm(false); if (r) setStatus(r); refresh(); }} />` : null}
  </section>`;
}

function Folder() {
  const { jl, call, toast, state } = useApp();
  const [status, setStatus] = useState(null);
  useEffect(() => { call(jl.folder.status(), { quiet: true }).then(setStatus); }, [state.workspace?.id]);
  async function choose() {
    const r = await call(jl.folder.choose());
    if (r && !r.canceled) { setStatus(r); toast('Watching the folder', r.path, 'ok'); }
  }
  return html`<section class="section" id="settings-folder" aria-label="Watched folder">
    <div class="section-head"><div class="label">Watched folder</div></div>
    <div class="setting-row">
      <div><div class="t">${status?.watching ? html`<span class="mono">${status.path}</span>` : 'No folder yet'}</div>
        <div class="d">${status?.watching ? `${status.files || 0} files seen${status.lastScanAt ? `, last looked ${ago(status.lastScanAt)}` : ''}.` : 'Save papers into a folder (or let your scanner do it) and the agents pick them up on their own.'}</div></div>
      <div class="ctl"><${Button} size="sm" onClick=${choose} icon=${Icon.folder}>${status?.watching ? 'Change folder' : 'Choose a folder'}<//></div>
    </div>
  </section>`;
}

function Agents() {
  const { state, jl, call, setAutopilot, dispatch } = useApp();
  const s = state.settings || {};
  async function set(patch) {
    const result = await call(jl.settings.set(patch));
    if (result) dispatch({ type: 'settings', settings: result });
  }
  return html`<section class="section" id="settings-agents" aria-label="Autopilot">
    <div class="section-head"><div class="label">Autopilot</div></div>
    <div class="setting-row"><div><div class="t">Autopilot</div><div class="d">The agents read new papers, trace the stones, run the rules and build the pack on their own. Off, they wait until you press Space.</div></div>
      <div class="ctl"><${Toggle} checked=${state.autopilot} onChange=${setAutopilot} label=${state.autopilot ? 'On' : 'Off'} /></div></div>
    <div class="setting-row"><div><div class="t">Notifications</div><div class="d">A desktop notice when a pack is ready to sign or Jewel Labs sends a message.</div></div>
      <div class="ctl"><${Toggle} checked=${s.notifications !== false} onChange=${(on) => set({ notifications: on })} /></div></div>
    <div class="setting-row"><div><div class="t">Start at login</div><div class="d">With autopilot on, Jewel Labs starts quietly in the ${/Win/i.test(navigator.platform) ? 'system tray' : 'menu bar'} and keeps reading new mail.</div></div>
      <div class="ctl"><${Toggle} checked=${Boolean(s.launchAtLogin)} onChange=${(on) => set({ launchAtLogin: on })} /></div></div>
  </section>`;
}

function Environment() {
  const { state, jl, call, toast, startSample } = useApp();
  const sample = state.info?.sample || state.workspace?.sample;
  async function pick(value) {
    if (value === 'sandbox') return startSample();
    const live = (state.workspaces || []).find((w) => !w.sample);
    if (live) {
      const r = await call(jl.workspaces.select(live.id));
      if (r) toast('Live workspace', live.name, 'ok');
    }
    return undefined;
  }
  return html`<section class="section" id="settings-environment" aria-label="Sandbox or Live">
    <div class="section-head"><div class="label">Sandbox or Live</div></div>
    <div class="setting-row"><div><div class="t">Environment</div><div class="d">Sandbox opens the SAMPLE workspace with fictional papers, to practise. Live is your house’s real workspace. The model, the OFAC list and the rules are the same in both.</div></div>
      <div class="ctl"><${Segmented} value=${sample ? 'sandbox' : 'live'} onChange=${pick} options=${[{ value: 'sandbox', label: 'Sandbox' }, { value: 'live', label: 'Live' }]} /></div></div>
  </section>`;
}

function About() {
  const { state, jl, call, toast } = useApp();
  const info = state.info || {};
  async function update() {
    const r = await call(jl.app.checkUpdate());
    if (r === null) return;
    if (!r || !r.latest) toast('You have the latest version', `Jewel Labs ${info.version || ''}`, 'ok');
    else toast(`Jewel Labs ${r.latest} is ready`, 'Download it and install it over this copy. Your workspaces stay.', 'info', { label: 'Download', run: () => call(jl.app.openExternal(r.download || r.url)) });
  }
  return html`<section class="section" id="settings-about" aria-label="About">
    <div class="section-head"><div class="label">About</div></div>
    <div class="setting-row"><div><div class="t">Jewel Labs ${info.version || ''}</div>
      <div class="d mono small">${[info.platform, info.arch, info.versions?.electron ? `Electron ${info.versions.electron}` : null].filter(Boolean).join(' · ') || 'Web demo'}</div></div>
      <div class="ctl"><${Button} size="sm" onClick=${update} icon=${Icon.refresh}>Check for updates<//>
        ${info.site ? html`<${Button} size="sm" kind="ghost" onClick=${() => call(jl.app.openExternal(info.site))} icon=${Icon.open}>Website<//>` : null}</div></div>
    ${info.logFile ? html`<div class="setting-row"><div><div class="t">Log file</div><div class="d mono small">${info.logFile}</div></div>
      <div class="ctl"><${Button} size="sm" kind="ghost" onClick=${() => call(jl.app.showItem(info.logFile))}>Show in folder<//></div></div>` : null}
    <div class="setting-row"><div><div class="t">What Jewel Labs does and does not do</div><div class="d">The agents prepare the papers and keep the audit trail. A person at your house signs. Your house or its broker lodges the declaration; Jewel Labs never files on your behalf.</div></div></div>
  </section>`;
}
