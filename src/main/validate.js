// Small argument checks for the bridge handlers. The renderer is our own code, but every value that
// crosses the bridge is still checked, so a bug (or a bad page) gets a clear message instead of odd behaviour.

export function needString(value, name, { max = 20000 } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${name}.`);
  if (value.length > max) throw new Error(`The ${name} is too long.`);
  return value.trim();
}

export function optionalString(value, name, { max = 20000 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`The ${name} must be text.`);
  if (value.length > max) throw new Error(`The ${name} is too long.`);
  return value.trim();
}

export function needObject(value, name) {
  if (!isPlainObject(value)) throw new Error(`Missing ${name}.`);
  return value;
}

export function optionalObject(value, name) {
  if (value === undefined || value === null) return {};
  return needObject(value, name);
}

export function needBoolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`The ${name} must be true or false.`);
  return value;
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Links we hand to the default browser or mail app. Nothing else (no file:, javascript: or custom schemes).
export function isSafeExternalUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}
