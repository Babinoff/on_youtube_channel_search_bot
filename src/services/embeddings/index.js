const { env } = require("../../config/env");
const { logger } = require("../../config/logger");

function resolveProviderChain() {
  const chainRaw = env.EMBEDDINGS_PROVIDER_CHAIN || env.EMBEDDINGS_PROVIDER || "mistral,xenova";
  return String(chainRaw)
    .split(/[\s,|]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function tryRequire(path) {
  try { return require(path); } catch (_) { return null; }
}

function loadProvider(name) {
  switch (name) {
    case "mistral":
      return tryRequire("./mistral");
    case "xenova":
      return tryRequire("./xenova");
    case "google":
      return tryRequire("./google");
    case "openai":
      return tryRequire("./openai");
    case "embeddinggemma":
      return tryRequire("./embeddinggemma");
    default:
      return null;
  }
}

function isRetryableError(err) {
  const msg = err?.response?.data || err?.message || String(err);
  return /timeout|temporarily|rate limit|429|503|network/i.test(msg);
}

function okVectors(vectors, expectedCount) {
  return Array.isArray(vectors) && vectors.length === expectedCount && vectors.every((v) => Array.isArray(v));
}

// Provider meta: metric type and max distance bound
const providerMeta = {
  xenova: { metric: 'cosine_distance', distanceMax: 2 },
  mistral: { metric: 'cosine_distance', distanceMax: 2 },
  openai: { metric: 'cosine_distance', distanceMax: 2 },
  google: { metric: 'cosine_distance', distanceMax: 2 },
  embeddinggemma: { metric: 'cosine_distance', distanceMax: 2 },
};

function getProviderDistanceMax(chainInput) {
  const chain = Array.isArray(chainInput) ? chainInput : resolveProviderChain();
  const first = (chain && chain[0]) ? chain[0] : String(env.EMBEDDINGS_PROVIDER || '').toLowerCase();
  const meta = providerMeta[first];
  return (meta && Number.isFinite(meta.distanceMax)) ? meta.distanceMax : 2;
}

async function embedTexts(texts) {
  const items = Array.isArray(texts) ? texts : [texts];
  const chain = resolveProviderChain();

  for (const name of chain) {
    const provider = loadProvider(name);
    if (!provider || typeof provider.embedTexts !== "function") {
      logger.warn({ provider: name }, "Провайдер эмбеддингов не реализован/недоступен");
      continue;
    }

    logger.info({ provider: name, count: items.length }, "Получение эмбеддингов");
    try {
      const vectors = await provider.embedTexts(items);
      if (okVectors(vectors, items.length)) {
        logger.info({ provider: name, dims: vectors[0]?.length }, "Эмбеддинги получены");
        return vectors;
      }
      throw new Error(`Провайдер '${name}' вернул неподходящий результат`);
    } catch (err) {
      const retryable = isRetryableError(err);
      logger.warn({ provider: name, err: err?.response?.data || err?.message }, retryable ? "Ошибка провайдера (переключаемся)" : "Ошибка провайдера");
      if (!retryable) throw err; // non-retryable: stop immediately
      // else continue to next provider in chain
    }
  }

  throw new Error(`Не удалось получить эмбеддинги. Цепочка провайдеров: ${chain.join(", ")}`);
}

module.exports = { embedTexts, resolveProviderChain, providerMeta, getProviderDistanceMax };