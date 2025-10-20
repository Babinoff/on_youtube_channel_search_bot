const lancedb = require("@lancedb/lancedb");
const fs = require("fs");
const path = require("path");
const { env } = require("../../config/env");
const { logger } = require("../../config/logger");
const { embedTexts } = require("../embeddings");
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

// ===== Channel table helpers =====
function getChannelTableName(channelId) {
  return `video_embeddings_${channelId}`;
}

async function openChannelTableIfExists(channelId) {
  const db = await connectDb();
  const name = getChannelTableName(channelId);
  try {
    const table = await db.openTable(name);
    return { db, table, tableName: name };
  } catch (err) {
    // not exists
    return { db, table: null, tableName: name };
  }
}

async function createChannelTable(channelId, docs) {
  const db = await connectDb();
  const name = getChannelTableName(channelId);
  const table = await db.createTable(name, docs);
  return { db, table, tableName: name };
}

async function addDocsToChannelTable(channelId, docs) {
  const { db, table, tableName } = await openChannelTableIfExists(channelId);
  if (!table) {
    logger.info({ tableName }, "Создаю таблицу канала в LanceDB");
    const created = await createChannelTable(channelId, docs);
    return created;
  }
  await table.add(docs);
  logger.info({ tableName, inserted: docs.length }, "Добавлены документы в таблицу канала");
  return { db, table, tableName };
}

async function searchTopK(query, k = 5, opts = {}) {
  // Эмбеддинги: ошибки и недоступность провайдера будут отражены абстракцией

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

  // Предпочитаем таблицу выбранного канала; если отсутствует — сообщаем об ошибке
  let table;
  let tableName;
  const preferredChannelId = opts.channelId || env.YOUTUBE_CHANNEL_ID || null;
  if (preferredChannelId) {
    const opened = await openChannelTableIfExists(preferredChannelId);
    if (opened.table) {
      table = opened.table;
      tableName = opened.tableName;
      logger.info({ tableName, channelId: preferredChannelId }, "Поиск: использую таблицу канала");
    } else {
      tableName = opened.tableName;
      logger.warn({ tableName, channelId: preferredChannelId }, "Поиск: таблица канала отсутствует или недоступна");
      throw new Error(`Таблица недоступна: ${tableName}. Попросите администратора создать и проиндексировать канал.`);
    }
  } else {
    const openedTest = await openLatestTestTable();
    table = openedTest.table;
    tableName = openedTest.tableName;
    logger.info({ tableName }, "Поиск: использую тестовую таблицу (latest10)");
  }

  // Совместимость с разными версиями LanceDB: prefer vectorSearch() если доступен
  let qb = typeof table.vectorSearch === 'function' ? table.vectorSearch(qVec) : table.search(qVec);

  // Префильтр по типу до поиска
  const typeFilter = (opts.type === 'short' || opts.type === 'stream' || opts.type === 'video') ? opts.type : null;
  try {
    if (typeFilter && typeof qb.where === 'function') {
      qb = qb.where(`type = '${typeFilter}'`);
    } else if (typeFilter && typeof qb.filter === 'function') {
      // Для старых API: использовать filter() + prefilter(true) если доступно
      qb = qb.filter(`type = '${typeFilter}'`);
      if (typeof qb.prefilter === 'function') qb = qb.prefilter(true);
    }
  } catch (e) {
    logger.warn({ err: e?.message, typeFilter }, "Не удалось применить префильтр по типу; продолжу без него");
  }

  // Берём больше кандидатов, лимитируем в конце
  const preLimit = Math.max(k, Number(env.SEARCH_MAX_K || 20));
  let res;
  if (typeof qb.toArray === 'function') {
    res = await qb.limit(preLimit).toArray();
  } else {
    res = await qb.limit(preLimit).execute();
  }

  const rows = Array.isArray(res)
    ? res
    : (typeof res?.toArray === "function" ? res.toArray() : []);

  // Пороговая фильтрация по дистанции (score)
  const maxDistance = typeof opts.maxDistance === 'number' ? opts.maxDistance : env.SEARCH_MAX_DISTANCE;
  const rowsTypeFiltered = typeFilter
    ? rows.filter((r) => (r.type || 'video') === typeFilter)
    : rows;
  const rowsDistanceFiltered = rowsTypeFiltered.filter((r) => {
    const d = r._distance ?? r.distance ?? r.score;
    return typeof d === 'number' ? d <= maxDistance : true;
  });

  const finalRows = rowsDistanceFiltered.slice(0, k);

  logger.info({ tableName, k, count: finalRows.length, maxDistance, typeFilter }, "Поиск LanceDB завершён (лимит применён в конце)");
  return finalRows.map((r, i) => ({
    index: i + 1,
    id: r.id,
    title: r.title || r.snippet?.title || "(без названия)",
    url: r.url || (r.id ? `https://youtu.be/${r.id}` : ""),
    score: r._distance ?? r.score ?? r.distance ?? undefined,
    description_indexed: r.description_indexed || "",
    published_at: r.published_at || r.snippet?.publishedAt || null,
    type: r.type || null,
  }));
}

module.exports = { connectDb, createTestTable, openLatestTestTable, findLatestTestTableName, searchTopK, getChannelTableName, openChannelTableIfExists, addDocsToChannelTable, createChannelTable }