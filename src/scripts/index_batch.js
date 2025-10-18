require("dotenv").config();
const { logger } = require("../config/logger");
const { env } = require("../config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("../services/youtube/client");
const { acquireLock, releaseLock, updateLockMeta } = require("../services/concurrency/lock");
const { embedTexts } = require("../services/embeddings/mistral");
const { openChannelTableIfExists, addDocsToChannelTable } = require("../services/vector/lancedb");

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripAdLines(text) {
  const raw = text || "";
  const charsCsv = env.INDEX_DESC_AD_LINE_PREFIX_CHARS || "";
  const chars = charsCsv.split(",").map(s => s.trim()).filter(Boolean);
  if (!chars.length) return raw;
  const re = new RegExp(`^\\s*(?:${chars.map(c => escapeRegex(c)).join("|")})\\s*`, "i");
  const lines = raw.split(/\r?\n/);
  const filtered = lines.filter(l => !re.test(l));
  return filtered.join("\n");
}

function stripAfterPatterns(text) {
  const raw = text || "";
  const csv = env.INDEX_DESC_STRIP_AFTER_PATTERNS || "";
  const patterns = csv.split(",").map(s => s.trim()).filter(Boolean);
  if (!patterns.length) return raw;
  let idx = -1;
  for (const p of patterns) {
    const pos = raw.toLowerCase().indexOf(p.toLowerCase());
    if (pos >= 0) {
      idx = idx >= 0 ? Math.min(idx, pos) : pos;
    }
  }
  if (idx < 0) return raw;
  return raw.slice(0, idx);
}

function truncateByTokens(text, maxTokens) {
  const max = Number(maxTokens) || 0;
  if (!max || max <= 0) return text || "";
  return (text || "").split(/\s+/).slice(0, max).join(" ");
}

function truncateByChars(text, maxChars) {
  const max = Number(maxChars) || 0;
  if (!max || max <= 0) return text || "";
  const s = String(text || "");
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeDescriptionForIndex(desc) {
  let s = desc || "";
  s = stripAdLines(s);
  s = stripAfterPatterns(s);
  s = cleanText(s);
  s = truncateByTokens(s, env.INDEX_DESC_MAX_TOKENS);
  s = truncateByChars(s, env.INDEX_DESC_MAX_CHARS);
  return s;
}

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
    if (!env.YOUTUBE_API_KEY) {
      logger.error("YOUTUBE_API_KEY отсутствует. Заполните .env и повторите.");
      process.exit(1);
    }
    if (!env.MISTRAL_API_KEY) {
      logger.error("MISTRAL_API_KEY отсутствует. Заполните .env и повторите.");
      process.exit(1);
    }

    const inputArg = process.argv[2];
    const inputEnv = env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_CHANNEL_ID;
    const input = inputEnv || inputArg;
    if (!input) {
      logger.info("Укажите канал через .env (YOUTUBE_CHANNEL_ID) или аргумент: npm run index:batch -- <channelId|url|@handle> --limit 100");
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
    const channelId = inputEnv ? inputEnv : await resolveChannelId(input, client);

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
    if (stoppedEarly) {
      logger.info("Пагинация остановлена на первом известном videoId (инкрементальный режим)");
    }
    logger.info({ count: toProcessIds.length }, "Собраны видео для батч‑индексации");

    // Dedup: skip IDs already in the channel table
    const newIds = toProcessIds.filter(id => !existing.has(id));
    if (!newIds.length) {
      await updateLockMeta('indexing', { stage: 'done', total: 0, current: 0 });
      logger.info("Все выбранные видео уже проиндексированы. Нечего добавлять.");
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
      await updateLockMeta('indexing', { stage: 'fetch_details', current: Math.min((i + 1) * 50, newIds.length) });
    }

    await updateLockMeta('indexing', { stage: 'normalize', total: details.length });
    const docsMeta = details.map(v => {
      const id = v.id;
      const title = cleanText(v.snippet?.title || "");
      const description = cleanText(v.snippet?.description || "");
      const descriptionIndexed = normalizeDescriptionForIndex(description);
      const url = `https://youtu.be/${id}`;
      const publishedAt = v.snippet?.publishedAt || null;
      const etag = v.etag || null;
      return {
        id,
        title,
        description,
        description_indexed: descriptionIndexed,
        url,
        channel_id: channelId,
        published_at: publishedAt,
        etag,
        last_indexed_at: new Date().toISOString(),
      };
    });

    const texts = docsMeta.map(d => `${d.title}\n\n${d.description_indexed}`);
    await updateLockMeta('indexing', { stage: 'embedding', total: texts.length, current: 0 });
    logger.info({ count: texts.length }, "Запрос эмбеддингов в Mistral");
    const vectors = await embedTexts(texts);
    await updateLockMeta('indexing', { stage: 'embedding', current: texts.length });
    if (!vectors.length) throw new Error("Эмбеддинги не получены");

    // Привязка векторов и фильтрация пустых (в случае пропуска части)
    let docs = docsMeta.map((d, i) => ({ ...d, vector: vectors[i] })).filter((d) => Array.isArray(d.vector));
    const skipped = docsMeta.length - docs.length;
    if (skipped > 0) {
      logger.warn({ skipped }, "Часть документов без эмбеддингов будет пропущена");
    }

    await updateLockMeta('indexing', { stage: 'insert', total: docs.length });
    const chunkSize = Math.max(1, Number(env.LANCEDB_INSERT_BATCH_SIZE || 50));
    const maxInsertAttempts = Math.max(1, Number(env.LANCEDB_INSERT_MAX_ATTEMPTS || 3));
    let inserted = 0;
    for (let i = 0; i < docs.length; i += chunkSize) {
      const chunk = docs.slice(i, i + chunkSize);
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
      await updateLockMeta('indexing', { stage: 'insert', current: Math.min(i + chunk.length, docs.length) });
    }
    logger.info({ channelId, inserted }, "Добавлены новые документы в таблицу канала");

    await updateLockMeta('indexing', { stage: 'done' });
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