// Mail for the agents: read new shipment mail over IMAP (imapflow) and send signed packs over SMTP (nodemailer).
// The app password is passed in by the caller on every call. This file never stores it anywhere.
import { ImapFlow } from 'imapflow';
import { createTransport as nodemailerTransport } from 'nodemailer';

/** Mail providers the house can pick in Settings. `custom` needs the server names typed in. */
export const PROVIDERS = {
  gmail: { name: 'Gmail or Google Workspace', imap: { host: 'imap.gmail.com', port: 993 }, smtp: { host: 'smtp.gmail.com', port: 465 } },
  outlook: { name: 'Outlook or Microsoft 365', imap: { host: 'outlook.office365.com', port: 993 }, smtp: { host: 'smtp.office365.com', port: 587 } },
  icloud: { name: 'iCloud Mail', imap: { host: 'imap.mail.me.com', port: 993 }, smtp: { host: 'smtp.mail.me.com', port: 587 } },
  yahoo: { name: 'Yahoo Mail', imap: { host: 'imap.mail.yahoo.com', port: 993 }, smtp: { host: 'smtp.mail.yahoo.com', port: 465 } },
  zoho: { name: 'Zoho Mail', imap: { host: 'imap.zoho.com', port: 993 }, smtp: { host: 'smtp.zoho.com', port: 465 } },
  custom: { name: 'Other mail server (IMAP and SMTP)', imap: null, smtp: null },
};

/** One poll never downloads more than this many messages, so a huge inbox cannot stall the agents. */
export const MAX_MESSAGES_PER_POLL = 200;

/**
 * Server name and port for 'imap' or 'smtp'. A preset can be overridden (host/port for IMAP,
 * smtpHost/smtpPort for SMTP). For a custom server with no SMTP name we guess smtp.<domain> from imap.<domain>.
 */
export function serverFor(kind, { provider = 'custom', host, port, smtpHost, smtpPort } = {}) {
  const preset = PROVIDERS[provider];
  if (!preset) throw new Error(`Unknown mail provider: ${provider}`);
  const base = preset[kind];
  const wantedHost = kind === 'imap' ? host : smtpHost || guessSmtpHost(host);
  const wantedPort = kind === 'imap' ? port : smtpPort;
  const server = {
    host: wantedHost || base?.host || null,
    port: Number(wantedPort || base?.port || (kind === 'imap' ? 993 : 465)),
  };
  if (!server.host) throw new Error(`Add the ${kind.toUpperCase()} server name for this mailbox.`);
  return server;
}

function guessSmtpHost(imapHost) {
  if (!imapHost || !/^imap\./i.test(imapHost)) return null;
  return imapHost.replace(/^imap\./i, 'smtp.');
}

/**
 * Opens a mailbox. Nothing connects until the first call (test or fetchSince).
 * `deps.ImapClient` lets tests pass a fake instead of the real imapflow class.
 */
export function connectMailbox(options, deps = {}) {
  const ImapClient = deps.ImapClient || ImapFlow;
  const { email, appPassword } = options || {};
  requireLogin(email, appPassword);
  const server = serverFor('imap', options);
  let client = null;
  let lastError = null;

  async function open() {
    if (client && client.usable) return client;
    client = new ImapClient({
      host: server.host,
      port: server.port,
      secure: server.port === 993,
      auth: { user: email, pass: appPassword },
      logger: false,
    });
    // Without an error listener a dropped connection would crash the whole app.
    if (typeof client.on === 'function') client.on('error', (err) => { lastError = err; });
    try {
      await client.connect();
    } catch (err) {
      client = null;
      throw friendlyMailError(err);
    }
    return client;
  }

  return {
    server,
    lastError: () => lastError,

    /** Signs in and opens the inbox once, so Settings can say "connected". */
    async test() {
      const imap = await open();
      const lock = await imap.getMailboxLock('INBOX');
      try {
        return { ok: true, messages: imap.mailbox?.exists ?? null };
      } finally {
        lock.release();
      }
    },

    /** Messages that arrived on or after `date` (IMAP SINCE works by whole days), newest 200 at most. */
    async fetchSince(date, { domains = [], limit = MAX_MESSAGES_PER_POLL } = {}) {
      const imap = await open();
      const lock = await imap.getMailboxLock('INBOX');
      try {
        const found = (await imap.search({ since: toDate(date) }, { uid: true })) || [];
        const recent = [...found].sort((a, b) => a - b).slice(-limit);
        if (!recent.length) return [];
        // First pass reads headers only, so mail from other companies is never downloaded.
        const wanted = await pickByDomain(imap, recent, domains);
        if (!wanted.length) return [];
        const messages = [];
        for await (const msg of imap.fetch(wanted, { uid: true, envelope: true, internalDate: true, source: true }, { uid: true })) {
          if (msg && msg.source) messages.push(toMessage(msg));
        }
        return messages;
      } catch (err) {
        throw friendlyMailError(err);
      } finally {
        lock.release();
      }
    },

    async close() {
      if (!client) return;
      const imap = client;
      client = null;
      try {
        await imap.logout();
      } catch {
        if (typeof imap.close === 'function') imap.close();
      }
    },
  };
}

