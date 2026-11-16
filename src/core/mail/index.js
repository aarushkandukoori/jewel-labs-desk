// Mail for the agents: read new shipment mail over IMAP (imapflow) and send signed packs over SMTP (nodemailer).
// The app password is passed in by the caller on every call. This file never stores it anywhere.
import { ImapFlow } from 'imapflow';
import { createTransport as nodemailerTransport } from 'nodemailer';
import { cleanDomains, matchesDomains } from './domains.js';

export { cleanDomains, matchesDomains };

/** Mail providers the house can pick in Settings. `custom` needs the server names typed in. */
export const PROVIDERS = {
  gmail: { name: 'Gmail or Google Workspace', imap: { host: 'imap.gmail.com', port: 993 }, smtp: { host: 'smtp.gmail.com', port: 465 } },
  outlook: { name: 'Outlook or Microsoft 365', imap: { host: 'outlook.office365.com', port: 993 }, smtp: { host: 'smtp.office365.com', port: 587 } },
  icloud: { name: 'iCloud Mail', imap: { host: 'imap.mail.me.com', port: 993 }, smtp: { host: 'smtp.mail.me.com', port: 587 } },
  yahoo: { name: 'Yahoo Mail', imap: { host: 'imap.mail.yahoo.com', port: 993 }, smtp: { host: 'smtp.mail.yahoo.com', port: 465 } },
  zoho: { name: 'Zoho Mail', imap: { host: 'imap.zoho.com', port: 993 }, smtp: { host: 'smtp.zoho.com', port: 465 } },
  custom: { name: 'Other mail server (IMAP and SMTP)', imap: null, smtp: null },
};

/** One page looks at this many messages at most, so a huge inbox cannot stall the agents. */
export const MAX_MESSAGES_PER_POLL = 200;
/** A message bigger than this is not downloaded: it is listed in tooBig, so the house can add its papers by hand. */
export const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

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
    const secure = server.port === 993; // 993 is TLS from the start
    client = new ImapClient({
      host: server.host,
      port: server.port,
      secure,
      // Any other port must upgrade with STARTTLS, or the login stops: the app password never goes out unencrypted.
      doSTARTTLS: secure ? undefined : true,
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

    /**
     * The next page of messages, oldest first, from senders at one of the domains.
     * The first time (no afterUid, or the server renumbered the inbox) it starts at `date`; after that it goes on
     * after the last message it looked at, so no mail is skipped however much arrives in between.
     * Returns the messages, plus the cursor for the next call: { uidValidity, lastUid, more }, and tooBig: the
     * messages from those domains that were too big to download ([{ uid, from, subject, size }]).
     */
    async fetchSince(date, { domains = [], limit = MAX_MESSAGES_PER_POLL, afterUid = 0, uidValidity = null } = {}) {
      const imap = await open();
      const lock = await imap.getMailboxLock('INBOX');
      try {
        const validity = imap.mailbox?.uidValidity == null ? null : String(imap.mailbox.uidValidity); // a BigInt in imapflow
        const resume = afterUid > 0 && validity !== null && validity === String(uidValidity);
        // IMAP SINCE works by whole days in the server's time zone: start a day early, repeats are skipped later.
        const query = resume ? { uid: `${afterUid + 1}:*` } : { since: new Date(toDate(date).getTime() - DAY_MS) };
        // "n:*" always returns the last message, even when nothing is newer than n.
        const found = ((await imap.search(query, { uid: true })) || []).filter((uid) => !resume || uid > afterUid).sort((a, b) => a - b);
        const page = found.slice(0, limit);
        const cursor = {
          uidValidity: validity,
          lastUid: page.length ? page[page.length - 1] : resume ? afterUid : Math.max(0, Number(imap.mailbox?.uidNext || 1) - 1),
          more: found.length > page.length,
        };
        // First pass reads headers only, so mail from other companies is never downloaded.
        const { wanted, tooBig } = page.length ? await pickByDomain(imap, page, domains) : { wanted: [], tooBig: [] };
        const messages = [];
        if (wanted.length) {
          for await (const msg of imap.fetch(wanted, { uid: true, envelope: true, internalDate: true, source: true }, { uid: true })) {
            if (msg && msg.source) messages.push(toMessage(msg));
          }
        }
        return Object.assign(messages, cursor, { tooBig });
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

/**
 * { wanted, tooBig }: the uids of the messages from someone at one of the domains (no domains: none at all), and
 * those of them too big to download.
 */
async function pickByDomain(imap, uids, domains) {
  const wanted = [];
  const tooBig = [];
  if (!cleanDomains(domains).length) return { wanted, tooBig };
  for await (const msg of imap.fetch(uids, { uid: true, envelope: true, size: true }, { uid: true })) {
    if (!matchesDomains(msg.envelope, domains)) continue;
    if (Number(msg.size) > MAX_MESSAGE_BYTES) {
      tooBig.push({ uid: msg.uid, from: msg.envelope?.from?.[0]?.address || null, subject: msg.envelope?.subject || '', size: Number(msg.size) });
    } else {
      wanted.push(msg.uid);
    }
  }
  return { wanted, tooBig };
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
  } else if (err?.tlsFailed) {
    message = 'This mail server does not offer an encrypted connection on this port, so the app password was not sent. Use port 993, or ask for the secure IMAP settings.';
  } else if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ESOCKET'].includes(err?.code)) {
    message = 'Could not reach the mail server. Check the internet connection and the server name.';
  }
  const out = new Error(message);
  out.friendly = true;
  out.code = err?.code;
  out.cause = err;
  return out;
}
