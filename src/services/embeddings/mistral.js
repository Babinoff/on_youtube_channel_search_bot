const axios = require("axios");
const { env } = require("../../config/env");
const { logger } = require("../../config/logger");

async function embedTexts(texts) {
  const apiKey = env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("MISTRAL_API_KEY отсутствует. Заполните .env");
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const body = {
    model: "mistral-embed",
    input: texts,
  };

  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await axios.post("https://api.mistral.ai/v1/embeddings", body, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      });
      const items = resp?.data?.data;
      if (!Array.isArray(items)) {
        throw new Error("Некорректный ответ от Mistral embeddings API");
      }
      return items.map((it) => it.embedding);
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.code;
      const isRetryable = status === 429 || (status >= 500 && status < 600) || code === "3505";
      logger.error({ err: err?.response?.data || err.message, attempt }, "Ошибка вызова Mistrал embeddings");
      lastErr = err;
      if (!isRetryable || attempt === maxAttempts) {
        throw err;
      }
      const delayMs = 500 * attempt * attempt; // 0.5s, 2s, 4.5s
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  // Если цикл завершился без возврата — пробрасываем последнюю ошибку
  throw lastErr || new Error("Не удалось получить эмбеддинги");
}

module.exports = { embedTexts };