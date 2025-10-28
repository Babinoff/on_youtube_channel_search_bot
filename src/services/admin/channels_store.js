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
  // Нормализация: поддерживаем как объекты каналов, так и строковые id
  const serverResults = serverChannels
    .map((c) => {
      if (typeof c === "string") {
        return { id: c, title: c, handle: null, source: "server" };
      }
      const id = c?.id;
      return { id, title: (c?.title || id), handle: (c?.handle || null), source: "server" };
    })
    .filter((c) => !!c.id);

  cache = { rawKey: cacheKey, list: serverResults, ts: now };
  return serverResults;
}

module.exports = {
  getAdminChannels,
};