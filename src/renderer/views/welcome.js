// First run: sign in, create an account, keep working on this computer only, or try the sample.
// Looks like jewellabs.io: pitch black, a faint grid, Geist headings, glass buttons.
import { html, useState } from '../vendor/preact-htm.mjs';
import { useApp } from '../lib/context.js';
import { go } from '../lib/router.js';
import { Button, Field, Segmented } from '../components/ui.js';
import { Icon } from '../components/icons.js';

export function WelcomeView() {
  const { state, jl, call, toast, refreshInfo, reload, startSample, markStarted } = useApp();
  const [mode, setMode] = useState('signin');
  const [form, setForm] = useState({ name: '', email: '', password: '', inviteCode: '', houseName: '' });
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.value });
  const cloud = state.info?.cloud !== false;

  async function enter() {
    markStarted();
    await refreshInfo();
    await reload();
    go(state.auth?.role === 'desk' ? 'desk' : 'home');
  }

  async function signIn() {
    setError(null);
    if (!form.email.trim() || !form.password) return setError('Type your email and password.');
    const result = await jl.auth.signIn({ email: form.email.trim(), password: form.password }).catch((e) => ({ error: e.message }));
    if (result?.error) return setError(result.error);
    await enter();
    return undefined;
  }

  async function signUp() {
    setError(null);
    if (!form.email.trim() || form.password.length < 8) return setError('Type your email and a password of 8 characters or more.');
    if (!form.inviteCode.trim() && !form.houseName.trim()) return setError('Paste the invite code from your house, or name your house to start a new one.');
    const result = await jl.auth.signUp({
      name: form.name.trim() || undefined, email: form.email.trim(), password: form.password,
      inviteCode: form.inviteCode.trim() || undefined, houseName: form.inviteCode.trim() ? undefined : form.houseName.trim(),
    }).catch((e) => ({ error: e.message }));
    if (result?.error) return setError(result.error);
    if (result?.needsConfirmation) {
      setNote(`Check ${form.email.trim()} for a confirmation link, then sign in here.`);
      setMode('signin');
      return undefined;
    }
    await enter();
    return undefined;
  }

  async function local() {
    markStarted();
    const live = (state.workspaces || []).find((w) => !w.sample);
    if (live && state.workspace?.sample) await call(jl.workspaces.select(live.id), { quiet: true });
    await reload();
    go('home');
    toast('Working on this computer', 'Your papers stay here. Sign in later to share them with your team.', 'ok');
  }

  return html`<div class="welcome">
    <div class="welcome-grid"></div>
    <div class="welcome-glow"></div>
    <header class="welcome-top drag">
      <span class="brand"><span class="brand-mark">${Icon.logo()}</span><span class="brand-word">Jewellabs</span></span>
      <span class="muted small">${state.info?.version ? `Version ${state.info.version}` : ''}</span>
    </header>
    <main class="welcome-main">
      <div class="welcome-hero">
        <span class="badge">Agentic compliance for the diamond trade</span>
        <h1>Jewel Labs</h1>
        <div class="tagline">Every diamond export, ready for customs.</div>
        <p class="lead">Drop in the invoices, packing lists, lab reports and chats. The agents read every page, trace every stone from the mine to the parcel, screen every party, and build the origin pack ready to sign.</p>
        <div class="welcome-points">
          <div><span class="tick">${Icon.check()}</span>EU Due Diligence Statement and US self-certification</div>
          <div><span class="tick">${Icon.check()}</span>Every field linked to its spot on the page</div>
          <div><span class="tick">${Icon.check()}</span>OFAC screening and a full audit trail</div>
        </div>
      </div>
      <div class="auth-card">
        <${Segmented} full value=${mode} onChange=${(m) => { setMode(m); setError(null); }} ariaLabel="Sign in or create an account"
          options=${[{ value: 'signin', label: 'Sign in' }, { value: 'signup', label: 'Create an account' }]} />
        ${note ? html`<div class="form-help" style=${{ marginTop: 0, marginBottom: '12px', color: 'var(--ok)' }}>${note}</div>` : null}
        ${!cloud && !state.demo ? html`<div class="form-help" style=${{ marginTop: 0, marginBottom: '12px' }}>Accounts are not set up in this copy. Continue without an account; your work stays on this computer.</div>` : null}
        <form onSubmit=${(e) => { e.preventDefault(); return mode === 'signin' ? signIn() : signUp(); }}>
          <div class="form-grid">
            ${mode === 'signup' ? html`<${Field} label="Your name"><input class="input" value=${form.name} onInput=${set('name')} autocomplete="name" /><//>` : null}
            <${Field} label="Email"><input class="input" type="email" value=${form.email} onInput=${set('email')} autocomplete="email" placeholder="you@yourhouse.com" /><//>
            <${Field} label="Password"><input class="input" type="password" value=${form.password} onInput=${set('password')} autocomplete=${mode === 'signin' ? 'current-password' : 'new-password'} /><//>
            ${mode === 'signup' ? html`
              <${Field} label="Invite code" hint="From the owner of your house's workspace. Leave it empty to start a new house."><input class="input input-mono" value=${form.inviteCode} onInput=${set('inviteCode')} placeholder="Optional" /><//>
              ${!form.inviteCode.trim() ? html`<${Field} label="House name"><input class="input" value=${form.houseName} onInput=${set('houseName')} placeholder="As the house trades" /><//>` : null}` : null}
          </div>
          ${error ? html`<div class="form-error" role="alert">${error}</div>` : null}
          <div class="mt-16"><${Button} kind="primary" onClick=${mode === 'signin' ? signIn : signUp} disabled=${!cloud || state.demo}>${mode === 'signin' ? 'Sign in' : 'Create the account'}<//></div>
          ${state.demo ? html`<div class="form-help">Accounts work in the desktop app. Here, try the sample shipment.</div>` : null}
        </form>
        <div class="auth-or">or</div>
        <div class="auth-alt">
          <${Button} onClick=${startSample}><span>Try the sample shipment</span><span class="sub">fictional SAMPLE papers</span><//>
          <${Button} onClick=${local}><span>Continue without an account</span><span class="sub">a workspace on this computer</span><//>
        </div>
      </div>
    </main>
    <footer class="welcome-foot"><span>Multiplayer, agentic AI infrastructure for the diamond trade</span><span>Jewel Labs prepares the papers. Your house signs and lodges them.</span></footer>
  </div>`;
}
