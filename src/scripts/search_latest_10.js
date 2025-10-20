require("dotenv").config();
const { logger } = require("../config/logger");
const { env } = require("../config/env");
const { embedTexts } = require("../services/embeddings/mistral");
const { openLatestTestTable } = require("../services/vector/lancedb");

async function main() {
  try {
    
    const q = process.argv.slice(2).join(" ").trim();
    logger.info({ q }, "Запрос поиска");

    const [qVec] = await embedTexts([q]);
    if (!qVec || !Array.isArray(qVec)) {
      throw new Error("Не удалось получить эмбеддинг запроса");
    }

    const { tableName, table } = await openLatestTestTable();
    const qb = typeof table.vectorSearch === 'function' ? table.vectorSearch(qVec) : table.search(qVec);
    const results = typeof qb.toArray === 'function'
      ? await qb.limit(5).toArray()
      : await qb.limit(5).execute();

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