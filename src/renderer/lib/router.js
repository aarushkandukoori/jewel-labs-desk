// The hash router: "#/shipments/abc?doc=d1&field=invoice.number" -> { name, id, sub, query }.
// Hash routes work from file:// in Electron and on GitHub Pages without any server setup.

export const ROUTES = [
  'welcome', 'home', 'shipments', 'papers', 'stones', 'activity', 'settings', 'desk',
];

/** Parses a location hash. Unknown routes fall back to home. */
export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [pathPart, queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(safeDecode);
  const query = {};
  for (const pair of queryPart.split('&').filter(Boolean)) {
    const [k, v = ''] = pair.split('=');
    query[safeDecode(k)] = safeDecode(v.replace(/\+/g, ' '));
  }
  const name = ROUTES.includes(parts[0]) ? parts[0] : 'home';
  return { name, id: parts[1] || null, sub: parts[2] || null, query, known: ROUTES.includes(parts[0]) || !parts.length };
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Builds a hash: href('shipments', 'abc', { doc: 'd1' }) -> "#/shipments/abc?doc=d1". */
export function href(name, id, query) {
  let out = `#/${name}`;
  if (id) out += `/${encodeURIComponent(id)}`;
  const pairs = Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (pairs.length) out += `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
  return out;
}

/** Goes to a route (adds a history entry, so Back works). */
export function go(name, id, query) {
  const next = href(name, id, query);
  if (typeof location !== 'undefined' && location.hash !== next) location.hash = next;
}

/** Changes the query of the current route without adding a history entry. */
export function replaceQuery(route, query) {
  const path = [route.name, route.id, route.sub].filter(Boolean).map((p) => encodeURIComponent(p)).join('/');
  const next = `#/${path}${href('', null, { ...route.query, ...query }).slice(2)}`;
  if (typeof history !== 'undefined' && typeof location !== 'undefined') {
    history.replaceState(null, '', next);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
}

/** Which shell a route belongs to: the house portal or the Jewel Labs desk. */
export function shellFor(route) {
  if (route.name === 'welcome') return 'welcome';
  if (route.name === 'desk') return 'desk';
  return 'house';
}
