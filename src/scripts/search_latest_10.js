require("dotenv").config();
const { logger } = require("../config/logger");
const { env } = require("../config/env");
const { embedTexts } = require("../services/embeddings/mistral");
const { openLatestTestTable } = require("../services/vector/lancedb");

async function main() {
  try {
    if (!env.MISTRAL_API_KEY) {
      logger.error("MISTRAL_API_KEY отсутствует. Заполните .env и повторите.");
      process.exit(1);
    }

    const q = process.argv.slice(2).join(" ").trim() || "IFC SQLite Facility management";
    logger.info({ q }, "Запрос поиска");

    const [qVec] = await embedTexts([q]);
    if (!qVec || !Array.isArray(qVec)) {
      throw new Error("Не удалось получить эмбеддинг запроса");
    }

    const { tableName, table } = await openLatestTestTable();
    const res = await table.search(qVec).limit(5).execute();
    const results = Array.isArray(res)
      ? res
      : (typeof res?.toArray === "function" ? res.toArray() : []);

    if (!results || results.length === 0) {
      logger.info("Нет результатов");
      process.exit(0);
    }

    const lines = results.map((r, i) => {
      const score = r._distance ?? r.score ?? r.distance ?? undefined;
      const title = r.title || r.snippet?.title || "(без названия)";
      const url = r.url || (r.id ? `https://youtu.be/${r.id}` : "");
      return `${i + 1}. ${title}\n${url}${score !== undefined ? `\nscore: ${score}` : ""}`;
    });

    console.log(lines.join("\n\n"));
    logger.info({ tableName, count: results.length }, "Поиск завершён");
  } catch (err) {
    const data = err?.response?.data;
    logger.error({ err: data || err.message }, "Ошибка при тестовом поиске LanceDB");
    process.exit(1);
  }
}

main();