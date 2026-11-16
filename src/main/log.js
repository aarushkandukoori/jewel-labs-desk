// A tiny logger. Lines go to the console and to a log file in the app's logs folder, so support can
// ask a house for it. Never pass secrets (keys, passwords, sessions) to it.
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

function format(part) {
  if (part instanceof Error) return part.stack || part.message;
  if (typeof part === 'string') return part;
  try {
    return JSON.stringify(part).slice(0, 2000);
  } catch {
    return String(part);
  }
}

export function createLog({ out = console } = {}) {
  let file = null;

  // Keeps the file small: when it passes 5 MB the old one becomes main.old.log.
  function append(line) {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_FILE_BYTES) fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
      fs.appendFileSync(file, line + '\n');
    } catch {
      // logging must never break the app
    }
  }

  function write(level, parts) {
    const text = parts.map(format).join(' ');
    const print = level === 'error' ? out.error : level === 'warn' ? out.warn : out.log;
    print.call(out, `[jewel-labs] ${level} ${text}`);
    append(`${new Date().toISOString()} ${level} ${text}`);
  }

  return {
    info: (...parts) => write('info', parts),
    warn: (...parts) => write('warn', parts),
    error: (...parts) => write('error', parts),
    setFile(f) {
      file = f;
    },
    get file() {
      return file;
    },
  };
}
