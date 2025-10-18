const lancedb = require("@lancedb/lancedb");
const fs = require("fs");
const path = require("path");
const { env } = require("../../config/env");
const { logger } = require("../../config/logger");
const { embedTexts } = require("../embeddings/mistral");
const { isLocked, waitForUnlock } = require("../concurrency/lock");
const { readLockInfo } = require("../concurrency/lock");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function connectDb() {
  const dir = env.LANCEDB_DIR || "./data/lancedb";
  ensureDir(dir);
  const db = await lancedb.connect(dir);
  return db;
}

function findLatestTestTableName() {
  const dir = env.LANCEDB_DIR || "./data/lancedb";
  ensureDir(dir);
  const entries = fs.readdirSync(dir).filter((e) => {
    const full = path.join(dir, e);
    try {
      return fs.statSync(full).isDirectory() && e.startsWith("video_embeddings_latest10_");
    } catch {
      return false;
    }
  });
  if (!entries.length) return null;
  const latest = entries.sort().slice(-1)[0];
  return latest;
}

async function openLatestTestTable() {
  const db = await connectDb();
  const tableName = findLatestTestTableName();
  if (!tableName) {
    throw new Error("Не найдена тестовая таблица video_embeddings_latest10_*. Сначала запустите npm run index:test");
  }
  const openName = tableName.replace(/\.lance$/, "");
  const table = await db.openTable(openName);
  logger.info({ tableName, openName }, "Открыл тестовую таблицу LanceDB");
  return { db, table, tableName };
}

async function createTestTable(docs) {
  const db = await connectDb();
  const tableName = `video_embeddings_latest10_${Date.now()}`;
  logger.info({ tableName }, "Создаю тестовую таблицу LanceDB");
  const table = await db.createTable(tableName, docs);
  return { db, table, tableName };
}

async function searchTopK(query, k = 5, opts = {}) {
  if (!env.MISTRAL_API_KEY) {
    throw new Error("MISTRAL_API_KEY отсутствует. Заполните .env");
  }

  // Если идёт индексация — подождать немного или сообщить пользователю
  const indexing = await isLocked('indexing');
  if (indexing) {
    const info = await readLockInfo('indexing');
    const stage = info?.meta?.stage;
    const total = info?.meta?.total;
    const current = info?.meta?.current;
    const startedAt = info?.startedAt;
    const updatedAt = info?.updatedAt;

    logger.warn("Индексация в процессе. Ожидание освобождения lock...", { stage, current, total, startedAt, updatedAt });
    const unlocked = await waitForUnlock('indexing', { timeoutMs: 15000, checkIntervalMs: 500 });
    if (!unlocked) {
      const statusPart = stage ? `Статус: ${stage}${typeof current==='number' && typeof total==='number' ? ` (${current}/${total})` : ''}.` : '';
      const startedPart = startedAt ? ` Начато: ${startedAt}.` : '';
      const updatedPart = updatedAt ? ` Обновлено: ${updatedAt}.` : '';
      throw new Error(`Поиск временно недоступен: идёт индексация. ${statusPart}${startedPart}${updatedPart}`);
    }
  }

  const [qVec] = await embedTexts([query]);
  if (!qVec || !Array.isArray(qVec)) {
    throw new Error("Не удалось получить эмбеддинг запроса");
  }
  const { tableName, table } = await openLatestTestTable();

  // Совместимость с разными версиями LanceDB: prefer vectorSearch() если доступен
  const qb = typeof table.vectorSearch === 'function' ? table.vectorSearch(qVec) : table.search(qVec);
  let res;
  if (typeof qb.toArray === 'function') {
    res = await qb.limit(k).toArray();
  } else {
    res = await qb.limit(k).execute();
  }

  const rows = Array.isArray(res)
    ? res
    : (typeof res?.toArray === "function" ? res.toArray() : []);

  // Пороговая фильтрация по дистанции (score): сохраняем только близкие матчи
  const maxDistance = typeof opts.maxDistance === 'number' ? opts.maxDistance : env.SEARCH_MAX_DISTANCE;
  const filtered = rows.filter((r) => {
    const d = r._distance ?? r.distance ?? r.score;
    return typeof d === 'number' ? d <= maxDistance : true;
  });
  const finalRows = filtered.length ? filtered : rows;

  logger.info({ tableName, k, count: finalRows.length, maxDistance }, "Поиск LanceDB завершён");
  return finalRows.map((r, i) => ({
    index: i + 1,
    id: r.id,
    title: r.title || r.snippet?.title || "(без названия)",
    url: r.url || (r.id ? `https://youtu.be/${r.id}` : ""),
    score: r._distance ?? r.score ?? r.distance ?? undefined,
  }));
}

module.exports = { connectDb, createTestTable, openLatestTestTable, findLatestTestTableName, searchTopK };