const axios = require("axios");
const { env } = require("../../config/env");
const { logger } = require("../../config/logger");

// Простая реализация LRU-кэша
class LRUCache {
  constructor(max = 200) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.max) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
  }
}

const embeddingsCache = new LRUCache(env.EMBEDDINGS_CACHE_SIZE || 200);

function createLimiter(limit = 1) {
  let running = 0;
  const queue = [];
  const runNext = () => {
    if (running >= limit || queue.length === 0) return;
    const { fn, resolve, reject } = queue.shift();
    running++;
    Promise.resolve()
      .then(fn)
      .then((val) => { running--; resolve(val); runNext(); })
      .catch((err) => { running--; reject(err); runNext(); });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runNext();
  });
}

const limitEmb = createLimiter(env.EMBEDDINGS_MAX_CONCURRENCY || 1);

async function embedTexts(texts) {
  const apiKey = env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("MISTRAL_API_KEY отсутствует. Заполните .env");
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const results = new Array(texts.length);
  const toFetch = [];
  const fetchIndices = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const cached = embeddingsCache.get(t);
    if (cached) {
      results[i] = cached;
    } else {
      toFetch.push(t);
      fetchIndices.push(i);
    }
  }
  if (toFetch.length === 0) {
    return results;
  }

  const batchSize = Math.max(1, Number(env.EMBEDDINGS_BATCH_SIZE || 8));
  const maxAttempts = Math.max(1, Number(env.EMBEDDINGS_MAX_ATTEMPTS || 5));
  const timeoutMs = Math.max(1000, Number(env.EMBEDDINGS_TIMEOUT_MS || 30000));

  function computeDelay(attempt, retryAfterHeader) {
    let baseDelayMs = 500 * attempt * attempt; // 0.5s, 2s, 4.5s, 8s, 12s
    const jitter = Math.floor(Math.random() * 300);
    let delayMs = baseDelayMs + jitter;
    if (retryAfterHeader) {
      const asNumber = Number(retryAfterHeader);
      if (!Number.isNaN(asNumber) && asNumber > 0) {
        delayMs = Math.max(delayMs, asNumber * 1000);
      } else {
        const asDateMs = Date.parse(retryAfterHeader);
        if (!Number.isNaN(asDateMs)) {
          const delta = asDateMs - Date.now();
          if (delta > 0) delayMs = Math.max(delayMs, delta);
        }
      }
    }
    return delayMs;
  }

  function isCapacityOrSize(err) {
    const status = err?.response?.status;
    const code = err?.response?.data?.code;
    const msg = String(err?.response?.data?.error?.message || err?.message || '').toLowerCase();
    return status === 413 || code === '3505' || msg.includes('capacity');
  }

  function isRetryable(err) {
    const status = err?.response?.status;
    return status === 429 || (status >= 500 && status < 600) || isCapacityOrSize(err);
  }

  async function fetchChunk(chunkTexts, chunkIndices) {
    let attempt = 1;
    while (attempt <= maxAttempts) {
      try {
        const body = { model: "mistral-embed", input: chunkTexts };
        const resp = await limitEmb(() => axios.post("https://api.mistral.ai/v1/embeddings", body, {
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          timeout: timeoutMs,
        }));
        const items = resp?.data?.data;
        if (!Array.isArray(items) || items.length !== chunkTexts.length) {
          throw new Error("Некорректный ответ от Mistral embeddings API (size mismatch)");
        }
        for (let j = 0; j < items.length; j++) {
          const idx = chunkIndices[j];
          const vec = items[j]?.embedding;
          results[idx] = vec;
          embeddingsCache.set(texts[idx], vec);
        }
        return; // success
      } catch (err) {
        const retryAfter = err?.response?.headers?.["retry-after"];
        const capacity = isCapacityOrSize(err);
        const retryable = isRetryable(err);
        logger.warn({ err: err?.response?.data || err.message, attempt, chunkSize: chunkTexts.length }, "Ошибка Mistral embeddings; применяю ретрай/деление");

        // If capacity/payload issue and chunk > 1, split and recurse immediately
        if (capacity && chunkTexts.length > 1) {
          const mid = Math.floor(chunkTexts.length / 2);
          await fetchChunk(chunkTexts.slice(0, mid), chunkIndices.slice(0, mid));
          await fetchChunk(chunkTexts.slice(mid), chunkIndices.slice(mid));
          return;
        }

        if (!retryable || attempt === maxAttempts) {
          logger.error({ err: err?.response?.data || err.message, chunkSize: chunkTexts.length }, "Не удалось получить эмбеддинги для части; пропускаю");
          // Mark as undefined so индексатор может отфильтровать
          for (const idx of chunkIndices) results[idx] = undefined;
          return;
        }
        const delayMs = computeDelay(attempt, retryAfter);
        await new Promise((r) => setTimeout(r, delayMs));
        attempt++;
      }
    }
  }

  for (let s = 0; s < toFetch.length; s += batchSize) {
    const chunkTexts = toFetch.slice(s, s + batchSize);
    const chunkIndices = fetchIndices.slice(s, s + batchSize);
    await fetchChunk(chunkTexts, chunkIndices);
  }

  return results;
}

module.exports = { embedTexts };