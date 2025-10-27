require("dotenv").config();
const { logger } = require("../config/logger");
const { env } = require("../config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("../services/youtube/client");
const { getActiveChannelId } = require("../services/admin/server_settings_store");

async function main() {
  try {
    const inputArg = process.argv[2];
    const useArg = Boolean(inputArg);
    const input = useArg ? inputArg : await getActiveChannelId();
    if (!env.YOUTUBE_API_KEY) {
      logger.error("YOUTUBE_API_KEY отсутствует. Заполните .env и повторите.");
      process.exit(1);
    }
    if (!input) {
      logger.info("Укажите канал через аргумент или установите активный канал: npm run check:youtube -- <channelId|url|@handle>");
      process.exit(1);
    }

    const client = createYouTubeClient(env.YOUTUBE_API_KEY);
    logger.info({ inputFrom: useArg ? "argv" : "settings", input }, "Резолв канала...");
    const channelId = await resolveChannelId(input, client);
    logger.info({ channelId }, "Канал определён");

    const uploadsId = await getUploadsPlaylistId(channelId, client);
    logger.info({ uploadsId }, "Плейлист загрузок получен");

    const page1 = await listUploadsVideos(uploadsId, client);
    const videoIds = (page1.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
    const details = videoIds.length ? await getVideosDetails(videoIds, client) : [];
    logger.info({ count: details.length }, "Получены детали видео");
  } catch (err) {
    logger.error({ err: err?.message || err }, "Ошибка check_youtube");
    process.exit(1);
  }
}

main();