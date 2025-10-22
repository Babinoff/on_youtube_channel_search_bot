require("dotenv").config();
const { logger } = require("../config/logger");
const { env } = require("../config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("../services/youtube/client");
const { normalizeDescription } = require("../services/text/normalize");
const { toVideoEntity } = require("../services/youtube/video");

function formatDateYYYYMMDD(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

async function main() {
  const client = createYouTubeClient(env.YOUTUBE_API_KEY);
  if (!env.YOUTUBE_API_KEY) {
    logger.error("YOUTUBE_API_KEY отсутствует — заполните .env");
    process.exit(1);
  }

  const inputArg = process.argv[2];
  const inputEnv = env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_CHANNEL_ID || env.YOUTUBE_CHANNEL_URL || env.YOUTUBE_CHANNEL_HANDLE || null;
  let activeId = null;
  try { ({ getActiveChannelId } = require("../services/admin/server_settings_store")); } catch (_) {}
  try { activeId = typeof getActiveChannelId === 'function' ? await getActiveChannelId() : null; } catch (_) { activeId = null; }
  const useArg = Boolean(inputArg);
  const raw = useArg ? inputArg : (inputEnv || activeId);
  if (!raw) {
    logger.error("Не удалось определить канал: укажите аргумент, .env (YOUTUBE_CHANNEL_ID|URL|HANDLE) или установите активный канал.");
    process.exit(1);
  }
  const channelId = /^UC[\w-]{20,}$/.test(raw) ? raw : await resolveChannelId(raw, client);

  logger.info({ channelId, source: useArg ? 'argv' : (inputEnv ? 'env' : 'active') }, "Предпросмотр индексации");

  const uploadsId = await getUploadsPlaylistId(channelId, client);
  const page1 = await listUploadsVideos(uploadsId, client);
  const videoIds = (page1.items || []).map(i => i.contentDetails?.videoId).filter(Boolean).slice(0, 10);
  logger.info({ count: videoIds.length }, "Выбрано видео для предпросмотра (до 10)");

  const details = videoIds.length ? await getVideosDetails(videoIds, client) : [];

  const docsMeta = details.map((v, idx) => {
    const base = toVideoEntity(v);
    const descriptionIndexed = normalizeDescription(base.description);
    const etag = v.etag || null;
    return {
      id: base.id,
      title: base.title,
      descriptionIndexed,
      publishedAt: base.publishedAt,
      channelId,
      etag,
      idx,
    };
  });

  console.log(JSON.stringify({ channelId, count: docsMeta.length, ids: docsMeta.map(d => d.id) }, null, 2));
}

main().catch((err) => {
  logger.error({ err }, "Ошибка предпросмотра индексации");
  process.exit(1);
});