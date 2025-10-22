require("dotenv").config();
const { env } = require("../config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos } = require("../services/youtube/client");
const { openChannelTableIfExists, getChannelTableName } = require("../services/vector/lancedb");

async function countUploads(channelId) {
  if (!env.YOUTUBE_API_KEY) {
    return { count: null, error: "YOUTUBE_API_KEY отсутствует" };
  }
  const client = createYouTubeClient(env.YOUTUBE_API_KEY);
  const uploadsId = await getUploadsPlaylistId(channelId, client);
  let total = 0;
  let token = undefined;
  while (true) {
    const page = await listUploadsVideos(uploadsId, client, token);
    const items = page.items || [];
    total += items.length;
    token = page.nextPageToken;
    if (!token) break;
  }
  return { count: total };
}

async function countIndexed(channelId) {
  const { table } = await openChannelTableIfExists(channelId);
  if (!table) return { count: 0, exists: false };
  // Совместимо с используемой версией LanceDB: используем query().select(["id"]).toArray()
  const qb = table.query().select(["id"]);
  const rows = await qb.toArray();
  return { count: Array.isArray(rows) ? rows.length : 0, exists: true };
}

async function main() {
  try {
    const inputArg = process.argv[2];
    const inputEnv = env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_CHANNEL_ID;
    const useArg = Boolean(inputArg);
    const input = useArg ? inputArg : inputEnv;
    if (!input) {
      console.error("Укажите канал через аргумент или .env (YOUTUBE_CHANNEL_ID).");
      process.exit(1);
    }

    const client = env.YOUTUBE_API_KEY ? createYouTubeClient(env.YOUTUBE_API_KEY) : null;
    const channelId = client ? await resolveChannelId(input, client) : input;

    const uploads = await countUploads(channelId);
    const indexed = await countIndexed(channelId);

    const uploadsCount = uploads.count;
    const indexedCount = indexed.count;
    const coverage = typeof uploadsCount === 'number' && uploadsCount > 0
      ? Math.round((indexedCount / uploadsCount) * 100)
      : null;

    const tableName = getChannelTableName(channelId);

    console.log(`Канал: ${channelId}`);
    console.log(`Таблица: ${tableName} ${indexed.exists ? '(найдена)' : '(не найдена)'}`);
    console.log(`Загружено (YouTube): ${uploadsCount === null ? 'неизвестно' : uploadsCount}`);
    console.log(`Проиндексировано (LanceDB): ${indexedCount}`);
    console.log(`Покрытие: ${coverage === null ? 'n/a' : coverage + '%'}`);
  } catch (err) {
    console.error("Ошибка получения статистики:", err.message);
    process.exit(1);
  }
}

main();