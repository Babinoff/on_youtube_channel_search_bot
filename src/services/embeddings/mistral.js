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

function chunkText(str, maxLen = 1000, overlap = 200) {
  const s = String(str || "");
  if (!s) return [];
  if (s.length <= maxLen) return [s];
  const out = [];
  const step = Math.max(1, maxLen - overlap);
  let start = 0;
  while (start < s.length) {
    out.push(s.slice(start, start + maxLen));
    start += step;
  }
  return out;
}

function averageVectors(vectors) {
  const arr = (vectors || []).filter(v => Array.isArray(v) && v.length > 0);
  if (!arr.length) return undefined;
  const dim = arr[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of arr) {
    for (let i = 0; i < dim; i++) sum[i] += Number(v[i] || 0);
  }
  const inv = 1 / arr.length;
  return sum.map(x => x * inv);
}

async function embedTexts(texts) {
  const apiKey = env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("MISTRAL_API_KEY отсутствует. Заполните .env");
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const results = new Array(texts.length);

  const batchSize = Math.min(10, Math.max(1, Number(env.EMBEDDINGS_BATCH_SIZE || 10))); // hard cap 10
  const maxAttempts = Math.max(1, Number(env.EMBEDDINGS_MAX_ATTEMPTS || 5));
  const timeoutMs = Math.max(1000, Number(env.EMBEDDINGS_TIMEOUT_MS || 30000));
  const maxChunkLen = Math.min(1000, Math.max(200, Number(env.EMBEDDINGS_MAX_CHUNK_LEN || 1000))); // <=1000
  const chunkOverlap = Math.min(200, Math.max(0, Number(env.EMBEDDINGS_CHUNK_OVERLAP || 200))); // <=200

  async function postBatchSequential(batch) {
    let attempt = 1;
    while (attempt <= maxAttempts) {
      try {
        const body = { model: "mistral-embed", input: batch };
        const resp = await axios.post("https://api.mistral.ai/v1/embeddings", body, {
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          timeout: timeoutMs,
        });
        const items = resp?.data?.data;
        if (!Array.isArray(items) || items.length !== batch.length) {
          throw new Error("Некорректный ответ от Mistral embeddings API (size mismatch)");
        }
        return items.map(it => it?.embedding);
      } catch (err) {
        const retryAfter = err?.response?.headers?.["retry-after"];
        const capacity = isCapacityOrSize(err);
        const retryable = isRetryable(err);
        logger.warn({ err: err?.response?.data || err.message, attempt, batchLen: batch.length }, "Ошибка Mistral embeddings; ретрай или деление");

        if (capacity && batch.length > 1) {
          const mid = Math.floor(batch.length / 2);
          const left = await postBatchSequential(batch.slice(0, mid));
          const right = await postBatchSequential(batch.slice(mid));
          return [...(left || []), ...(right || [])];
        }

        if (!retryable || attempt === maxAttempts) {
          logger.error({ err: err?.response?.data || err.message, batchLen: batch.length }, "Не удалось получить эмбеддинги для батча; пропускаю");
          return new Array(batch.length).fill(undefined);
        }
        const delayMs = computeDelay(attempt, retryAfter);
        await new Promise((r) => setTimeout(r, delayMs));
        attempt++;
      }
    }
  }

  for (let i = 0; i < texts.length; i++) {
    const t = texts[i];
    const cached = embeddingsCache.get(t);
    if (cached) { results[i] = cached; continue; }

    const segments = chunkText(t, maxChunkLen, chunkOverlap);
    if (segments.length === 0) { results[i] = undefined; continue; }

    const vectors = [];
    for (let s = 0; s < segments.length; s += batchSize) {
      const batch = segments.slice(s, s + batchSize);
      const emb = await postBatchSequential(batch); // строго последовательно
      if (Array.isArray(emb)) vectors.push(...emb);
    }

    const final = averageVectors(vectors.filter(Boolean));
    results[i] = final;
    if (final) embeddingsCache.set(t, final);
  }

  return results;
}

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

module.exports = { embedTexts };