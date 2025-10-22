const { env } = require("../../config/env");
const { logger } = require("../../config/logger");
const { createYouTubeClient, resolveChannelId } = require("../youtube/client");
const { getServerSettings } = require("./server_settings_store");

let cache = { rawKey: null, list: null, ts: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут

async function fetchChannelInfo(channelId, client) {
  const c = client || (env.YOUTUBE_API_KEY ? createYouTubeClient(env.YOUTUBE_API_KEY) : null);
  if (!c) return { id: channelId, title: channelId, handle: null };
  const resp = await c.get("/channels", { params: { part: "snippet", id: channelId } });
  const item = resp?.data?.items?.[0];
  const title = item?.snippet?.title || channelId;
  const customUrl = item?.snippet?.customUrl || null;
  const handle = customUrl && customUrl.startsWith("@") ? customUrl : null;
  return { id: channelId, title, handle };
}

async function getAdminChannels() {
  const rawEnv = env.YOUTUBE_CHANNELS_ID || "";
  const settings = await getServerSettings();
  const cacheKey = `${rawEnv}|${settings.updatedAt || ""}`;
  const now = Date.now();
  if (cache.list && cache.rawKey === cacheKey && (now - cache.ts) < CACHE_TTL_MS) {
    return cache.list;
  }

  // Env channels
  const items = rawEnv.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
  const client = env.YOUTUBE_API_KEY ? createYouTubeClient(env.YOUTUBE_API_KEY) : null;
  const envResults = [];
  for (const it of items) {
    try {
      const id = it.startsWith("UC") ? it : (client ? await resolveChannelId(it, client) : null);
      if (!id) {
        logger.warn({ input: it }, "YOUTUBE_CHANNELS_ID: не удалось определить channelId (нужен YOUTUBE_API_KEY)");
        continue;
      }
      let info = { id, title: id, handle: null, source: "env" };
      try {
        // Reuse local fetch to enrich with title/handle
        info = { ...(await fetchChannelInfo(id, client)), source: "env" };
      } catch (e) {
        logger.warn({ channelId: id, err: e?.message }, "YOUTUBE_CHANNELS_ID: не удалось получить информацию о канале");
      }
      envResults.push(info);
    } catch (err) {
      logger.warn({ input: it, err: err?.message }, "YOUTUBE_CHANNELS_ID: ошибка обработки элемента");
    }
  }

  // Server-added channels
  const serverChannels = Array.isArray(settings.channels) ? settings.channels : [];
  const serverResults = serverChannels.map(c => ({ id: c.id, title: c.title || c.id, handle: c.handle || null, source: "server" }));

  // Merge: server first, then env order; de-duplicate by id
  const merged = [];
  const seen = new Set();
  for (const c of [...serverResults, ...envResults]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    merged.push(c);
  }

  cache = { rawKey: cacheKey, list: merged, ts: now };
  return merged;
}

module.exports = {
  getAdminChannels,
};