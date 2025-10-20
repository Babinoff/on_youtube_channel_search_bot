const fs = require("fs");
const path = require("path");
const { env } = require("../../config/env");

const USERS_DIR = path.resolve(process.cwd(), "data", "users");

function ensureDir() {
  try {
    fs.mkdirSync(USERS_DIR, { recursive: true });
  } catch {}
}

function normalizeSettings(input) {
  const maxK = Number(env.SEARCH_MAX_K || 20);
  const defaultThreshold = env.SEARCH_MAX_DISTANCE;

  const tRaw = input.type;
  const type = (tRaw === 'short' || tRaw === 'stream' || tRaw === 'video') ? tRaw : null;

  let threshold = typeof input.threshold === 'number' ? input.threshold : parseFloat(input.threshold);
  if (!Number.isFinite(threshold)) threshold = defaultThreshold;

  let kNum = Number(input.k);
  if (!Number.isFinite(kNum) || kNum < 1) kNum = 1;
  kNum = Math.min(kNum, maxK);

  const showScore = !!input.showScore;
  const channelId = (typeof input.channelId === 'string' && input.channelId) ? input.channelId : null;

  return {
    type,
    threshold,
    k: kNum,
    showScore,
    channelId,
  };
}

function defaultSettings() {
  const base = {
    type: null, // "short" | "stream" | "video" | null
    threshold: env.SEARCH_MAX_DISTANCE,
    k: Number(env.SEARCH_TOP_K || env.SEARCH_MAX_K || 20),
    showScore: true,
    channelId: null,
  };
  return normalizeSettings(base);
}

function getUserFilePath(userId) {
  ensureDir();
  return path.join(USERS_DIR, `${String(userId)}.json`);
}

function getUserSettings(userId) {
  try {
    const fp = getUserFilePath(userId);
    if (!fs.existsSync(fp)) return defaultSettings();
    const raw = fs.readFileSync(fp, "utf8");
    const json = JSON.parse(raw);
    return normalizeSettings({ ...defaultSettings(), ...json });
  } catch {
    return defaultSettings();
  }
}

function updateUserSettings(userId, changes) {
  const current = getUserSettings(userId);
  const next = normalizeSettings({ ...current, ...changes });
  const fp = getUserFilePath(userId);
  fs.writeFileSync(fp, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function resetUserSettings(userId) {
  const fp = getUserFilePath(userId);
  try { fs.unlinkSync(fp); } catch {}
  return defaultSettings();
}

module.exports = { getUserSettings, updateUserSettings, resetUserSettings, defaultSettings };