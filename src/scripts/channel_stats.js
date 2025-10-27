require("dotenv").config();
const { env } = require("../config/env");
const { resolveChannelId, createYouTubeClient, getUploadsPlaylistId, listUploadsVideos } = require("../services/youtube/client");
const { logger } = require("../config/logger");
const { openChannelTableIfExists, getChannelTableName } = require("../services/vector/lancedb");
const { getActiveChannelId } = require("../services/admin/server_settings_store");

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
  const rows = typeof qb.toArray === 'function' ? await qb.toArray() : await qb.limit(100000000).toArray();
  return { count: Array.isArray(rows) ? rows.length : 0, exists: true };
}

async function main() {
  try {
    const inputArg = process.argv[2];
    const useArg = Boolean(inputArg);
    const activeId = await getActiveChannelId();
    const input = useArg ? inputArg : activeId;
    if (!input) {
      logger.error("Активный канал не задан. Установите через админку или передайте аргумент: npm run channel:stats -- <channelId|url|@handle>");
      process.exit(1);
    }

    const client = createYouTubeClient(env.YOUTUBE_API_KEY);
    const channelId = await resolveChannelId(input, client);
    logger.info({ channelId, source: useArg ? 'argv' : 'settings' }, 'Статистика канала');

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