require("dotenv").config();
const { env } = require("../config/env");
const { logger } = require("../config/logger");
const { openChannelTableIfExists } = require("../services/vector/lancedb");
const { getActiveChannelId } = require("../services/admin/server_settings_store");

function parseFlags() {
  const args = process.argv.slice(2);
  const input = args.find(a => a && !a.startsWith("-")) || null;
  const showAll = args.includes("--show-all");
  return { input, showAll };
}

function describeInvalid(vec, minDims = Number(env.EMBEDDINGS_MIN_DIMS || 256)) {
  const reasons = [];
  if (vec == null) reasons.push("vector null");
  else {
    const isArrLike = Array.isArray(vec) || ArrayBuffer.isView(vec);
    if (!isArrLike) reasons.push("vector not array-like");
    else {
      const dims = Number(vec.length || 0);
      if (!Number.isFinite(dims)) reasons.push("length not finite");
      if (dims < minDims) reasons.push(`vector dims ${dims} < ${minDims}`);
      for (let i = 0; i < dims; i++) {
        const v = Number(vec[i]);
        if (!Number.isFinite(v)) { reasons.push("vector contains non-finite"); break; }
      }
    }
  }
  return reasons;
}

async function main() {
  const { input, showAll } = parseFlags();
  const channelId = input || await getActiveChannelId();
  if (!channelId) {
    console.error("Активный канал не задан. Передайте аргумент или установите через админку.");
    process.exit(1);
  }

  const { table, tableName } = await openChannelTableIfExists(channelId);
  if (!table) {
    console.log(`Таблица недоступна: ${tableName}`);
    process.exit(0);
  }

  const selectFields = ["id", "title", "url", "vector", "invalid_vector", "published_at"]; 
  let qb = typeof table.query === 'function' ? table.query() : table.search([]);
  let rows;
  try {
    const q = typeof qb.select === 'function' ? qb.select(selectFields) : qb;
    rows = typeof q.toArray === 'function' ? await q.toArray() : await q.execute();
  } catch (e) {
    logger.warn({ err: e?.message }, "Не удалось выполнить запрос; продолжаю без select()");
    rows = [];
  }

  const minDims = Number(env.EMBEDDINGS_MIN_DIMS || 256);
  const invalid = [];
  for (const r of (rows || [])) {
    const vec = r?.vector;
    const reasons = describeInvalid(vec, minDims);
    if ((reasons.length > 0) || r?.invalid_vector === true) {
      const dims = (Array.isArray(vec) || ArrayBuffer.isView(vec)) ? Number(vec.length || 0) : 0;
      invalid.push({ id: r.id, title: r.title, url: r.url, dims, reasons });
    }
  }

  console.log(`Таблица: ${tableName}`);
  console.log(`Невалидные: ${invalid.length}`);
  const list = showAll ? invalid : invalid.slice(0, 50);
  for (const it of list) {
    console.log(`${it.id} | dims=${it.dims} | reasons=${it.reasons.join(', ')}`);
    if (it.url) console.log(it.url);
  }
}

main().catch((err) => {
  console.error("invalid_embeds: ERROR", err?.message || err);
  process.exit(1);
});