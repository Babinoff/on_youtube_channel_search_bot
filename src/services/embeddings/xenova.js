const { logger } = require("../../config/logger");

async function embedTexts(texts) {
  const items = Array.isArray(texts) ? texts : [texts];
  try {
    // Try dynamic import to avoid requiring package unless configured
    const transformers = await import("@xenova/transformers").catch(() => null);
    if (!transformers) {
      throw new Error("@xenova/transformers не установлен. Установите пакет и модель.");
    }

    // Minimal example: load an embedding pipeline
    // NOTE: Users must ensure the model is available; consider exposing via ENV
    const { pipeline } = transformers;
    const embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");

    const vectors = [];
    for (const t of items) {
      const output = await embedder(t, { pooling: "mean" });
      vectors.push(Array.from(output.data));
    }
    return vectors;
  } catch (err) {
    logger.warn({ err: err?.message || err }, "Xenova локальный провайдер недоступен");
    // Returning empty array signals failure to caller which may fall back
    return [];
  }
}

module.exports = { embedTexts };