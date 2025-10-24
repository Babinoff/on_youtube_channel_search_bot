const lancedb = require("@lancedb/lancedb");
const fs = require("fs");
const path = require("path");
const { env } = require("../../config/env");
const { logger } = require("../../config/logger");
const { embedTexts, getProviderDistanceMax } = require("../embeddings");
const { applyAdaptiveFilter } = require("./adaptive_filter");
const { isLocked, waitForUnlock } = require("../concurrency/lock");
const { readLockInfo } = require("../concurrency/lock");
const { normalizeQueryText } = require("../text/query_normalize");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function averageVectors(vectors) {
  const arr = (vectors || []).filter((v) => Array.isArray(v));
  if (arr.length === 0) return undefined;
  const len = arr[0].length;
  const sum = new Array(len).fill(0);
  for (const v of arr) {
    if (!Array.isArray(v) || v.length !== len) continue;
    for (let i = 0; i < len; i++) sum[i] += v[i] || 0;
  }
  for (let i = 0; i < len; i++) sum[i] /= arr.length;
  return sum;
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
  const provider = env.EMBEDDINGS_PROVIDER || 'default';
  return `video_embeddings_${provider}_${channelId}`;
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

  const raw = String(query || '');
  const useNorm = env.SEARCH_NORMALIZE_QUERY;
  const norm = useNorm ? normalizeQueryText(raw) : raw;
  const qVecs = await embedTexts(useNorm ? [raw, norm] : [raw]);
  const qVec = useNorm ? averageVectors(qVecs) : qVecs[0];
  if (!qVec || !Array.isArray(qVec)) {
    throw new Error("Не удалось получить эмбеддинг запроса");
  }

  // Предпочитаем таблицу выбранного канала; если отсутствует — сообщаем об ошибке
  let table;
  let tableName;
  // Тестовый хук: использовать мок-таблицу, если передана через opts
  if (opts && opts.mockTable) {
    table = opts.mockTable;
    tableName = opts.mockTableName || 'video_embeddings_mock';
    logger.info({ tableName }, "Поиск: использую мок-таблицу (тест)");
  } else {
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
  const preLimitEnv = Number(env.SEARCH_PRELIMIT || 0);
  const preLimitFactor = Number(env.SEARCH_PRELIMIT_FACTOR || 4);
  const basePreLimit = Math.max(k, Number(env.SEARCH_MAX_K || 20));
  const preLimit = preLimitEnv > 0 ? preLimitEnv : Math.max(basePreLimit, basePreLimit * preLimitFactor);
  let res;
  if (typeof qb.toArray === 'function') {
    res = await qb.limit(preLimit).toArray();
  } else {
    res = await qb.limit(preLimit).execute();
  }

  const rows = Array.isArray(res)
    ? res
    : (typeof res?.toArray === "function" ? res.toArray() : []);

  // Адаптивная пороговая фильтрация: distance vs similarity
  const maxDistance = typeof opts.maxDistance === 'number' ? opts.maxDistance : env.SEARCH_MAX_DISTANCE;
  const finalRows = applyAdaptiveFilter(rows, k, { maxDistance, typeFilter, tableName });

  // Вычислить тип метрики и итоговый адаптивный порог (по фактическим результатам)
  const providerMax = getProviderDistanceMax();
  const hasDistanceKey = finalRows.some(r => typeof r._distance === 'number' || typeof r.distance === 'number');
  const isSimilarityScore = !hasDistanceKey && finalRows.some(r => typeof r.score === 'number');

  let finalThreshold = null;
  if (hasDistanceKey) {
    const distances = finalRows
      .map(r => (typeof r._distance === 'number' ? r._distance : r.distance))
      .filter(v => typeof v === 'number');
    finalThreshold = distances.length ? Math.max(...distances) : null;
  } else if (isSimilarityScore) {
    const scores = finalRows.map(r => r.score).filter(v => typeof v === 'number');
    finalThreshold = scores.length ? (1 - Math.min(...scores)) : null;
  }
  const metricType = hasDistanceKey ? 'distance' : (isSimilarityScore ? 'similarity' : 'unknown');

  // Гибридный буст: реранкинг по точным токенам запроса в title/description
  const useHybrid = String(env.SEARCH_HYBRID_ENABLE || 'true');
  let selectedRows = finalRows;

  if (useHybrid) {
    const tokensWantedArr = (normalizeQueryText(norm || raw) || '')
      .split(' ')
      .filter((t) => t && t.length >= 3 && t !== 'the');
    const tokensWanted = new Set(tokensWantedArr);

    // Отфильтровать весь список кандидатов по финальному порогу
    const typeFilteredAll = typeFilter ? rows.filter(r => (r.type || 'video') === typeFilter) : rows;
    let thr = typeof finalThreshold === 'number' ? finalThreshold : (typeof maxDistance === 'number' ? maxDistance : Number(env.SEARCH_MAX_DISTANCE || 0.7));

    let eligible = typeFilteredAll;
    if (metricType === 'distance') {
      eligible = typeFilteredAll.filter(r => {
        const d = typeof r._distance === 'number' ? r._distance : r.distance;
        return typeof d === 'number' ? d <= thr : true;
      });
    } else if (metricType === 'similarity') {
      const minScore = Math.max(0, Math.min(1, 1 - thr));
      eligible = typeFilteredAll.filter(r => {
        const s = r.score;
        return typeof s === 'number' ? s >= minScore : true;
      });
    }

    const titleWeight = Number(env.SEARCH_HYBRID_TITLE_WEIGHT || 3);
    const descWeight = Number(env.SEARCH_HYBRID_DESC_WEIGHT || 1);
    const boostFactor = Number(env.SEARCH_HYBRID_FACTOR || 0.5);
    const recencyEnabled = String(env.SEARCH_RECENCY_ENABLE || 'true');
    const recencyHalfLifeDays = Number(env.SEARCH_RECENCY_HALF_LIFE_DAYS || 60);
    const recencyFactor = Number(env.SEARCH_RECENCY_FACTOR || 0.2);
    const distancePenaltyFactor = Number(env.SEARCH_DISTANCE_PENALTY_FACTOR || 0.3);
    const providerMaxLocal = getProviderDistanceMax();

    function tokensFromText(text) {
      const s = normalizeQueryText(String(text || ''));
      if (!s) return new Set();
      return new Set(s.split(' ').filter(Boolean));
    }

    function recencyBoostFrom(publishedAt) {
      if (!recencyEnabled || recencyEnabled === 'false' || recencyEnabled === '0') return 0;
      const ts = publishedAt ? new Date(publishedAt).getTime() : 0;
      if (!ts || !Number.isFinite(ts)) return 0;
      const ageDays = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60 * 24));
      const decay = Math.exp(-ageDays / Math.max(1, recencyHalfLifeDays));
      return decay * Math.max(0, recencyFactor);
    }

    function distancePenaltyFrom(row) {
      const d = typeof row._distance === 'number' ? row._distance : row.distance;
      if (typeof d !== 'number' || !Number.isFinite(d)) return 0;
      const norm = Math.max(0, Math.min(1, d / Math.max(1, providerMaxLocal)));
      return norm * Math.max(0, distancePenaltyFactor);
    }

    const boosted = eligible.map((r, idx) => {
      const titleTokens = tokensFromText(r.title || r.snippet?.title || '');
      const descTokens = tokensFromText(r.description_indexed || r.snippet?.description || '');

      let hitsTitle = 0, hitsDesc = 0;
      for (const t of tokensWanted) {
        if (titleTokens.has(t)) hitsTitle++;
        if (descTokens.has(t)) hitsDesc++;
      }
      const boostRaw = hitsTitle * titleWeight + hitsDesc * descWeight;
      const boostTokens = Math.max(0, boostRaw) * Math.max(0, boostFactor);
      const recency = recencyBoostFrom(r.published_at || r.snippet?.publishedAt || null);
      const penalty = distancePenaltyFrom(r);
      const boost = boostTokens + recency - penalty;

      return { r, idx, boost };
    });

    // Добавить кандидатов с токенными совпадениями вне порога, чтобы не терять точные хиты
    const idsEligible = new Set(eligible.map(r => r.id));
    const extras = typeFilteredAll.filter(r => !idsEligible.has(r.id)).map((r, idx) => {
      const titleTokens = tokensFromText(r.title || r.snippet?.title || '');
      const descTokens = tokensFromText(r.description_indexed || r.snippet?.description || '');
      let hitsTitle = 0, hitsDesc = 0;
      for (const t of tokensWanted) {
        if (titleTokens.has(t)) hitsTitle++;
        if (descTokens.has(t)) hitsDesc++;
      }
      const hasHits = (hitsTitle + hitsDesc) > 0;
      if (!hasHits) return null;
      const boostRaw = hitsTitle * titleWeight + hitsDesc * descWeight;
      const boostTokens = Math.max(0, boostRaw) * Math.max(0, boostFactor);
      const recency = recencyBoostFrom(r.published_at || r.snippet?.publishedAt || null);
      const penalty = distancePenaltyFrom(r);
      const boost = boostTokens + recency - penalty;
      return { r, idx, boost };
    }).filter(Boolean);

    boosted.push(...extras);

    // Реранкинг: сначала буст, затем исходный порядок LanceDB, при равенстве — новизна
    boosted.sort((a, b) => {
      const bothNonPositive = (a.boost <= 0 && b.boost <= 0);
      if (!bothNonPositive && b.boost !== a.boost) return b.boost - a.boost;
      const at = new Date(a.r.published_at || a.r.snippet?.publishedAt || 0).getTime();
      const bt = new Date(b.r.published_at || b.r.snippet?.publishedAt || 0).getTime();
      if (bt !== at) return bt - at; // новее выше
      return a.idx - b.idx;
    });

    // Удалить дубликаты по id после объединения списков
    const seenIds = new Set();
    const uniq = [];
    for (const item of boosted) {
      const id = item?.r?.id;
      if (id && !seenIds.has(id)) { seenIds.add(id); uniq.push(item); }
    }

    selectedRows = uniq.slice(0, k).map(x => x.r);
  }

  logger.info({ tableName, k, count: selectedRows.length, maxDistance, typeFilter }, "Поиск LanceDB завершён (лимит + гибридный буст)");

  // Финальный лог адаптивного порога: итоговое значение, тип метрики, максимум провайдера
  logger.info({ tableName, count: selectedRows.length, finalThreshold, metricType, providerMax, hybrid: useHybrid }, 'Адаптивный поиск: итог');

  return selectedRows.map((r, i) => ({
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

module.exports = { connectDb, createTestTable, openLatestTestTable, findLatestTestTableName, searchTopK, applyAdaptiveFilter, getChannelTableName, openChannelTableIfExists, addDocsToChannelTable, createChannelTable }