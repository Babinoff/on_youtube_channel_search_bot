const { logger } = require("./config/logger");
const { env } = require("./config/env");

logger.info({ env: env.NODE_ENV }, "YouTube RAG bot starting (JS mode)");

// Placeholder: main app will initialize Telegram bot later
if (!env.YOUTUBE_API_KEY) {
  logger.warn("YOUTUBE_API_KEY отсутствует в .env — заполните перед проверкой.");
}

logger.info("Готово к проверке подключения к YouTube через скрипт check:youtube.");