const lancedb = require("@lancedb/lancedb");
const fs = require("fs");
const path = require("path");
const { env } = require("../../config/env");
const { logger } = require("../../config/logger");
const { embedTexts } = require("../embeddings/mistral");

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

async function searchTopK(query, k = 5) {
  if (!env.MISTRAL_API_KEY) {
    throw new Error("MISTRAL_API_KEY отсутствует. Заполните .env");
  }
  const [qVec] = await embedTexts([query]);
  if (!qVec || !Array.isArray(qVec)) {
    throw new Error("Не удалось получить эмбеддинг запроса");
  }
  const { tableName, table } = await openLatestTestTable();
  const res = await table.search(qVec).limit(k).execute();
  const rows = Array.isArray(res)
    ? res
    : (typeof res?.toArray === "function" ? res.toArray() : []);
  logger.info({ tableName, k, count: rows.length }, "Поиск LanceDB завершён");
  return rows.map((r, i) => ({
    index: i + 1,
    id: r.id,
    title: r.title || r.snippet?.title || "(без названия)",
    url: r.url || (r.id ? `https://youtu.be/${r.id}` : ""),
    score: r._distance ?? r.score ?? r.distance ?? undefined,
  }));
}

module.exports = { connectDb, createTestTable, openLatestTestTable, findLatestTestTableName, searchTopK };