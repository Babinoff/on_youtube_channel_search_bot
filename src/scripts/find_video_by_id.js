require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { env } = require("../config/env");
const { connectDb } = require("../services/vector/lancedb");

function getDbDir() {
  return env.LANCEDB_DIR || "./data/lancedb";
}

function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();
  // youtu.be/<id>
  const short = s.match(/youtu\.be\/(\w[\w-]{5,})/i);
  if (short && short[1]) return short[1];
  // youtube.com/watch?v=<id>
  const watch = s.match(/[?&]v=([\w-]{6,})/i);
  if (watch && watch[1]) return watch[1];
  // plain id
  const plain = s.match(/^[\w-]{6,}$/);
  if (plain) return s;
  return null;
}

function listChannelTables() {
  const dir = getDbDir();
  try {
    return fs.readdirSync(dir).filter((e) => {
      const full = path.join(dir, e);
      try {
        return fs.statSync(full).isDirectory() && e.startsWith("video_embeddings_");
      } catch {
        return false;
      }
    }).sort();
  } catch (err) {
    console.error("Ошибка чтения каталога LanceDB:", err.message);
    process.exit(1);
  }
}

async function queryById(table, id) {
  const selectCols = [
    "id",
    "title",
    "url",
    "description_indexed",
    "channel_id",
    "published_at",
    "type",
    "etag",
    "last_indexed_at",
    "vector",
  ];

  // Prefer server-side filter; fallback to client-side if not supported
  try {
    let qb = table.query();
    if (typeof qb.where === 'function') qb = qb.where(`id = '${id}'`);
    qb = qb.select(selectCols);
    const rows = await qb.toArray();
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    try {
      const qb = table.query().select(selectCols);
      const rows = await qb.toArray();
      return (Array.isArray(rows) ? rows : []).filter((r) => r.id === id);
    } catch (e2) {
      throw e2;
    }
  }
}

function formatRow(row) {
  const vec = Array.isArray(row.vector) ? row.vector : null;
  const vecLen = vec ? vec.length : 0;
  const vecHead = vec ? vec.slice(0, 8) : [];
  return {
    id: row.id,
    title: row.title || null,
    url: row.url || (row.id ? `https://youtu.be/${row.id}` : null),
    description_indexed: row.description_indexed || null,
    channel_id: row.channel_id || null,
    published_at: row.published_at || null,
    type: row.type || null,
    etag: row.etag || null,
    last_indexed_at: row.last_indexed_at || null,
    vector_dims: vecLen,
    vector_head: vecHead,
  };
}

async function main() {
  const input = process.argv[2];
  const channelFilter = process.argv[3] || null; // optional: restrict to specific channelId
  const id = extractVideoId(input);
  if (!id) {
    console.error("Укажите videoId или YouTube URL (например: https://youtu.be/y57rJbIso5E)");
    process.exit(1);
  }

  const db = await connectDb();
  const tables = listChannelTables();
  let found = [];

  for (const name of tables) {
    if (channelFilter && !name.endsWith(`_${channelFilter}`)) continue;
    try {
      const openName = name.replace(/\.lance$/, "");
      const table = await db.openTable(openName);
      const rows = await queryById(table, id);
      if (rows.length) {
        found.push({ table: name, rows: rows.map(formatRow) });
      }
    } catch (e) {
      // skip broken table
      console.warn(`Предупреждение: не удалось открыть ${name}: ${e?.message}`);
    }
  }

  if (!found.length) {
    console.log(JSON.stringify({ videoId: id, matches: 0, results: [] }, null, 2));
    return;
  }

  console.log(JSON.stringify({ videoId: id, matches: found.reduce((n, f) => n + f.rows.length, 0), results: found }, null, 2));
}

main().catch((err) => {
  console.error("Ошибка поиска видео в LanceDB:", err?.message || err);
  process.exit(1);
});