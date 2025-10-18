const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const LOCK_DIR = path.join(process.cwd(), 'tmp', 'locks');

async function ensureLockDir() {
  await fsp.mkdir(LOCK_DIR, { recursive: true });
}

function getLockPath(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(LOCK_DIR, `${safe}.lock`);
}

async function isLocked(name) {
  const p = getLockPath(name);
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

async function acquireLock(name, meta = {}) {
  await ensureLockDir();
  const p = getLockPath(name);
  try {
    const handle = await fsp.open(p, 'wx'); // fail if exists
    const payload = JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      meta,
    }, null, 2);
    await handle.writeFile(payload, { encoding: 'utf8' });
    await handle.close();
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
}

async function releaseLock(name) {
  const p = getLockPath(name);
  try {
    await fsp.unlink(p);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

async function waitForUnlock(name, { timeoutMs = 15000, checkIntervalMs = 500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const locked = await isLocked(name);
    if (!locked) return true;
    await new Promise((r) => setTimeout(r, checkIntervalMs));
  }
  return false; // timed out
}

async function withLock(name, fn, meta = {}) {
  const acquired = await acquireLock(name, meta);
  if (!acquired) throw new Error(`Lock '${name}' is already held`);
  try {
    return await fn();
  } finally {
    await releaseLock(name);
  }
}

// Read lock info (pid, startedAt, meta)
async function readLockInfo(name) {
  const p = getLockPath(name);
  try {
    const buf = await fsp.readFile(p, { encoding: 'utf8' });
    const json = JSON.parse(buf);
    return json;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'EISDIR')) return null;
    throw err;
  }
}

// Update meta in existing lock file
async function updateLockMeta(name, patch = {}) {
  const p = getLockPath(name);
  try {
    const buf = await fsp.readFile(p, { encoding: 'utf8' });
    const json = JSON.parse(buf);
    json.meta = { ...(json.meta || {}), ...(patch || {}) };
    await fsp.writeFile(p, JSON.stringify(json, null, 2), { encoding: 'utf8' });
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

module.exports = {
  isLocked,
  acquireLock,
  releaseLock,
  waitForUnlock,
  withLock,
  LOCK_DIR,
  readLockInfo,
  updateLockMeta,
};