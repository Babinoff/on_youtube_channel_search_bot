require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { env } = require("../config/env");
const { getChannelTableName } = require("../services/vector/lancedb");
const { isLocked } = require("../services/concurrency/lock");
const { createYouTubeClient, resolveChannelId } = require("../services/youtube/client");

function getDbDir() {
  return env.LANCEDB_DIR || "./data/lancedb";
}

async function resolveInputChannelId(input) {
  if (env.YOUTUBE_CHANNEL_ID) return env.YOUTUBE_CHANNEL_ID;
  if (!input) return null;
  if (!env.YOUTUBE_API_KEY) return input; // best effort
  const client = createYouTubeClient(env.YOUTUBE_API_KEY);
  return await resolveChannelId(input, client);
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const yes = args.includes("--yes") || args.includes("-y");
    const input = args.find((a) => a && !a.startsWith("-"));

    if (!yes) {
      console.error("Добавьте --yes для подтверждения удаления таблицы канала.");
      console.error("Пример: npm run channel:db:delete -- UCxxxxxxxxxxxxxxxxxxxxxx --yes");
      process.exit(1);
    }

    const locked = await isLocked('indexing');
    if (locked) {
      console.error("Индексация активна. Остановите процесс перед удалением таблицы канала.");
      process.exit(1);
    }

    const channelId = await resolveInputChannelId(input);
    if (!channelId) {
      console.error("Укажите канал через .env (YOUTUBE_CHANNEL_ID) или аргумент.");
      process.exit(1);
    }

    const dir = getDbDir();
    const tableName = getChannelTableName(channelId);
    const tableDir = path.join(dir, tableName);

    if (!fs.existsSync(tableDir)) {
      console.log(`Таблица ${tableName} не найдена (${tableDir}).`);
      process.exit(0);
    }

    fs.rmSync(tableDir, { recursive: true, force: true });
    console.log(`Удалена таблица канала: ${tableName}`);
  } catch (err) {
    console.error("Ошибка удаления таблицы канала:", err.message);
    process.exit(1);
  }
}

main();