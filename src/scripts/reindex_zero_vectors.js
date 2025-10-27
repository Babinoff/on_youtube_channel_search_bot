require("dotenv").config();
const { env } = require("../config/env");
const { logger } = require("../config/logger");
const { getActiveChannelId } = require("../services/admin/server_settings_store");
const { openChannelTableIfExists, safeUpdateOrReplace } = require("../services/vector/lancedb");
const { embedTexts } = require("../services/embeddings");

function parseArgs() {
  const args = process.argv.slice(2);
  const used = new Set();
  const getVal = (name) => {
    const idx = args.indexOf(name);
    if (idx >= 0 && idx + 1 < args.length) { used.add(idx); used.add(idx + 1); return args[idx + 1]; }
    return null;
  };
  const limitVal = getVal("--limit");
  const limit = limitVal != null ? Number(limitVal) : 100;
  const dryRun = args.includes("--dry-run");
  const onInvalidVal = getVal("--on-invalid");
  const onInvalid = onInvalidVal ? String(onInvalidVal) : 'mark';
  const provider = getVal("--provider") || null;
  const chain = getVal("--chain") || null;
  // Input is the first non-flag argument not consumed as a flag value
  let input = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a || a.startsWith("-")) continue;
    if (used.has(i)) continue;
    input = a;
    break;
  }
  return { input, limit, dryRun, onInvalid, provider, chain };
}

function isValidVector(vec, minDims = Number(env.EMBEDDINGS_MIN_DIMS || 256)) {
  if (vec == null) return false;
  const isArrLike = Array.isArray(vec) || ArrayBuffer.isView(vec);
  if (!isArrLike) return false;
  const dims = Number(vec.length || 0);
  if (!Number.isFinite(dims) || dims < minDims) return false;
  for (let i = 0; i < dims; i++) {
    const v = Number(vec[i]);
    if (!Number.isFinite(v)) return false;
  }
  return true;
}

async function main() {
  const { input, limit, dryRun, onInvalid, provider, chain } = parseArgs();
  if (provider) process.env.EMBEDDINGS_PROVIDER = provider;
  if (chain) process.env.EMBEDDINGS_PROVIDER_CHAIN = chain;
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

  const selectFields = ["id", "title", "description_indexed", "vector", "invalid_vector"]; 
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
  const candidates = [];
  for (const r of (rows || [])) {
    const v = r?.vector;
    const isInvalidFlag = r?.invalid_vector === true;
    const notArr = !(Array.isArray(v) || ArrayBuffer.isView(v));
    const nullVec = v == null;
    const dims = Number(v?.length || 0);
    const badDims = !Number.isFinite(dims) || dims < minDims;
    let badVals = false;
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      for (let i = 0; i < v.length; i++) {
        if (!Number.isFinite(Number(v[i]))) { badVals = true; break; }
      }
    }
    if (isInvalidFlag || nullVec || notArr || badDims || badVals) {
      candidates.push(r);
      if (candidates.length >= limit) break;
    }
  }

  if (!candidates.length) {
    console.log("Нет кандидатов для реиндексации.");
    process.exit(0);
  }

  const texts = candidates.map(d => `${d.title || ''}\n\n${d.description_indexed || ''}`);
  const vectors = await embedTexts(texts);

  const outDocs = [];
  for (let i = 0; i < candidates.length; i++) {
    const vec = vectors[i];
    const ok = isValidVector(vec, minDims);
    if (!ok) {
      if (onInvalid === 'skip') continue;
      outDocs.push({ id: candidates[i].id, vector: null, invalid_vector: true });
    } else {
      outDocs.push({ id: candidates[i].id, vector: vec, invalid_vector: false, last_indexed_at: new Date().toISOString() });
    }
  }

  if (dryRun) {
    console.log(`DRY-RUN: обновление не выполняется. Кандидатов: ${candidates.length}, подготовлено: ${outDocs.length}`);
    process.exit(0);
  }

  if (!outDocs.length) {
    console.log("Нечего обновлять.");
    process.exit(0);
  }

  await safeUpdateOrReplace(channelId, outDocs);
  console.log(`Обновлено/вставлено: ${outDocs.length} | таблица: ${tableName}`);
}

main().catch((err) => {
  console.error("reindex_zero: ERROR", err?.message || err);
  process.exit(1);
});