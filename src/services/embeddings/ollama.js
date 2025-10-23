const axios = require("axios");
const { env } = require("../../config/env");
const { logger } = require("../../config/logger");

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

function l2Normalize(vec) {
  if (!Array.isArray(vec)) return vec;
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += Number(vec[i] || 0) * Number(vec[i] || 0);
  const norm = Math.sqrt(sumSq) || 1;
  return vec.map((v) => Number(v || 0) / norm);
}

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

function isRetryable(err) {
  const status = err?.response?.status;
  const msg = String(err?.response?.data?.error || err?.message || '').toLowerCase();
  return status === 429 || (status >= 500 && status < 600) || /timeout|temporarily|rate limit|network|econnrefused|econnreset/.test(msg);
}

function computeDelay(attempt) {
  const base = 500 * attempt * attempt; // 0.5s, 2s, 4.5s, ...
  const jitter = Math.floor(Math.random() * 300);
  return base + jitter;
}

async function embedTexts(texts) {
  const baseUrl = env.OLLAMA_BASE_URL || "http://localhost:11434";
  const model = env.OLLAMA_MODEL || "embeddinggemma";
  const items = Array.isArray(texts) ? texts : [texts];
  if (!items.length) return [];

  const results = new Array(items.length);

  const maxAttempts = Math.max(1, Number(env.EMBEDDINGS_MAX_ATTEMPTS || 5));
  const timeoutMs = Math.max(1000, Number(env.EMBEDDINGS_TIMEOUT_MS || 30000));
  const maxChunkLen = Math.min(2048, Math.max(200, Number(env.EMBEDDINGS_MAX_CHUNK_LEN || 1000))); // approx chars
  const chunkOverlap = Math.min(200, Math.max(0, Number(env.EMBEDDINGS_CHUNK_OVERLAP || 200)));

  async function postSegment(prompt) {
    let attempt = 1;
    while (attempt <= maxAttempts) {
      try {
        const body = { model, prompt };
        const resp = await axios.post(`${baseUrl}/api/embeddings`, body, {
          headers: { "Content-Type": "application/json" },
          timeout: timeoutMs,
        });
        const raw = resp?.data?.embedding;
        if (!Array.isArray(raw) || raw.length === 0) {
          throw new Error("Некорректный ответ от Ollama embeddings API");
        }
        return l2Normalize(raw); // нормируем сегменты
      } catch (err) {
        const retryable = isRetryable(err);
        logger.warn({ err: err?.response?.data || err?.message, attempt }, "Ошибка Ollama embeddings; ретрай?");
        if (!retryable || attempt === maxAttempts) {
          logger.error({ err: err?.response?.data || err?.message }, "Не удалось получить эмбеддинг сегмента");
          return undefined;
        }
        await new Promise((r) => setTimeout(r, computeDelay(attempt)));
        attempt++;
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    const cached = embeddingsCache.get(t);
    if (cached) { results[i] = cached; continue; }

    const segments = chunkText(t, maxChunkLen, chunkOverlap);
    if (segments.length === 0) { results[i] = undefined; continue; }

    const vectors = [];
    for (const seg of segments) {
      const v = await limitEmb(() => postSegment(seg));
      if (Array.isArray(v)) vectors.push(v);
    }

    const avg = averageVectors(vectors);
    const final = avg ? l2Normalize(avg) : undefined; // финальная L2-нормализация
    results[i] = final;
    if (final) embeddingsCache.set(t, final);
  }

  logger.info({ provider: String(env.EMBEDDINGS_PROVIDER || 'embeddinggemma'), dims: results[0]?.length }, "Эмбеддинги получены (Ollama)");
  return results;
}

module.exports = { embedTexts };