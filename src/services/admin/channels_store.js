const { getServerSettings } = require("./server_settings_store");

let cache = { rawKey: null, list: null, ts: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут

async function getAdminChannels() {
  const settings = await getServerSettings();
  const cacheKey = `${settings.updatedAt || ""}`;
  const now = Date.now();
  if (cache.list && cache.rawKey === cacheKey && (now - cache.ts) < CACHE_TTL_MS) {
    return cache.list;
  }

  const serverChannels = Array.isArray(settings.channels) ? settings.channels : [];
  const serverResults = serverChannels.map(c => ({ id: c.id, title: c.title || c.id, handle: c.handle || null, source: "server" }));

  cache = { rawKey: cacheKey, list: serverResults, ts: now };
  return serverResults;
}

module.exports = {
  getAdminChannels,
};