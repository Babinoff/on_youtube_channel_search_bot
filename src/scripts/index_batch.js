require("dotenv").config();
const { logger } = require("../config/logger");
const { env } = require("../config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("../services/youtube/client");
const { normalizeDescription } = require("../services/text/normalize");
const { toVideoEntity } = require("../services/youtube/video");
const { acquireLock, releaseLock, updateLockMeta } = require("../services/concurrency/lock");
const { embedTexts, resolveProviderChain } = require("../services/embeddings");
const { openChannelTableIfExists, addDocsToChannelTable } = require("../services/vector/lancedb");
// NEW: admin notifier for progress updates
const { canNotify, notifyAdminProgress } = require("../services/admin/notifier");
// deduped duplicate imports








function parseLimitArg(defaultLimit = 100) {
  const i = process.argv.findIndex(a => a === "--limit");
  if (i >= 0) {
    const v = Number(process.argv[i + 1]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return defaultLimit;
}

// New: parse boolean flag from CLI, with default value
function parseBooleanArg(flag, defaultVal = false) {
  const idx = process.argv.findIndex(a => a === flag);
  if (idx < 0) return defaultVal;
  const next = process.argv[idx + 1];
  if (!next || next.startsWith("--")) return true;
  const v = String(next).toLowerCase();
  if (["1","true","yes","on"].includes(v)) return true;
  if (["0","false","no","off"].includes(v)) return false;
  return true;
}

// NEW: parse number flag from CLI
function parseNumberArg(flag, defaultVal) {
  const idx = process.argv.findIndex(a => a === flag);
  if (idx < 0) return defaultVal;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) && v > 0 ? v : defaultVal;
}

// Updated: support early stop at first known videoId
async function collectVideoIds(uploadsId, client, limit, options = {}) {
  const { existingSet = new Set(), stopOnFirstKnown = false } = options;
  let token = undefined;
  const out = [];
  let stoppedEarly = false;
  while (out.length < limit) {
    const page = await listUploadsVideos(uploadsId, client, token);
    const items = page.items || [];
    for (const it of items) {
      const vid = it?.contentDetails?.videoId;
      if (!vid) continue;
      if (stopOnFirstKnown && existingSet.has(vid)) {
        stoppedEarly = true;
        break;
      }
      out.push(vid);
      if (out.length >= limit) break;
    }
    token = page.nextPageToken;
    if (stoppedEarly || !token || items.length === 0) break;
  }
  return { ids: out, stoppedEarly };
}

async function main() {
  let lockAcquired = false;
  try {
    const limit = parseLimitArg(100);
    // NEW: progress flags and timers
    const progressEnabled = parseBooleanArg("--progress", canNotify());
    const progressEvery = parseNumberArg("--progress-every", Number(env.INDEX_PROGRESS_EVERY) || 100);
    const tStart = Date.now();

    if (!env.YOUTUBE_API_KEY) {
      logger.error("YOUTUBE_API_KEY отсутствует. Заполните .env и повторите.");
      process.exit(1);
    }
    

    // Отныне аргумент из CLI имеет приоритет над .env
    const inputArg = process.argv[2];
    const inputEnv = env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_CHANNEL_ID;
    const useArg = Boolean(inputArg);
    const input = useArg ? inputArg : inputEnv;
    if (!input) {
      logger.info("Укажите канал через аргумент или .env (YOUTUBE_CHANNEL_ID): npm run index:batch -- <channelId|url|@handle> --limit 100");
      process.exit(1);
    }

    // New: allow controlling incremental stop via CLI flag (overrides env)
    const stopOnFirstKnown = parseBooleanArg("--stop-on-first-known", env.INDEX_STOP_ON_FIRST_KNOWN);

    lockAcquired = await acquireLock('indexing', { script: 'index_batch.js', input, limit, stopOnFirstKnown });
    if (!lockAcquired) {
      logger.warn("Индексация уже выполняется в другом процессе. Повторите позже.");
      process.exit(0);
    }

    await updateLockMeta('indexing', { stage: 'resolve_channel', input });
    const client = createYouTubeClient(env.YOUTUBE_API_KEY);
    const channelId = useArg ? await resolveChannelId(inputArg, client) : inputEnv;

    // NEW: helper to notify admin with bound channelId
    const notify = (meta) => {
      if (!progressEnabled) return Promise.resolve();
      return notifyAdminProgress({ ...meta, channelId, limit }).catch(() => {});
    };

    // Read existing IDs once, before paginating, to enable early stop
    await updateLockMeta('indexing', { stage: 'read_existing', channelId });
    const { table } = await openChannelTableIfExists(channelId);
    let existing = new Set();
    if (table) {
      try {
        // Use LanceDB Query API to fetch only `id` column
        const qb = table.query().select(["id"]);
        const rows = typeof qb.toArray === 'function'
          ? await qb.toArray()
          : await qb.limit(100000000).toArray();
        rows.forEach(r => { if (r.id) existing.add(r.id); });
        logger.info({ existingCount: existing.size }, "Существующие записи в таблице канала загружены");
      } catch (e) {
        logger.warn({ err: e?.message }, "Не удалось прочитать существующую таблицу канала, продолжаю без дедупа");
      }
    }

    await updateLockMeta('indexing', { stage: 'list_uploads', channelId });
    logger.info({ channelId, limit, stopOnFirstKnown }, "Канал определён, начинаю сбор videoId");

    const uploadsId = await getUploadsPlaylistId(channelId, client);
    const { ids: toProcessIds, stoppedEarly } = await collectVideoIds(uploadsId, client, limit, { existingSet: existing, stopOnFirstKnown });
    await updateLockMeta('indexing', { stage: 'collect_ids', total: toProcessIds.length, current: 0, stopped_early: stoppedEarly });
    // NEW: notify admin about collected IDs
    notify({ stage: 'collect_ids', total: toProcessIds.length, current: 0, stoppedEarly });
    if (stoppedEarly) {
      logger.info("Пагинация остановлена на первом известном videoId (инкрементальный режим)");
    }
    logger.info({ count: toProcessIds.length }, "Собраны видео для батч‑индексации");

    // Dedup: skip IDs already in the channel table
    const newIds = toProcessIds.filter(id => !existing.has(id));
    if (!newIds.length) {
      await updateLockMeta('indexing', { stage: 'done', total: 0, current: 0 });
      logger.info("Все выбранные видео уже проиндексированы. Нечего добавлять.");
      // NEW: notify admin finish when nothing to add
      notify({ stage: 'done', total: 0, current: 0, inserted: 0 });
      return;
    }

    await updateLockMeta('indexing', { stage: 'fetch_details', total: newIds.length, current: 0 });
    const batches = [];
    for (let i = 0; i < newIds.length; i += 50) {
      batches.push(newIds.slice(i, i + 50));
    }
    const details = [];
    for (let i = 0; i < batches.length; i++) {
      const chunk = batches[i];
      const part = await getVideosDetails(chunk, client);
      details.push(...part);
      const cur = Math.min((i + 1) * 50, newIds.length);
      await updateLockMeta('indexing', { stage: 'fetch_details', current: cur });
      // NEW: notify progress on fetching details
      if ((cur % Math.max(progressEvery, 50) === 0) || cur === newIds.length) {
        notify({ stage: 'fetch_details', total: newIds.length, current: cur });
      }
    }

    await updateLockMeta('indexing', { stage: 'normalize', total: details.length });
    const docsMeta = details.map(v => {
      const base = toVideoEntity(v);
      const descriptionIndexed = normalizeDescription(base.description);
      const etag = v.etag || null;
      return {
        id: base.id,
        title: base.title,
        description_indexed: descriptionIndexed,
        url: base.url,
        channel_id: channelId,
        published_at: base.publishedAt,
        etag,
        type: base.type,
        last_indexed_at: new Date().toISOString(),
      };
    });

    await updateLockMeta('indexing', { stage: 'embedding', total: docsMeta.length, current: 0 });
    const vectors = await embedTexts(docsMeta.map(d => `${d.title}\n\n${d.description_indexed}`));
    await updateLockMeta('indexing', { stage: 'embedding', current: docsMeta.length });
    // Notify end of embedding
    await notify({ stage: 'embedding', total: docsMeta.length, current: docsMeta.length });

    function describeInvalidVector(vec, minDims = Number(env.EMBEDDINGS_MIN_DIMS || 256)) {
      const reasons = [];
      if (vec == null) reasons.push('vector null');
      else if (!Array.isArray(vec)) reasons.push('vector not array');
      else {
        const dims = vec.length;
        if (dims < minDims) reasons.push(`vector dims ${dims} < ${minDims}`);
        if (!vec.every(Number.isFinite)) reasons.push('vector contains non-finite');
      }
      return reasons;
    }

    function isValidVector(v) {
      const minDims = Number(env.EMBEDDINGS_MIN_DIMS || 256);
      return Array.isArray(v) && v.length >= minDims && v.every(Number.isFinite);
    }
    const strict = !!env.EMBEDDINGS_STRICT_VALIDATION;
    const onInvalid = String(env.EMBEDDINGS_ON_INVALID || 'mark'); // 'skip' | 'mark'
    const docs = [];
    const chain = resolveProviderChain();
    const activeProvider = chain[0] || '(unknown)';
    for (let i = 0; i < docsMeta.length; i++) {
      const vec = vectors[i];
      const valid = isValidVector(vec);
      if (strict && !valid) {
        const base = { ...docsMeta[i], invalid_vector: true };
        const dims = Array.isArray(vec) ? vec.length : 0;
        const minDims = Number(env.EMBEDDINGS_MIN_DIMS || 256);
        const reasons = describeInvalidVector(vec, minDims);
        if (onInvalid === 'skip') {
          logger.warn(
            { video_id: base.id, provider: activeProvider, dims, minDims, reasons },
            'Skipping document due to invalid embedding vector'
          );
          continue;
        } else {
          docs.push({ ...base, vector: null });
          logger.warn(
            { video_id: base.id, provider: activeProvider, dims, minDims, reasons },
            'Marking document invalid_vector=true and inserting with vector=null'
          );
        }
      } else {
        docs.push({ ...docsMeta[i], vector: vec });
      }
    }

    // Insert in smaller chunks with simple retry for stability
    const maxInsertAttempts = 3;
    let inserted = 0;
    // NEW: start timestamp for ETA
    const insertStart = Date.now();
    for (let i = 0; i < docs.length; i += 100) {
      const chunk = docs.slice(i, i + 100);
      let success = false;
      for (let attempt = 1; attempt <= maxInsertAttempts; attempt++) {
        try {
          await addDocsToChannelTable(channelId, chunk);
          success = true;
          break;
        } catch (e) {
          const delayMs = 500 * attempt * attempt + Math.floor(Math.random() * 300);
          logger.warn({ err: e?.message, attempt, chunkSize: chunk.length }, "Ошибка вставки в LanceDB; ретрай");
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      if (!success) {
        logger.error({ chunkStart: i, chunkSize: chunk.length }, "Пропускаю часть документов после неудачных попыток вставки");
        continue;
      }
      inserted += chunk.length;
      const processed = Math.min(i + chunk.length, docs.length);
      await updateLockMeta('indexing', { stage: 'insert', current: processed });
      // Notify progress with ETA every N items (skip final to avoid duplicate with 'done')
      if ((processed % progressEvery === 0) && processed !== docs.length) {
        const elapsed = Date.now() - insertStart;
        const etaMs = processed ? Math.max(0, Math.round(elapsed * (docs.length - processed) / processed)) : null;
        notify({ stage: 'insert', total: docs.length, current: processed, inserted, etaMs });
      }
    }
    logger.info({ channelId, inserted }, "Добавлены новые документы в таблицу канала");

    await updateLockMeta('indexing', { stage: 'done' });
    // Final notify (await to preserve order)
    await notify({ stage: 'done', total: docs.length, current: docs.length, inserted });
    logger.info("Батч‑индексация завершена успешно.");
  } catch (err) {
    const data = err?.response?.data;
    logger.error({ err: data || err.message }, "Ошибка при батч‑индексации YouTube → LanceDB");
  } finally {
    if (lockAcquired) {
      try { await releaseLock('indexing'); } catch (_) {}
    }
  }
}

main();



// Проверка корректности вектора: достаточная длина и все значения конечны
// removed accidental appended validation block