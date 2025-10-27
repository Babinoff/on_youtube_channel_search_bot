const fs = require("fs/promises");
const path = require("path");
const { logger } = require("../../config/logger");

const SETTINGS_DIR = path.resolve(process.cwd(), "data", "server");
const SETTINGS_PATH = path.join(SETTINGS_DIR, "settings.json");

async function ensureDir() {
  try { await fs.mkdir(SETTINGS_DIR, { recursive: true }); } catch {}
}

async function readSettings() {
  await ensureDir();
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.channels) parsed.channels = [];
    if (typeof parsed.activeChannelId === "undefined") parsed.activeChannelId = null;
    return parsed;
  } catch {
    const initial = { channels: [], activeChannelId: null, updatedAt: new Date().toISOString() };
    await fs.writeFile(SETTINGS_PATH, JSON.stringify(initial, null, 2), "utf-8");
    return initial;
  }
}

async function writeSettings(s) {
  const next = { ...s, updatedAt: new Date().toISOString() };
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

async function getServerSettings() {
  return await readSettings();
}

async function addChannel({ id, handle = null, title = null }) {
  const s = await readSettings();
  const exists = s.channels.some(c => c.id === id);
  if (!exists) {
    s.channels.push({ id, handle, title, source: "server" });
  }
  return await writeSettings(s);
}

async function removeChannel(id) {
  const s = await readSettings();
  s.channels = s.channels.filter(c => c.id !== id);
  if (s.activeChannelId === id) s.activeChannelId = null;
  return await writeSettings(s);
}

async function setActiveChannel(id) {
  const s = await readSettings();
  s.activeChannelId = id;
  await writeSettings(s);
  return s;
}

async function getActiveChannelId() {
  const s = await readSettings();
  // Единый источник правды: только settings.json
  return s.activeChannelId || null;
}

module.exports = {
  SETTINGS_PATH,
  getServerSettings,
  addChannel,
  removeChannel,
  setActiveChannel,
  getActiveChannelId,
};