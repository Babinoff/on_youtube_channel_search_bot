const fs = require("fs/promises");
const path = require("path");
const { logger } = require("../../config/logger");
const { env } = require("../../config/env");
const { createYouTubeClient } = require("../youtube/client");

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
    // Автомиграция: переводим массив channels в объекты { id, title, handle }
    const normalized = await normalizeChannelsIfNeeded(parsed);
    return normalized;
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
  // Предотвращаем дубликаты (на случай старых записей-строк)
  const exists = s.channels.some(c => (typeof c === 'string' ? c === id : c.id === id));
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

// ===== Helpers: normalize channels and fetch metadata =====

async function normalizeChannelsIfNeeded(settings) {
  try {
    const arr = Array.isArray(settings.channels) ? settings.channels : [];
    const needsNormalize = arr.some(c => (
      typeof c === 'string' || !c || !c.id || (typeof c.title === 'undefined' && typeof c.handle === 'undefined')
    ));

    if (!needsNormalize) return settings;

    const out = [];
    for (const c of arr) {
      if (typeof c === 'string') {
        const info = await fetchChannelInfoBestEffort(c);
        out.push({ id: info.id, title: info.title, handle: info.handle, source: 'server' });
      } else if (c && c.id) {
        // Если отсутствуют метаданные — подтянем
        if (typeof c.title === 'undefined' && typeof c.handle === 'undefined') {
          const info = await fetchChannelInfoBestEffort(c.id);
          out.push({ id: c.id, title: info.title, handle: info.handle, source: c.source || 'server' });
        } else {
          out.push({ id: c.id, title: c.title || c.id, handle: c.handle || null, source: c.source || 'server' });
        }
      }
    }

    const next = { ...settings, channels: out };
    await writeSettings(next); // persist миграцию
    logger.info({ msg: 'Server settings: channels normalized to id/title/handle', count: out.length });
    return next;
  } catch (e) {
    logger.warn({ msg: 'Failed to normalize channels; leaving as-is', error: String(e && e.message || e) });
    return settings;
  }
}

async function fetchChannelInfoBestEffort(id) {
  if (!id) return { id: null, title: null, handle: null };
  // Если нет ключа, вернём id как title
  if (!env.YOUTUBE_API_KEY) return { id, title: id, handle: null };
  try {
    const client = createYouTubeClient(env.YOUTUBE_API_KEY);
    const resp = await client.get('/channels', { params: { part: 'snippet', id } });
    const item = resp?.data?.items?.[0];
    const title = item?.snippet?.title || id;
    const customUrl = item?.snippet?.customUrl || null;
    // У YouTube customUrl может быть вида "@handle" — используем как handle
    const handle = customUrl && customUrl.startsWith('@') ? customUrl : null;
    return { id, title, handle };
  } catch (e) {
    logger.warn({ msg: 'Failed to fetch channel info; fallback to id as title', id, error: String(e && e.message || e) });
    return { id, title: id, handle: null };
  }
}