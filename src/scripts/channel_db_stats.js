require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { env } = require("../config/env");
const { openChannelTableIfExists, countIndexed } = require("../services/vector/lancedb");
const { getChannelTableName } = require("../services/vector/lancedb_tables");
const { getActiveChannelId } = require("../services/admin/server_settings_store");

function getDbDir() {
  return env.LANCEDB_DIR || "./data/lancedb";
}

async function countIndexed(channelId) {
  const { table } = await openChannelTableIfExists(channelId);
  if (!table) return { count: 0, exists: false };
  // Совместимо с используемой версией LanceDB: используем query().select(["id"]).toArray()
  const qb = table.query().select(["id"]);
  const rows = typeof qb.toArray === 'function' ? await qb.toArray() : await qb.limit(100000000).toArray();
  return { count: Array.isArray(rows) ? rows.length : 0, exists: true };
}

function readModified(tableName) {
  try {
    const dir = getDbDir();
    const full = path.join(dir, tableName);
    const stat = fs.statSync(full);
    return stat.mtime?.toISOString?.() || String(stat.mtime);
  } catch {
    return null;
  }
}

async function main() {
  try {
    const inputArg = process.argv[2];
    const useArg = Boolean(inputArg);
    const activeId = await getActiveChannelId();
    const channelId = useArg ? inputArg : activeId;
    if (!channelId) {
      logger.error("Активный канал не задан. Установите через админку или передайте аргумент: npm run channel:db:stats -- <channelId>");
      process.exit(1);
    }
    logger.info({ channelId, source: useArg ? 'argv' : 'settings' }, 'Статистика по таблице канала');
    const tableName = getChannelTableName(channelId);
    const indexed = await countIndexed(channelId);
    const modified = readModified(tableName);

    console.log(`Канал (raw): ${channelId}`);
    console.log(`Таблица: ${tableName} ${indexed.exists ? '(найдена)' : '(не найдена)'}`);
    console.log(`Проиндексировано (LanceDB): ${indexed.count}`);
    console.log(`Модифицировано: ${modified || 'n/a'}`);
  } catch (err) {
    console.error("Ошибка получения DB-статистики:", err.message);
    process.exit(1);
  }
}

main();