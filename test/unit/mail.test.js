// Mail module tests. Fakes only: no network, no real mailbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, MAX_MESSAGES_PER_POLL, serverFor, connectMailbox, sendMail, matchesDomains, listOf, friendlyMailError,
} from '../../src/core/mail/index.js';

// Built at runtime so nothing in the repo looks like a real password.
const PASS = ['test', 'only', 'app', 'pass'].join('-');

/** A stand-in for imapflow's ImapFlow class. It remembers every call so the tests can check them. */
function fakeImap({ messages = [], failConnect = null } = {}) {
  const calls = { options: null, searches: [], fetches: [], locks: 0, released: 0, loggedOut: 0 };
  class FakeImap {
    constructor(options) { calls.options = options; this.usable = false; this.mailbox = null; this.listeners = {}; }
    on(name, fn) { this.listeners[name] = fn; }
    async connect() {
      if (failConnect) throw failConnect;
      this.usable = true;
    }
    async getMailboxLock(path) {
      calls.locks += 1;
      this.mailbox = { path, exists: messages.length };
      return { release: () => { calls.released += 1; } };
    }
    async search(query, options) {
      calls.searches.push({ query, options });
      return messages.filter((m) => m.internalDate >= query.since).map((m) => m.uid);
    }
    async *fetch(range, query, options) {
      calls.fetches.push({ range: [...range], query, options });
      for (const m of messages) {
        if (!range.includes(m.uid)) continue;
        const out = { uid: m.uid, envelope: m.envelope };
        if (query.internalDate) out.internalDate = m.internalDate;
        if (query.source) out.source = Buffer.from(m.raw);
        yield out;
      }
    }
    async logout() { calls.loggedOut += 1; this.usable = false; }
  }
  return { FakeImap, calls };
}

function message(uid, from, subject, day = 10) {
  return {
    uid,
    internalDate: new Date(Date.UTC(2026, 10, day, 9, 0, 0)),
    envelope: { messageId: `<m${uid}@example.test>`, from: [{ address: from }], subject, date: new Date(Date.UTC(2026, 10, day)) },
    raw: `From: ${from}\r\nSubject: ${subject}\r\n\r\nSAMPLE body ${uid}`,
  };
}

test('PROVIDERS lists the six mail providers with the right servers', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['custom', 'gmail', 'icloud', 'outlook', 'yahoo', 'zoho']);
  assert.deepEqual(PROVIDERS.gmail.imap, { host: 'imap.gmail.com', port: 993 });
  assert.deepEqual(PROVIDERS.gmail.smtp, { host: 'smtp.gmail.com', port: 465 });
  assert.deepEqual(PROVIDERS.outlook.imap, { host: 'outlook.office365.com', port: 993 });
  assert.deepEqual(PROVIDERS.outlook.smtp, { host: 'smtp.office365.com', port: 587 });
  assert.deepEqual(PROVIDERS.icloud.imap, { host: 'imap.mail.me.com', port: 993 });
  assert.deepEqual(PROVIDERS.icloud.smtp, { host: 'smtp.mail.me.com', port: 587 });
  assert.deepEqual(PROVIDERS.yahoo.imap, { host: 'imap.mail.yahoo.com', port: 993 });
  assert.deepEqual(PROVIDERS.yahoo.smtp, { host: 'smtp.mail.yahoo.com', port: 465 });
  assert.deepEqual(PROVIDERS.zoho.imap, { host: 'imap.zoho.com', port: 993 });
  assert.deepEqual(PROVIDERS.zoho.smtp, { host: 'smtp.zoho.com', port: 465 });
  assert.equal(PROVIDERS.custom.imap, null);
});

test('serverFor uses presets, overrides and custom servers', () => {
  assert.deepEqual(serverFor('smtp', { provider: 'icloud' }), { host: 'smtp.mail.me.com', port: 587 });
  assert.deepEqual(serverFor('imap', { provider: 'custom', host: 'imap.house.example', port: 993 }), { host: 'imap.house.example', port: 993 });
  assert.deepEqual(serverFor('smtp', { provider: 'custom', host: 'imap.house.example' }), { host: 'smtp.house.example', port: 465 });
  assert.deepEqual(serverFor('smtp', { provider: 'custom', host: 'mail.house.example', smtpHost: 'out.house.example', smtpPort: 587 }), { host: 'out.house.example', port: 587 });
  assert.throws(() => serverFor('imap', { provider: 'custom' }), /IMAP server name/);
  assert.throws(() => serverFor('imap', { provider: 'nope' }), /Unknown mail provider/);
});

test('connectMailbox needs an email and app password', () => {
  assert.throws(() => connectMailbox({ provider: 'gmail', email: 'clerk@house.example' }), /app password/);
});

test('test() signs in with imapflow settings and releases the inbox lock', async () => {
  const { FakeImap, calls } = fakeImap({ messages: [message(1, 'a@broker.example', 'Hello')] });
  const box = connectMailbox({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS }, { ImapClient: FakeImap });
  const result = await box.test();
  assert.deepEqual(result, { ok: true, messages: 1 });
  assert.equal(calls.options.host, 'imap.gmail.com');
  assert.equal(calls.options.port, 993);
  assert.equal(calls.options.secure, true);
  assert.equal(calls.options.logger, false);
  assert.deepEqual(calls.options.auth, { user: 'clerk@house.example', pass: PASS });
  assert.equal(calls.released, calls.locks);
  await box.close();
  assert.equal(calls.loggedOut, 1);
});

