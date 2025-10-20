const { env } = require("../../config/env");
const { logger } = require("../../config/logger");
const { createYouTubeClient, resolveChannelId } = require("../youtube/client");

let cache = { raw: null, list: null, ts: 0 };
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
  const raw = env.YOUTUBE_CHANNELS_ID || "";
  const now = Date.now();
  if (cache.list && cache.raw === raw && (now - cache.ts) < CACHE_TTL_MS) {
    return cache.list;
  }

  const items = raw.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) {
    cache = { raw, list: [], ts: now };
    return [];
  }

  const client = env.YOUTUBE_API_KEY ? createYouTubeClient(env.YOUTUBE_API_KEY) : null;
  const results = [];
  for (const it of items) {
    try {
      const id = it.startsWith("UC") ? it : (client ? await resolveChannelId(it, client) : null);
      if (!id) {
        logger.warn({ input: it }, "YOUTUBE_CHANNELS_ID: не удалось определить channelId (нужен YOUTUBE_API_KEY)");
        continue;
      }
      let info = { id, title: id, handle: null };
      try {
        info = await fetchChannelInfo(id, client);
      } catch (e) {
        logger.warn({ channelId: id, err: e?.message }, "YOUTUBE_CHANNELS_ID: не удалось получить информацию о канале");
      }
      results.push(info);
    } catch (err) {
      logger.warn({ input: it, err: err?.message }, "YOUTUBE_CHANNELS_ID: ошибка обработки элемента");
    }
  }

  // Порядок элементов совпадает с порядком в YOUTUBE_CHANNELS_ID
  cache = { raw, list: results, ts: now };
  return results;
}

module.exports = {
  getAdminChannels,
};