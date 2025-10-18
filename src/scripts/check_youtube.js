require("dotenv").config();
const { logger } = require("../config/logger");
const { env } = require("../config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("../services/youtube/client");

async function main() {
  try {
    const inputArg = process.argv[2];
    const inputEnv = env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_CHANNEL_ID;
    const input = inputEnv || inputArg;
    if (!env.YOUTUBE_API_KEY) {
      logger.error("YOUTUBE_API_KEY отсутствует. Заполните .env и повторите.");
      process.exit(1);
    }
    if (!input) {
      logger.info("Укажите канал через .env (YOUTUBE_CHANNEL_ID) или аргумент: npm run check:youtube -- <channelId|url|@handle>");
      process.exit(1);
    }

    const client = createYouTubeClient(env.YOUTUBE_API_KEY);
    logger.info({ inputFrom: inputEnv ? "env" : "argv", input }, "Резолв канала...");
    let channelId;
    if (inputEnv) {
      // Если задан точный идентификатор канала через .env — используем его напрямую
      channelId = inputEnv;
    } else {
      channelId = await resolveChannelId(input, client);
    }
    logger.info({ channelId }, "Канал определён");

    const uploadsId = await getUploadsPlaylistId(channelId, client);
    logger.info({ uploadsId }, "Плейлист загрузок получен");

    const page1 = await listUploadsVideos(uploadsId, client);
    const videoIds = (page1.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);

    logger.info({ count: videoIds.length }, "Видео в первой странице плейлиста");
    let details = [];
    if (videoIds.length) {
      details = await getVideosDetails(videoIds.slice(0, 10), client);
    }

    details.slice(0, 5).forEach(v => {
      const id = v.id;
      const title = v.snippet?.title;
      const description = v.snippet?.description;
      const url = `https://youtu.be/${id}`;
      logger.info({ id, title, description, url }, "Видео");
    });

    logger.info("Проверка подключения к YouTube завершена успешно.");
  } catch (err) {
    const data = err?.response?.data;
    logger.error({ err: data || err.message }, "Ошибка при проверке YouTube");
    process.exit(1);
  }
}

main();