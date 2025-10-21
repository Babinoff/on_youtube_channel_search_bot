const { logger } = require("../../config/logger");

// Cache pipeline between calls to avoid repeated model loads
let embedderPromise = null;

function l2Normalize(vec) {
  if (!Array.isArray(vec)) return vec;
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq) || 1;
  return vec.map((v) => v / norm);
}

async function getEmbedder(transformers) {
  if (embedderPromise) return embedderPromise;
  const model = process.env.EMBEDDINGS_XENOVA_MODEL || "Xenova/paraphrase-multilingual-MiniLM-L12-v2"; // multilingual, 384 dims
  const { pipeline, env: xenEnv } = transformers;

  try {
    // Optional offline settings via .env
    if (process.env.XENOVA_LOCAL_MODEL_PATH) {
      xenEnv.localModelPath = process.env.XENOVA_LOCAL_MODEL_PATH;
    }
    if (String(process.env.XENOVA_ALLOW_REMOTE_MODELS || "true").toLowerCase() === "false") {
      xenEnv.allowRemoteModels = false;
    }
    if (process.env.XENOVA_WASM_PATH) {
      xenEnv.backends.onnx.wasm.wasmPaths = process.env.XENOVA_WASM_PATH;
    }
  } catch (_) {
    // ignore env configuration errors
  }

  logger.info({ provider: "xenova", model }, "Загружаю модель Xenova");
  embedderPromise = pipeline("feature-extraction", model);
  return embedderPromise;
}

async function embedTexts(texts) {
  const items = Array.isArray(texts) ? texts : [texts];
  try {
    // Dynamic import to avoid requiring package unless configured
    const transformers = await import("@xenova/transformers").catch(() => null);
    if (!transformers) {
      throw new Error("@xenova/transformers не установлен. Установите пакет и модель.");
    }

    const embedder = await getEmbedder(transformers);

    const vectors = [];
    for (const t of items) {
      const output = await embedder(t, { pooling: "mean" });
      const raw = Array.from(output.data);
      const normed = l2Normalize(raw);
      vectors.push(normed);
    }
    logger.info({ provider: "xenova", dims: vectors[0]?.length }, "Эмбеддинги получены (нормированы)");
    return vectors;
  } catch (err) {
    logger.warn({ err: err?.message || err }, "Xenova локальный провайдер недоступен");
    return [];
  }
}

module.exports = { embedTexts };