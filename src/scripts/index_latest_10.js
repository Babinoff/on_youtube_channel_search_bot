require("dotenv").config();
const { logger } = require("../config/logger");
const { env } = require("../config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("../services/youtube/client");
const { embedTexts } = require("../services/embeddings/mistral");
const { createTestTable } = require("../services/vector/lancedb");

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

async function main() {
  try {
    if (!env.YOUTUBE_API_KEY) {
      logger.error("YOUTUBE_API_KEY отсутствует. Заполните .env и повторите.");
      process.exit(1);
    }
    if (!env.MISTRAL_API_KEY) {
      logger.error("MISTRAL_API_KEY отсутствует. Заполните .env и повторите.");
      process.exit(1);
    }

    const inputArg = process.argv[2];
    const inputEnv = env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_CHANNEL_ID;
    const input = inputEnv || inputArg;
    if (!input) {
      logger.info("Укажите канал через .env (YOUTUBE_CHANNEL_ID) или аргумент: npm run index:test -- <channelId|url|@handle>");
      process.exit(1);
    }

    const client = createYouTubeClient(env.YOUTUBE_API_KEY);
    logger.info({ inputFrom: inputEnv ? "env" : "argv", input }, "Резолв канала...");
    const channelId = inputEnv ? inputEnv : await resolveChannelId(input, client);
    logger.info({ channelId }, "Канал определён");

    const uploadsId = await getUploadsPlaylistId(channelId, client);
    logger.info({ uploadsId }, "Плейлист загрузок получен");

    const page1 = await listUploadsVideos(uploadsId, client);
    const videoIds = (page1.items || []).map(i => i.contentDetails?.videoId).filter(Boolean).slice(0, 10);
    logger.info({ count: videoIds.length }, "Выбрано видео для индексации (до 10)");

    const details = videoIds.length ? await getVideosDetails(videoIds, client) : [];
    const docsMeta = details.map(v => {
      const id = v.id;
      const title = cleanText(v.snippet?.title || "");
      const description = cleanText(v.snippet?.description || "");
      const url = `https://youtu.be/${id}`;
      const publishedAt = v.snippet?.publishedAt || null;
      const etag = v.etag || null;
      return {
        id,
        title,
        description,
        url,
        channel_id: channelId,
        published_at: publishedAt,
        etag,
        last_indexed_at: new Date().toISOString(),
      };
    });

    const texts = docsMeta.map(d => `${d.title}\n\n${d.description}`);
    logger.info({ count: texts.length }, "Запрос эмбеддингов в Mistral");
    const vectors = await embedTexts(texts);
    if (!vectors.length) {
      throw new Error("Эмбеддинги не получены");
    }

    const docs = docsMeta.map((d, i) => ({ ...d, vector: vectors[i] }));
    const { tableName } = await createTestTable(docs);
    logger.info({ tableName, inserted: docs.length }, "Тестовая таблица создана и заполнена");

    // Простой sanity‑лог первого документа
    const sample = docs[0];
    if (sample) {
      logger.info({ id: sample.id, title: sample.title, url: sample.url, vectorDims: sample.vector?.length }, "Пример записи");
    }

    logger.info("Тестовая индексация завершена успешно.");
  } catch (err) {
    const data = err?.response?.data;
    logger.error({ err: data || err.message }, "Ошибка при тестовой индексации YouTube → LanceDB");
    process.exit(1);
  }
}

main();