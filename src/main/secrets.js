// Secrets: the OpenAI key a house pastes, mailbox app passwords, and the cloud sign-in session.
// They are encrypted with Electron safeStorage (the macOS Keychain or Windows DPAPI) and the file
// userData/secrets.json only ever holds base64 ciphertext. If the computer cannot encrypt, we refuse
// to store anything and the screens say so.
// The Keychain is only touched when there is a secret to read or write: an app that is not signed
// with an Apple Developer ID can make macOS ask the person for Keychain access, and a house that
// never saves a secret should never see that question.
import fs from 'node:fs';
import path from 'node:path';

export const NO_SAFE_STORAGE =
  'This computer cannot store secrets safely, so nothing was saved. You will need to enter it again next time.';

export function createSecrets({ file, safeStorage, platform = process.platform }) {
  let canEncrypt = null; // learned once, by init()
  let checking = null;

  // Asks the system once whether it can encrypt. Reads and writes wait for this first.
  function init() {
    if (!checking) {
      checking = Promise.resolve()
        .then(() => safeStorage.isAsyncEncryptionAvailable())
        .then((ok) => {
          // On Linux without a keyring, Electron falls back to a fixed password: not safe enough.
          const plainText = platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text';
          canEncrypt = Boolean(ok) && !plainText;
        })
        .catch(() => {
          canEncrypt = false;
        })
        .then(() => canEncrypt);
    }
    return checking;
  }

  // true or false once known; null while nothing has needed the Keychain yet.
  function available() {
    return canEncrypt;
  }

  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAll(all) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function has(name) {
    return Boolean(readAll()[name]);
  }

  async function get(name) {
    const stored = readAll()[name];
    if (!stored || !(await init())) return null;
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(stored, 'base64'));
      if (shouldReEncrypt) await set(name, result); // the system rotated its key: store it under the new one
      return result;
    } catch {
      return null; // encrypted on another computer or by another user: treat as missing
    }
  }

  async function set(name, value) {
    if (!(await init())) throw new Error(NO_SAFE_STORAGE);
    const encrypted = await safeStorage.encryptStringAsync(String(value));
    const all = readAll();
    all[name] = Buffer.from(encrypted).toString('base64');
    writeAll(all);
  }

  function remove(name) {
    const all = readAll();
    if (!(name in all)) return;
    delete all[name];
    writeAll(all);
  }

  // Storage for the Supabase client's session. When the computer cannot encrypt, the session is
  // kept in memory only: the person stays signed in until they quit.
  function storage(prefix) {
    const memory = new Map();
    return {
      async getItem(key) {
        return memory.has(key) ? memory.get(key) : get(`${prefix}:${key}`);
      },
      async setItem(key, value) {
        if (await init()) await set(`${prefix}:${key}`, value);
        else memory.set(key, value);
      },
      async removeItem(key) {
        memory.delete(key);
        remove(`${prefix}:${key}`);
      },
    };
  }

  return { init, available, has, get, set, remove, storage };
}
