require('dotenv').config();
const { env } = require('../config/env');
const { logger } = require('../config/logger');
const { openChannelTableIfExists } = require('../services/vector/lancedb');
const { getActiveChannelId } = require("../services/admin/server_settings_store");

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

function isVectorInvalid(vec, minDims = Number(env.EMBEDDINGS_MIN_DIMS || 256)) {
  if (vec == null) return true;
  if (!Array.isArray(vec)) return true;
  if (vec.length < minDims) return true;
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) return true;
  }
  return false;
}

async function main() {
  const inputArg = process.argv[2];
  const channelId = inputArg || await getActiveChannelId();
  if (!channelId) {
    logger.error('Укажите channelId аргументом или установите активный канал в settings.json');
    process.exit(1);
  }
  const showAll = parseBooleanArg('--show-all', false);

  const { table, tableName } = await openChannelTableIfExists(channelId);
  if (!table) {
    logger.error({ tableName }, 'Таблица канала отсутствует');
    process.exit(1);
  }
  logger.info({ tableName, channelId }, 'Сканирую таблицу для поиска невалидных векторов');

  // Выбираем только нужные поля для анализа
  let rows = [];
  try {
    const q = table.query().select(['id','title','vector','invalid_vector','published_at','url']);
    if (typeof q.toArray === 'function') {
      rows = await q.toArray();
    } else {
      rows = await q.limit(100000000).execute();
    }
  } catch (e) {
    const msg = String(e?.message || '');
    const schemaErr = msg.includes('No field named invalid_vector');
    if (schemaErr) {
      logger.warn({ err: e?.message }, 'Схема без invalid_vector, повторяю запрос без этого поля');
      try {
        const q2 = table.query().select(['id','title','vector','published_at','url']);
        rows = typeof q2.toArray === 'function' ? await q2.toArray() : await q2.limit(100000000).execute();
      } catch (e2) {
        logger.error({ err: e2?.message }, 'Ошибка чтения таблицы');
        process.exit(1);
      }
    } else {
      logger.error({ err: e?.message }, 'Ошибка чтения таблицы');
      process.exit(1);
    }
  }

  const issues = [];
  const minDims = Number(env.EMBEDDINGS_MIN_DIMS || 256);
  for (const r of rows) {
    const reason = [];
    if (r.invalid_vector === true) reason.push('invalid_vector flag');
    const v = r.vector;
    if (v == null) reason.push('vector null');
    else if (!Array.isArray(v)) reason.push('vector not array');
    else if (v.length < minDims) reason.push(`vector dims ${v.length} < ${minDims}`);
    else if (!v.every(Number.isFinite)) reason.push('vector contains non-finite');
    if (reason.length > 0) {
      issues.push({ id: r.id, title: r.title, url: r.url || `https://youtu.be/${r.id}`, published_at: r.published_at || null, reason });
    }
  }

  const total = rows.length;
  const invalidCount = issues.length;
  logger.info({ tableName, channelId, total, invalidCount }, 'Анализ завершён');

  const out = showAll ? issues : issues.slice(0, 20);
  console.log(JSON.stringify({ tableName, channelId, total, invalidCount, sample: out }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});