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
    const data = err?.response?.data;
    logger.error({ err: data || err.message }, "Ошибка вызова Mistral embeddings");
    throw err;
  }
}

module.exports = { embedTexts };