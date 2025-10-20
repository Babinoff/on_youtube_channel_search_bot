require("dotenv").config();
const { logger } = require("../config/logger");
const { env } = require("../config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("../services/youtube/client");
const { acquireLock, releaseLock, updateLockMeta } = require("../services/concurrency/lock");
const { embedTexts } = require("../services/embeddings");
const { createTestTable } = require("../services/vector/lancedb");
const { normalizeDescription } = require("../services/text/normalize");
const { toVideoEntity } = require("../services/youtube/video");


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
    

    const inputArg = process.argv[2];
    const inputEnv = env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_CHANNEL_ID;
    const input = inputEnv || inputArg;
    if (!input) {
      logger.info("Укажите канал через .env (YOUTUBE_CHANNEL_ID) или аргумент: npm run index:test -- <channelId|url|@handle>");
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
    logger.info({ inputFrom: inputEnv ? "env" : "argv", input }, "Резолв канала...");
    const channelId = inputEnv ? inputEnv : await resolveChannelId(input, client);
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
    const { tableName } = await createTestTable(docs);
    logger.info({ tableName, inserted: docs.length }, "Тестовая таблица создана и заполнена");

    const sample = docs[0];
    if (sample) {
      logger.info({ id: sample.id, title: sample.title, url: sample.url, vectorDims: sample.vector?.length, descIndexedLen: sample.description_indexed.length }, "Пример записи");
    }

    await updateLockMeta('indexing', { stage: 'done' });
    logger.info("Тестовая индексация завершена успешно.");
  } catch (err) {
    const data = err?.response?.data;
    logger.error({ err: data || err.message }, "Ошибка при тестовой индексации YouTube → LanceDB");
  } finally {
    if (stopHeartbeat) stopHeartbeat();
    if (lockAcquired) {
      try { await releaseLock('indexing'); } catch (_) {}
    }
  }
}

main();