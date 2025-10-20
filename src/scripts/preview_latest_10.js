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

  // Channel strictly from env (no CLI overrides)
  const channelId = env.YOUTUBE_CHANNEL_ID
    || (env.YOUTUBE_CHANNEL_URL || env.YOUTUBE_CHANNEL_HANDLE
        ? await resolveChannelId(env.YOUTUBE_CHANNEL_URL || env.YOUTUBE_CHANNEL_HANDLE, client)
        : null);
  if (!channelId) {
    logger.error("Не удалось определить канал: задайте YOUTUBE_CHANNEL_ID в .env (или URL/handle)");
    process.exit(1);
  }

  logger.info({ channelId }, "Предпросмотр индексации (только значения из .env)");

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
      description: base.description,
      description_indexed: descriptionIndexed,
      url: base.url,
      channel_id: channelId,
      published_at: base.publishedAt,
      etag,
      type: base.type,
      last_indexed_at: new Date().toISOString(),
      _preview_index: idx + 1,
    };
  });

  // Human-readable output + exact JSON object to be inserted (sans vector)
  docsMeta.forEach((d, i) => {
    const dateStr = formatDateYYYYMMDD(d.published_at) || String(d.published_at || "");
    const header = `=== [${i + 1}/${docsMeta.length}] ${d.title}`;
    const meta = `id: ${d.id} | date: ${dateStr} | type: ${d.type} | ${d.url}`;
    const rawLen = (d.description || "").length;
    const idxLen = (d.description_indexed || "").length;

    console.log(header);
    console.log(meta);
    console.log("description.raw (len=" + rawLen + "):");
    console.log(d.description || "<empty>");
    console.log("\n-- cleaned description_indexed (len=" + idxLen + "):");
    console.log(d.description_indexed || "<empty>");
    console.log("\nJSON doc to insert (sans vector):");
    console.log(JSON.stringify({
      id: d.id,
      title: d.title,
      description_indexed: d.description_indexed,
      url: d.url,
      channel_id: d.channel_id,
      published_at: d.published_at,
      etag: d.etag,
      type: d.type,
      last_indexed_at: d.last_indexed_at,
    }, null, 2));
    console.log("\n");
  });

  logger.info({ total: docsMeta.length }, "Предпросмотр завершён — отражает текущие .env настройки один в один");
}

main().catch((err) => {
  logger.error({ err }, "Ошибка предпросмотра индексации");
  process.exit(1);
});