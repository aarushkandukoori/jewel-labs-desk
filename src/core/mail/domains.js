// Email domain lists ("broker.example, lab.example"). Kept apart from index.js so services.js can check a list
// without loading the mail libraries.

/** 'Broker.example, @lab.example https://www.air.example' or an array -> ['broker.example', 'lab.example', 'air.example']. */
export function cleanDomains(domains) {
  const list = Array.isArray(domains) ? domains : String(domains || '').split(/[,;\s]+/);
  const clean = list
    .map((d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^.*@/, '').replace(/^www\./, ''))
    .filter(Boolean);
  return [...new Set(clean)];
}

/**
 * True when the sender (or someone copied) is at one of the domains. An empty list matches nothing: a mailbox
 * with no domains brings in no mail at all. The "to" line is skipped on purpose: it is usually the house itself.
 */
export function matchesDomains(envelope, domains) {
  const list = cleanDomains(domains);
  if (!list.length) return false;
  const people = ['from', 'sender', 'replyTo', 'cc'].flatMap((key) => envelope?.[key] || []);
  return people.some((person) => {
    const domain = String(person?.address || '').toLowerCase().split('@')[1] || '';
    return list.some((d) => domain === d || domain.endsWith(`.${d}`));
  });
}
