require('dotenv').config();
const { logger } = require('../config/logger');
const { env } = require('../config/env');

// Optional provider overrides via CLI before loading embeddings service
(function applyProviderOverrides() {
  const argv = process.argv;
  const iProvider = argv.findIndex(a => a === '--provider');
  const iChain = argv.findIndex(a => a === '--chain');
  if (iProvider >= 0) {
    const v = argv[iProvider + 1];
    if (v && !v.startsWith('--')) process.env.EMBEDDINGS_PROVIDER = v;
  }
  if (iChain >= 0) {
    const v = argv[iChain + 1];
    if (v && !v.startsWith('--')) process.env.EMBEDDINGS_PROVIDER_CHAIN = v;
  }
})();

const { embedTexts } = require('../services/embeddings');
const { openChannelTableIfExists } = require('../services/vector/lancedb');

function parseBooleanArg(flag, defaultVal = false) {
  const idx = process.argv.findIndex(a => a === flag);
  if (idx < 0) return defaultVal;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith('--')) return true;
  const v = String(next).toLowerCase();
  if (['1','true','yes','on'].includes(v)) return true;
  if (['0','false','no','off'].includes(v)) return false;
  return true;
}

function parseNumberArg(flag, defaultVal) {
  const idx = process.argv.findIndex(a => a === flag);
  if (idx < 0) return defaultVal;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) && v > 0 ? v : defaultVal;
}

function isVectorInvalid(vec, minDims) {
  const md = Number(minDims || env.EMBEDDINGS_MIN_DIMS || 256);
  if (vec == null) return true;
  if (!Array.isArray(vec)) return true;
  if (vec.length < md) return true;
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) return true;
  }
  return false;
}

function isValidVector(vec) {
  return !isVectorInvalid(vec, env.EMBEDDINGS_MIN_DIMS);
}

async function readInvalidRows(table) {
  // Prefer schema with invalid_vector; fallback if field missing
  let rows = [];
  try {
    const q = table.query().select(['id','title','description_indexed','vector','invalid_vector','url','published_at']);
    rows = typeof q.toArray === 'function' ? await q.toArray() : await q.limit(100000000).execute();
  } catch (e) {
    const msg = String(e?.message || '');
    if (msg.includes('No field named invalid_vector')) {
      logger.warn({ err: e?.message }, 'Схема без invalid_vector, повторяю запрос без поля');
      const q2 = table.query().select(['id','title','description_indexed','vector','url','published_at']);
      rows = typeof q2.toArray === 'function' ? await q2.toArray() : await q2.limit(100000000).execute();
    } else {
      throw e;
    }
  }

  const invalid = [];
  const minDims = Number(env.EMBEDDINGS_MIN_DIMS || 256);
  for (const r of rows) {
    const mark = r.invalid_vector === true;
    const inv = isVectorInvalid(r.vector, minDims);
    if (mark || inv) {
      invalid.push({ id: r.id, title: r.title, description_indexed: r.description_indexed || '', url: r.url, published_at: r.published_at, invalid_vector: r.invalid_vector === true });
    }
  }
  return invalid;
}

async function safeUpdateOrReplace(table, doc) {
  // Try update first; fallback to delete+add; finally add
  const id = doc.id;
  if (!id) return false;
  try {
    if (typeof table.update === 'function') {
      // Update doc fields by predicate
      await table.update({
        title: doc.title,
        description_indexed: doc.description_indexed,
        vector: doc.vector ?? null,
        invalid_vector: doc.invalid_vector ?? null,
        url: doc.url,
        published_at: doc.published_at,
      }, `id = '${id}'`);
      return true;
    }
  } catch (e) {
    logger.warn({ id, err: e?.message }, 'Не удалось обновить запись; попробую удалить и вставить');
  }

  try {
    if (typeof table.delete === 'function') {
      await table.delete(`id = '${id}'`);
    }
  } catch (e) {
    logger.warn({ id, err: e?.message }, 'Не удалось удалить запись; продолжу вставку');
  }

  try {
    if (typeof table.add === 'function') {
      await table.add([doc]);
      return true;
    }
  } catch (e) {
    logger.error({ id, err: e?.message }, 'Не удалось вставить запись');
    return false;
  }
  return false;
}

async function main() {
  const argv = process.argv.slice(2);
  const inputArg = argv.find(a => a && !a.startsWith('--'));
  const channelId = inputArg || env.YOUTUBE_CHANNEL_ID || null;
  const dryRun = parseBooleanArg('--dry-run', false);
  const limit = parseNumberArg('--limit', 100);
  const onInvalid = (function(){
    const i = argv.findIndex(a => a === '--on-invalid');
    const v = i >= 0 ? argv[i + 1] : 'mark';
    return (v && !v.startsWith('--')) ? String(v).toLowerCase() : 'mark';
  })();

  if (!channelId) {
    logger.error('Укажите channelId аргументом или через .env (YOUTUBE_CHANNEL_ID)');
    process.exit(1);
  }

  const { table, tableName } = await openChannelTableIfExists(channelId);
  if (!table) {
    logger.error({ tableName }, 'Таблица канала отсутствует');
    process.exit(1);
  }

  logger.info({ tableName, channelId }, 'Ищу записи с пустыми/невалидными эмбеддингами');
  const invalidRows = await readInvalidRows(table);
  if (!invalidRows.length) {
    console.log(JSON.stringify({ tableName, channelId, reindexable: 0 }, null, 2));
    return;
  }

  const todo = invalidRows.slice(0, limit);
  logger.info({ tableName, count: todo.length }, 'Подготовка текстов для переиндексации');
  const texts = todo.map(d => `${d.title || ''}\n\n${d.description_indexed || ''}`);

  if (dryRun) {
    console.log(JSON.stringify({ tableName, channelId, reindexable: invalidRows.length, willProcess: todo.length, sample: todo.slice(0, Math.min(10, todo.length)).map(d => ({ id: d.id, title: d.title })) }, null, 2));
    return;
  }

  const vectors = await embedTexts(texts);
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error('Провайдер вернул неподходящий результат');
  }

  let success = 0;
  const minDims = Number(env.EMBEDDINGS_MIN_DIMS || 256);
  for (let i = 0; i < todo.length; i++) {
    const base = todo[i];
    const vec = vectors[i];
    const valid = !isVectorInvalid(vec, minDims);
    let doc;
    if (!valid) {
      if (onInvalid === 'skip') {
        logger.warn({ id: base.id }, 'Пропускаю: вектор снова невалиден');
        continue;
      }
      doc = { ...base, vector: null, invalid_vector: true };
    } else {
      doc = { ...base, vector: vec, invalid_vector: false };
    }

    const ok = await safeUpdateOrReplace(table, doc);
    if (ok) success++;
  }

  console.log(JSON.stringify({ tableName, channelId, processed: todo.length, updated: success }, null, 2));
}

main().catch(err => {
  logger.error({ err: err?.response?.data || err?.message || err }, 'Ошибка reindex_zero_vectors');
  console.error('reindex_zero_vectors: ERROR', err?.response?.data || err?.message || err);
  process.exit(1);
});