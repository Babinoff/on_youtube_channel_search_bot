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

  const body = {
    model: "mistral-embed",
    input: toFetch,
  };

  const maxAttempts = 5; // увеличено для вероятной перегруженности
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await limitEmb(() => axios.post("https://api.mistral.ai/v1/embeddings", body, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }));
      const items = resp?.data?.data;
      if (!Array.isArray(items)) {
        throw new Error("Некорректный ответ от Mistral embeddings API");
      }
      const fetchedVectors = items.map((it) => it.embedding);
      for (let j = 0; j < fetchedVectors.length; j++) {
        const idx = fetchIndices[j];
        const vec = fetchedVectors[j];
        results[idx] = vec;
        embeddingsCache.set(texts[idx], vec);
      }
      return results;
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.code;
      const retryAfterHeader = err?.response?.headers?.["retry-after"];
      const isRetryable = status === 429 || (status >= 500 && status < 600) || code === "3505";
      logger.error({ err: err?.response?.data || err.message, attempt }, "Ошибка вызова Mistral embeddings");
      lastErr = err;
      if (!isRetryable || attempt === maxAttempts) {
        throw err;
      }
      // экспонента + джиттер; учитываем Retry-After, если есть
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
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr || new Error("Не удалось получить эмбеддинги");
}

module.exports = { embedTexts };