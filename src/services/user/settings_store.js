const fs = require("fs");
const path = require("path");
const { env } = require("../../config/env");

const USERS_DIR = path.resolve(process.cwd(), "data", "users");

function ensureDir() {
  try {
    fs.mkdirSync(USERS_DIR, { recursive: true });
  } catch {}
}

function defaultSettings() {
  const threshold = typeof env.SEARCH_MAX_DISTANCE === "number" ? env.SEARCH_MAX_DISTANCE : parseFloat(env.SEARCH_MAX_DISTANCE) || 0.75;
  const k = Number(env.SEARCH_TOP_K || 5);
  return {
    type: null, // "short" | "stream" | "video" | null
    threshold,
    k,
    showScore: true,
  };
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
    return { ...defaultSettings(), ...json };
  } catch {
    return defaultSettings();
  }
}

function updateUserSettings(userId, changes) {
  const current = getUserSettings(userId);
  const next = { ...current, ...changes };
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