async function pickByDomain(imap, uids, domains) {
  if (!cleanDomains(domains).length) return uids;
  const keep = [];
  for await (const msg of imap.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
    if (matchesDomains(msg.envelope, domains)) keep.push(msg.uid);
  }
  return keep;
}

/**
 * True when the sender (or someone copied) is at one of the domains. An empty list keeps everything.
 * The "to" line is skipped on purpose: it is usually the house itself.
 */
export function matchesDomains(envelope, domains) {
  const list = cleanDomains(domains);
  if (!list.length) return true;
  const people = ['from', 'sender', 'replyTo', 'cc'].flatMap((key) => envelope?.[key] || []);
  return people.some((person) => {
    const domain = String(person?.address || '').toLowerCase().split('@')[1] || '';
    return list.some((d) => domain === d || domain.endsWith(`.${d}`));
  });
}

function cleanDomains(domains) {
  const list = Array.isArray(domains) ? domains : String(domains || '').split(/[,\s]+/);
  return list
    .map((d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^.*@/, '').replace(/^www\./, ''))
    .filter(Boolean);
}

function toMessage(msg) {
  const env = msg.envelope || {};
  const when = msg.internalDate || env.date || null;
  return {
    uid: msg.uid,
    messageId: env.messageId || null,
    from: env.from?.[0]?.address || null,
    subject: env.subject || '',
    date: when ? new Date(when).toISOString() : null,
    eml: new Uint8Array(msg.source),
  };
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value || 0);
  if (Number.isNaN(date.getTime())) throw new Error('fetchSince needs a valid date.');
  return date;
}

/**
 * Sends one email from the house's own mailbox, usually a signed pack as a PDF attachment.
 * `deps.createTransport` lets tests pass a fake instead of nodemailer.
 */
export async function sendMail(options, deps = {}) {
  const createTransport = deps.createTransport || nodemailerTransport;
  const { email, appPassword, to, cc, subject, text, attachments = [] } = options || {};
  requireLogin(email, appPassword);
  const recipients = listOf(to);
  if (!recipients.length) throw new Error('Add who to send it to.');
  const server = serverFor('smtp', options);
  const transport = createTransport({
    host: server.host,
    port: server.port,
    secure: server.port === 465, // 465 is TLS from the start; 587 upgrades with STARTTLS
    requireTLS: server.port !== 465,
    auth: { user: email, pass: appPassword },
  });
  try {
    const info = await transport.sendMail({
      from: email,
      to: recipients,
      cc: listOf(cc),
      subject: subject || '',
      text: text || '',
      attachments: attachments.map(toAttachment),
    });
    return { messageId: info?.messageId || null, accepted: info?.accepted || [], rejected: info?.rejected || [] };
  } catch (err) {
    throw friendlyMailError(err);
  } finally {
    if (typeof transport.close === 'function') transport.close();
  }
}

function toAttachment(file) {
  return {
    filename: file.filename || file.name || 'attachment.pdf',
    content: Buffer.from(file.content || file.bytes || []),
    contentType: file.contentType || file.mime || 'application/pdf',
  };
}

/** 'a@x.com, b@y.com' or ['a@x.com'] -> clean list. */
export function listOf(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,;]/);
  return list.map((v) => String(v || '').trim()).filter(Boolean);
}

function requireLogin(email, appPassword) {
  if (!email || !appPassword) throw new Error('Add the email address and its app password first.');
}

/** Turns a raw mail server error into one plain sentence for the person at the desk. */
export function friendlyMailError(err) {
  if (err && err.friendly) return err;
  const raw = String(err?.responseText || err?.response || err?.message || err || 'unknown error');
  let message = `The mail server said: ${raw}`;
  if (err?.authenticationFailed || err?.code === 'EAUTH' || /authenticat|credential|password|login failed|invalid login/i.test(raw)) {
    message = 'The mailbox did not accept this email and app password. Check the app password and try again.';
  } else if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ESOCKET'].includes(err?.code)) {
    message = 'Could not reach the mail server. Check the internet connection and the server name.';
  }
  const out = new Error(message);
  out.friendly = true;
  out.code = err?.code;
  out.cause = err;
  return out;
}
