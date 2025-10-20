const { env } = require("../../config/env");
const { logger } = require("../../config/logger");
const https = require("https");

function postGoogleEmbeddings(texts) {
  return new Promise((resolve, reject) => {
    const apiKey = env.GOOGLE_API_KEY || env.VERTEX_API_KEY || "";
    const modelId = env.EMBEDDINGS_MODEL_ID || "text-embedding-004"; // Gemini Embeddings
    if (!apiKey) {
      return reject(new Error("GOOGLE_API_KEY отсутствует"));
    }

    const body = JSON.stringify({ content: { parts: texts.map((t) => ({ text: t })) } });
    const path = `/v1beta/models/${encodeURIComponent(modelId)}:embedContent?key=${encodeURIComponent(apiKey)}`;

    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      port: 443,
      path,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeout: env.EMBEDDINGS_TIMEOUT_MS || 30000,
    }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const txt = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(Object.assign(new Error(`Google API ${res.statusCode}`), { statusCode: res.statusCode, response: { data: txt } }));
        }
        try {
          const json = JSON.parse(txt);
          const vectors = (json?.embedding?.values && [json.embedding.values]) || (Array.isArray(json?.embeddings) ? json.embeddings.map((e) => e.values) : []);
          resolve(vectors);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("Google API timeout")); });
    req.write(body);
    req.end();
  });
}

async function embedTexts(texts) {
  const items = Array.isArray(texts) ? texts : [texts];
  try {
    const vectors = await postGoogleEmbeddings(items);
    return vectors;
  } catch (err) {
    logger.warn({ err: err?.response?.data || err?.message || err }, "Google провайдер недоступен");
    return [];
  }
}

module.exports = { embedTexts };