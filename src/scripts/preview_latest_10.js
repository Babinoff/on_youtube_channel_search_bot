require("dotenv").config();
const { logger } = require("../config/logger");
const { env } = require("../config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("../services/youtube/client");
const { normalizeDescription } = require("../services/text/normalize");
const { toVideoEntity } = require("../services/youtube/video");
const { searchTopK } = require("../services/vector/lancedb");
const { getActiveChannelId } = require("../services/admin/server_settings_store");

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
  const useDb = process.argv.includes('--db') || String(process.env.PREVIEW_USE_DB || 'false') === 'true';

  const inputArg = process.argv[2];
  const activeId = await getActiveChannelId();
  const useArg = Boolean(inputArg);
  const raw = useArg ? inputArg : activeId;
  if (!raw) {
    logger.error("Не удалось определить канал: укажите аргумент или установите активный канал в settings.json (админка).");
    process.exit(1);
  }

  const isUC = /^UC[\w-]{20,}$/.test(raw);
  let channelId = null;
  let client = null;

  if (isUC) {
    channelId = raw;
  } else {
    if (!useDb) {
      if (!env.YOUTUBE_API_KEY) {
        logger.error("YOUTUBE_API_KEY отсутствует — заполните .env или укажите channelId формата UC... для режима без API");
        process.exit(1);
      }
      client = createYouTubeClient(env.YOUTUBE_API_KEY);
      channelId = await resolveChannelId(raw, client);
    } else {
      // В режиме --db пытаемся резолвить только при наличии API ключа; иначе требуем UC...
      if (env.YOUTUBE_API_KEY) {
        client = createYouTubeClient(env.YOUTUBE_API_KEY);
        channelId = await resolveChannelId(raw, client);
      } else {
        logger.error("Для режима --db укажите channelId вида UC... или задайте YOUTUBE_API_KEY");
        process.exit(1);
      }
    }
  }

  logger.info({ channelId, source: useArg ? 'argv' : 'settings', mode: useDb ? 'db' : 'api' }, "Предпросмотр последних видео");

  if (useDb) {
    const results = await searchTopK("", 10, { latestMode: true, channelId });
    console.log(JSON.stringify({ channelId, count: results.length, ids: results.map(r => r.id) }, null, 2));
    return;
  }

  const clientApi = client || createYouTubeClient(env.YOUTUBE_API_KEY);
  if (!env.YOUTUBE_API_KEY) {
    logger.error("YOUTUBE_API_KEY отсутствует — заполните .env");
    process.exit(1);
  }

  const uploadsId = await getUploadsPlaylistId(channelId, clientApi);
  const page1 = await listUploadsVideos(uploadsId, clientApi);
  const videoIds = (page1.items || []).map(i => i.contentDetails?.videoId).filter(Boolean).slice(0, 10);
  logger.info({ count: videoIds.length }, "Выбрано видео для предпросмотра (до 10)");

  const details = videoIds.length ? await getVideosDetails(videoIds, clientApi) : [];

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