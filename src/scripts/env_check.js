require("dotenv").config();
const { logger } = require("../config/logger");
const { env, validateEnv } = require("../config/env");

async function main() {
  const result = validateEnv();
  if (!result.ok) {
    logger.error({ errors: result.errors }, "Проблемы окружения: исправьте .env");
    if (result.warnings && result.warnings.length) {
      logger.warn({ warnings: result.warnings }, "Предупреждения окружения");
    }
    process.exit(1);
  }

  // Summary
  logger.info({
    NODE_ENV: env.NODE_ENV,
    EMBEDDINGS_PROVIDER: env.EMBEDDINGS_PROVIDER,
    SEARCH_MAX_K: env.SEARCH_MAX_K,
    SEARCH_MAX_DISTANCE: env.SEARCH_MAX_DISTANCE,
    LANCEDB_DIR: env.LANCEDB_DIR,
    DESC_MAX_CHARS: env.DESC_MAX_CHARS,
  }, "Окружение валидно");

  // Provider-specific hints
  const provider = String(env.EMBEDDINGS_PROVIDER || '').toLowerCase();
  if (provider === 'mistral' && !env.MISTRAL_API_KEY) {
    logger.warn("MISTRAL_API_KEY отсутствует при EMBEDDINGS_PROVIDER=mistral — эмбеддинги не будут работать");
  }
  if (provider === 'openai' && !env.OPENAI_API_KEY) {
    logger.warn("OPENAI_API_KEY отсутствует при EMBEDDINGS_PROVIDER=openai — эмбеддинги не будут работать");
  }

  logger.info("Проверка окружения завершена успешно");
}

main().catch((err) => {
  logger.error({ err: err?.message || err }, "Ошибка проверки окружения");
  process.exit(1);
});