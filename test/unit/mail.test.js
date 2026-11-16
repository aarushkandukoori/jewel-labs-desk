// Mail module tests. Fakes only: no network, no real mailbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, MAX_MESSAGES_PER_POLL, MAX_MESSAGE_BYTES, serverFor, connectMailbox, sendMail, matchesDomains, cleanDomains, listOf, friendlyMailError,
} from '../../src/core/mail/index.js';

// Built at runtime so nothing in the repo looks like a real password.
const PASS = ['test', 'only', 'app', 'pass'].join('-');

/**
 * A stand-in for imapflow's ImapFlow class. It remembers every call so the tests can check them.
 * box.uidValidity can be changed to act as a server that renumbered its inbox.
 */
function fakeImap({ messages = [], failConnect = null, uidValidity = 7n } = {}) {
  const calls = { options: null, searches: [], fetches: [], locks: 0, released: 0, loggedOut: 0 };
  const box = { uidValidity };
  class FakeImap {
    constructor(options) { calls.options = options; this.usable = false; this.mailbox = null; this.listeners = {}; }
    on(name, fn) { this.listeners[name] = fn; }
    async connect() {
      if (failConnect) throw failConnect;
      this.usable = true;
    }
    async getMailboxLock(path) {
      calls.locks += 1;
      const uidNext = Math.max(0, ...messages.map((m) => m.uid)) + 1;
      this.mailbox = { path, exists: messages.length, uidValidity: box.uidValidity, uidNext };
      return { release: () => { calls.released += 1; } };
    }
    async search(query, options) {
      calls.searches.push({ query, options });
      if (query.uid) {
        // Like a real server: "n:*" also gives the last message when nothing is newer than n.
        const from = Number(String(query.uid).split(':')[0]);
        const newer = messages.filter((m) => m.uid >= from).map((m) => m.uid);
        return newer.length ? newer : messages.slice(-1).map((m) => m.uid);
      }
      return messages.filter((m) => m.internalDate >= query.since).map((m) => m.uid);
    }
    async *fetch(range, query, options) {
      calls.fetches.push({ range: [...range], query, options });
      for (const m of messages) {
        if (!range.includes(m.uid)) continue;
        const out = { uid: m.uid, envelope: m.envelope };
        if (query.size) out.size = m.size ?? Buffer.byteLength(m.raw);
        if (query.internalDate) out.internalDate = m.internalDate;
        if (query.source) out.source = Buffer.from(m.raw);
        yield out;
      }
    }
    async logout() { calls.loggedOut += 1; this.usable = false; }
  }
  return { FakeImap, calls, box };
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
  assert.equal(calls.options.doSTARTTLS, undefined, 'TLS from the start: no STARTTLS');
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
  // A day early: the server counts days in its own time zone. Repeats are skipped by the worker.
  assert.equal(calls.searches[0].query.since.getTime(), since.getTime() - 24 * 3600 * 1000);
  assert.deepEqual(calls.searches[0].options, { uid: true });
  assert.deepEqual(got.map((m) => m.uid), [2, 4]);
  assert.equal(got.lastUid, 4, 'the next call goes on after the last message looked at');
  assert.equal(got.uidValidity, '7');
  assert.equal(got.more, false);
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

test('fetchSince with no domains brings in no mail at all', async () => {
  const msgs = Array.from({ length: 5 }, (_, i) => message(i + 1, `p${i}@x.example`, `Mail ${i + 1}`, 12));
  const { FakeImap, calls } = fakeImap({ messages: msgs });
  const box = connectMailbox({ provider: 'yahoo', email: 'clerk@house.example', appPassword: PASS }, { ImapClient: FakeImap });
  const got = await box.fetchSince('2026-11-01T00:00:00Z');
  assert.deepEqual(got.map((m) => m.uid), []);
  assert.equal(calls.fetches.length, 0, 'not even the headers are read');
  assert.equal((await box.fetchSince('2026-11-01T00:00:00Z', { domains: '  ' })).length, 0);
});

test('fetchSince goes through a big inbox oldest first, a page at a time, and misses nothing', async () => {
  // 30 partner emails on the 10th, then 270 other messages: more than one page.
  const msgs = [
    ...Array.from({ length: 30 }, (_, i) => message(i + 1, `ops${i}@broker.example`, `Invoice ${i + 1}`, 10)),
    ...Array.from({ length: 270 }, (_, i) => message(31 + i, `news${i}@shop.example`, `Sale ${i}`, 11)),
  ];
  const { FakeImap, calls } = fakeImap({ messages: msgs });
  const box = connectMailbox({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS }, { ImapClient: FakeImap });
  assert.equal(MAX_MESSAGES_PER_POLL, 200);
  const first = await box.fetchSince(new Date(Date.UTC(2026, 10, 9)), { domains: 'broker.example' });
  assert.equal(first.length, 30, 'the oldest page holds all the partner mail');
  assert.deepEqual([first.lastUid, first.more], [200, true]);
  const second = await box.fetchSince(new Date(Date.UTC(2026, 10, 9)), { domains: 'broker.example', afterUid: first.lastUid, uidValidity: first.uidValidity });
  assert.deepEqual(calls.searches[1].query, { uid: '201:*' });
  assert.deepEqual([second.length, second.lastUid, second.more], [0, 300, false]);
  // Nothing new: "301:*" gives the last message back, which is not counted again.
  const third = await box.fetchSince(new Date(Date.UTC(2026, 10, 9)), { domains: 'broker.example', afterUid: 300, uidValidity: '7' });
  assert.deepEqual([third.length, third.lastUid, third.more], [0, 300, false]);
});

test('fetchSince starts again from the date when the server renumbered the inbox', async () => {
  const msgs = [message(1, 'ops@broker.example', 'Invoice', 12)];
  const { FakeImap, calls, box: server } = fakeImap({ messages: msgs });
  const box = connectMailbox({ provider: 'gmail', email: 'clerk@house.example', appPassword: PASS }, { ImapClient: FakeImap });
  server.uidValidity = 8n;
  const got = await box.fetchSince(new Date(Date.UTC(2026, 10, 11)), { domains: 'broker.example', afterUid: 500, uidValidity: '7' });
  assert.ok(calls.searches[0].query.since instanceof Date, 'a date search, not the old numbers');
  assert.deepEqual(got.map((m) => m.uid), [1]);
  assert.equal(got.uidValidity, '8');
});

test('IMAP on another port than 993 must upgrade with STARTTLS', async () => {
  const { FakeImap, calls } = fakeImap();
  const box = connectMailbox({ provider: 'custom', host: 'imap.house.example', port: 143, email: 'clerk@house.example', appPassword: PASS }, { ImapClient: FakeImap });
  await box.test();
  assert.equal(calls.options.secure, false);
  assert.equal(calls.options.doSTARTTLS, true);
  const refused = friendlyMailError(Object.assign(new Error('Server does not support STARTTLS'), { tlsFailed: true }));
  assert.match(refused.message, /does not offer an encrypted connection/);
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
  assert.equal(matchesDomains(env, []), false, 'no domains: nothing matches');
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

test('cleanDomains takes domains typed any way', () => {
  assert.deepEqual(cleanDomains('Broker.example, @lab.example https://www.air.example/x; broker.example'), ['broker.example', 'lab.example', 'air.example']);
  assert.deepEqual(cleanDomains(undefined), []);
});

test('listOf splits address lists', () => {
  assert.deepEqual(listOf('a@x.example; b@y.example, '), ['a@x.example', 'b@y.example']);
  assert.deepEqual(listOf(undefined), []);
});

test('fetchSince does not download a message over 50 MB: it lists it in tooBig instead', async () => {
  const big = { ...message(2, 'ops@broker.example', 'All the scans', 12), size: MAX_MESSAGE_BYTES + 1 };
  const msgs = [message(1, 'ops@broker.example', 'Invoice EXP/26-27/28', 11), big, { ...message(3, 'news@shop.example', 'Huge newsletter', 12), size: MAX_MESSAGE_BYTES * 2 }];
  const { FakeImap, calls } = fakeImap({ messages: msgs });
  const box = connectMailbox({ provider: 'zoho', email: 'clerk@house.example', appPassword: PASS }, { ImapClient: FakeImap });
  const got = await box.fetchSince(new Date(Date.UTC(2026, 10, 10)), { domains: ['broker.example'] });
  assert.deepEqual(got.map((m) => m.uid), [1]);
  assert.deepEqual(got.tooBig, [{ uid: 2, from: 'ops@broker.example', subject: 'All the scans', size: MAX_MESSAGE_BYTES + 1 }], 'only mail from the domains is named');
  assert.equal(calls.fetches[0].query.size, true, 'the size comes with the headers');
  assert.ok(!calls.fetches.some((f) => f.query.source && f.range.includes(2)), 'the big one is never downloaded');
  assert.equal(got.lastUid, 3, 'and the cursor goes past it');
});
