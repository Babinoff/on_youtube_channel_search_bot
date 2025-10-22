require("dotenv").config();
const { logger } = require("../config/logger");
const { searchUnified } = require("../services/vector/search");

async function main() {
  try {
    const q = process.argv.slice(2).join(" ").trim();
    logger.info({ q }, "Запрос поиска (latest10, unified)");

    const results = await searchUnified(q, 5, {});
    if (!results || results.length === 0) {
      logger.info("Нет результатов");
      process.exit(0);
    }

    const lines = results.map((r, i) => {
      const score = r.score;
      const title = r.title || "(без названия)";
      const url = r.url || (r.id ? `https://youtu.be/${r.id}` : "");
      return `${i + 1}. ${title}\n${url}${score !== undefined ? `\nscore: ${score}` : ""}`;
    });

    console.log(lines.join("\n\n"));
    logger.info({ count: results.length }, "Поиск завершён");
  } catch (err) {
    const data = err?.response?.data;
    logger.error({ err: data || err.message }, "Ошибка при тестовом поиске (unified)");
    process.exit(1);
  }
}

main();