test('fetchSince searches by date, filters by domain and returns the raw .eml', async () => {
  const msgs = [
    message(1, 'old@broker.example', 'Old one', 1),
    message(2, 'ops@broker.example', 'Invoice EXP/26-27/28', 12),
    message(3, 'news@shop.example', 'Big sale', 12),
    message(4, 'desk@air.cargo.example', 'AWB 176-1234 5675', 13),
  ];
  const { FakeImap, calls } = fakeImap({ messages: msgs });
  const box = connectMailbox({ provider: 'zoho', email: 'clerk@house.example', appPassword: PASS }, { ImapClient: FakeImap });
  const since = new Date(Date.UTC(2026, 10, 10));
  const got = await box.fetchSince(since, { domains: ['broker.example', '@cargo.example'] });
  assert.equal(calls.searches[0].query.since.getTime(), since.getTime());
  assert.deepEqual(calls.searches[0].options, { uid: true });
  assert.deepEqual(got.map((m) => m.uid), [2, 4]);
  assert.equal(got[0].from, 'ops@broker.example');
  assert.equal(got[0].subject, 'Invoice EXP/26-27/28');
  assert.equal(got[0].messageId, '<m2@example.test>');
  assert.equal(got[0].date, '2026-11-12T09:00:00.000Z');
  assert.ok(got[0].eml instanceof Uint8Array);
  assert.match(Buffer.from(got[0].eml).toString(), /SAMPLE body 2/);
  // The headers-only pass never asks for the message source.
  assert.equal(calls.fetches[0].query.source, undefined);
  assert.deepEqual(calls.fetches[1].range, [2, 4]);
  assert.equal(calls.released, calls.locks);
});

test('fetchSince with no domains keeps everything and caps one poll at 200 messages', async () => {
  const msgs = Array.from({ length: 250 }, (_, i) => message(i + 1, `p${i}@x.example`, `Mail ${i + 1}`, 12));
  const { FakeImap, calls } = fakeImap({ messages: msgs });
  const box = connectMailbox({ provider: 'yahoo', email: 'clerk@house.example', appPassword: PASS }, { ImapClient: FakeImap });
  const got = await box.fetchSince('2026-11-01T00:00:00Z');
  assert.equal(MAX_MESSAGES_PER_POLL, 200);
  assert.equal(got.length, 200);
  assert.equal(got[0].uid, 51); // the newest 200 are kept
  assert.equal(calls.fetches.length, 1); // no domain filter means a single pass
});

test('a refused login becomes one plain sentence', async () => {
  const refused = Object.assign(new Error('Command failed'), { authenticationFailed: true });
  const { FakeImap } = fakeImap({ failConnect: refused });
  const box = connectMailbox({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS }, { ImapClient: FakeImap });
  await assert.rejects(box.test(), /did not accept this email and app password/);
  const offline = friendlyMailError(Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }));
  assert.match(offline.message, /Could not reach the mail server/);
});

test('matchesDomains looks at the sender and copies, not the house itself', () => {
  const env = { from: [{ address: 'ops@broker.example' }], to: [{ address: 'clerk@house.example' }] };
  assert.equal(matchesDomains(env, ['broker.example']), true);
  assert.equal(matchesDomains(env, ['house.example']), false);
  assert.equal(matchesDomains(env, []), true);
  assert.equal(matchesDomains({ from: [{ address: 'x@sub.broker.example' }] }, 'broker.example'), true);
  assert.equal(matchesDomains({ cc: [{ address: 'y@broker.example' }] }, ['www.broker.example']), true);
});

test('sendMail sends from the house mailbox with the PDF attached', async () => {
  const sent = [];
  let options = null;
  let closed = false;
  const createTransport = (opts) => {
    options = opts;
    return {
      async sendMail(mail) { sent.push(mail); return { messageId: '<sent-1@house.example>', accepted: mail.to, rejected: [] }; },
      close() { closed = true; },
    };
  };
  const pdf = new TextEncoder().encode('%PDF-1.7 SAMPLE');
  const result = await sendMail({
    provider: 'outlook', email: 'clerk@house.example', appPassword: PASS,
    to: 'broker@broker.example, desk@broker.example', cc: ['boss@house.example'],
    subject: 'Export pack JL-EXP-1115-01', text: 'Signed pack attached.',
    attachments: [{ filename: 'JL-EXP-1115-01-v1.pdf', content: pdf, contentType: 'application/pdf' }],
  }, { createTransport });
  assert.equal(result.messageId, '<sent-1@house.example>');
  assert.equal(options.host, 'smtp.office365.com');
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.equal(sent[0].from, 'clerk@house.example');
  assert.deepEqual(sent[0].to, ['broker@broker.example', 'desk@broker.example']);
  assert.deepEqual(sent[0].cc, ['boss@house.example']);
  assert.equal(sent[0].attachments[0].filename, 'JL-EXP-1115-01-v1.pdf');
  assert.ok(Buffer.isBuffer(sent[0].attachments[0].content));
  assert.equal(closed, true);
});

test('sendMail on port 465 uses TLS from the start, and needs a recipient', async () => {
  let options = null;
  const createTransport = (opts) => { options = opts; return { async sendMail() { return {}; } }; };
  await sendMail({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS, to: 'a@b.example' }, { createTransport });
  assert.equal(options.secure, true);
  await assert.rejects(sendMail({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS, to: '' }, { createTransport }), /who to send it to/);
});

test('listOf splits address lists', () => {
  assert.deepEqual(listOf('a@x.example; b@y.example, '), ['a@x.example', 'b@y.example']);
  assert.deepEqual(listOf(undefined), []);
});
