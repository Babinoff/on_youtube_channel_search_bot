require("dotenv").config();
const { logger } = require("../config/logger");
const { env } = require("../config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("../services/youtube/client");
const { acquireLock, releaseLock, updateLockMeta } = require("../services/concurrency/lock");
const { embedTexts } = require("../services/embeddings");
const { addDocsToChannelTable } = require("../services/vector/lancedb");
const { normalizeDescription } = require("../services/text/normalize");
const { toVideoEntity } = require("../services/youtube/video");
const { getActiveChannelId } = require("../services/admin/server_settings_store");


// Heuristic: strip trailing self‑promo sections using patterns from env





function startLockHeartbeat(name, intervalMs = 10000) {
  const timer = setInterval(() => {
    updateLockMeta(name, { heartbeatAt: new Date().toISOString() }).catch(() => {});
  }, intervalMs);
  return () => clearInterval(timer);
}

async function main() {
  let lockAcquired = false;
  let stopHeartbeat = null;
  try {
    if (!env.YOUTUBE_API_KEY) {
      logger.error("YOUTUBE_API_KEY отсутствует. Заполните .env и повторите.");
      process.exit(1);
    }
    

    // Аргумент из CLI имеет приоритет над settings.json,
    // но учитываем только позиционный аргумент без префикса "-"
    const positionalArg = process.argv.slice(2).find(a => a && !String(a).startsWith("-"));
    const useArg = Boolean(positionalArg);
    const activeId = await getActiveChannelId();
    const input = useArg ? positionalArg : activeId;
    if (!input) {
      logger.info("Активный канал не задан. Установите через /set_channel или передайте аргумент: npm run index:test -- <channelId|url|@handle>");
      process.exit(1);
    }

    lockAcquired = await acquireLock('indexing', { script: 'index_latest_10.js', input });
    if (!lockAcquired) {
      logger.warn("Индексация уже выполняется в другом процессе. Повторите позже.");
      process.exit(0);
    }
    stopHeartbeat = startLockHeartbeat('indexing', 10000);
    await updateLockMeta('indexing', { stage: 'resolve_channel', input });

    const client = createYouTubeClient(env.YOUTUBE_API_KEY);
    logger.info({ inputFrom: useArg ? "argv" : "settings", input }, "Резолв канала...");
    const channelId = await resolveChannelId(input, client);
    await updateLockMeta('indexing', { stage: 'list_uploads', channelId });
    logger.info({ channelId }, "Канал определён");

    const uploadsId = await getUploadsPlaylistId(channelId, client);
    logger.info({ uploadsId }, "Плейлист загрузок получен");
    await updateLockMeta('indexing', { stage: 'fetch_page', uploadsId });

    const page1 = await listUploadsVideos(uploadsId, client);
    const videoIds = (page1.items || []).map(i => i.contentDetails?.videoId).filter(Boolean).slice(0, 10);
    await updateLockMeta('indexing', { stage: 'fetch_details', total: videoIds.length, current: 0 });
    logger.info({ count: videoIds.length }, "Выбрано видео для индексации (до 10)");

    const details = videoIds.length ? await getVideosDetails(videoIds, client) : [];
    await updateLockMeta('indexing', { stage: 'normalize', total: details.length });
    const docsMeta = details.map(v => {
      const base = toVideoEntity(v);
      const descriptionIndexed = normalizeDescription(base.description);
      const etag = v.etag || null;
      return {
        id: base.id,
        title: base.title,
        description_indexed: descriptionIndexed,
        url: base.url,
        channel_id: channelId,
        published_at: base.publishedAt,
        etag,
        type: base.type,
        last_indexed_at: new Date().toISOString(),
      };
    });

    const texts = docsMeta.map(d => `${d.title}\n\n${d.description_indexed}`);
    await updateLockMeta('indexing', { stage: 'embedding', total: texts.length, current: 0 });
    logger.info({ count: texts.length, maxChars: env.DESC_MAX_CHARS }, "Запрос эмбеддингов (усечённые описания)");
    const vectors = await embedTexts(texts);
    await updateLockMeta('indexing', { stage: 'embedding', current: texts.length });
    if (!vectors.length) {
      throw new Error("Эмбеддинги не получены");
    }

    const docs = docsMeta.map((d, i) => ({ ...d, vector: vectors[i] }));
    await updateLockMeta('indexing', { stage: 'insert', total: docs.length });
    const { tableName } = await addDocsToChannelTable(channelId, docs);
    logger.info({ tableName, inserted: docs.length }, "Таблица канала обновлена");

    const sample = docs[0];
    if (sample) {
      logger.info({ id: sample.id, title: sample.title, url: sample.url, vectorDims: sample.vector?.length, descIndexedLen: sample.description_indexed.length }, "Пример записи");
    }

    await updateLockMeta('indexing', { stage: 'done' });
    logger.info("Индексация канала завершена успешно.");
  } catch (err) {
    const data = err?.response?.data;
    logger.error({ err: data || err.message }, "Ошибка при индексации канала YouTube → LanceDB");
  } finally {
    if (stopHeartbeat) stopHeartbeat();
    if (lockAcquired) {
      try { await releaseLock('indexing'); } catch (_) {}
    }
  }
}

main();