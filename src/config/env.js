const dotenv = require("dotenv");

dotenv.config();

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env: ${name}`);
  }
  return val;
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  ADMIN_USER_ID: process.env.ADMIN_USER_ID ? Number(process.env.ADMIN_USER_ID) : undefined,
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
  YOUTUBE_CHANNEL_ID: process.env.YOUTUBE_CHANNEL_ID,
  EMBEDDINGS_PROVIDER: process.env.EMBEDDINGS_PROVIDER || "xenova",
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  VECTOR_DB: process.env.VECTOR_DB || "lancedb",
  LANCEDB_DIR: process.env.LANCEDB_DIR || "./data/lancedb",
  DATABASE_URL: process.env.DATABASE_URL || "./data/db.sqlite",
  EMBEDDINGS_MAX_CONCURRENCY: Number(process.env.EMBEDDINGS_MAX_CONCURRENCY || 1),
  EMBEDDINGS_CACHE_SIZE: Number(process.env.EMBEDDINGS_CACHE_SIZE || 200),
  SEARCH_MAX_DISTANCE: Number(process.env.SEARCH_MAX_DISTANCE || 0.7),
  // New limits for descriptions (display and indexing)
  LATEST_DESC_MAX_CHARS: Number(process.env.LATEST_DESC_MAX_CHARS || 200),
  INDEX_DESC_MAX_TOKENS: Number(process.env.INDEX_DESC_MAX_TOKENS || 100),
  INDEX_DESC_MAX_CHARS: Number(process.env.INDEX_DESC_MAX_CHARS || 100),
  INDEX_DESC_STRIP_AFTER_PATTERNS: process.env.INDEX_DESC_STRIP_AFTER_PATTERNS || 'ПОДДЕРЖАТЬ НАС МОЖНО|+++|По вопросам сотрудничества|подписывайтесь|subscribe|донат|donate|patreon|boosty|ссылки|links',
  INDEX_DESC_AD_LINE_PREFIX_CHARS: process.env.INDEX_DESC_AD_LINE_PREFIX_CHARS || '•,+,*,—,–,-,►,➡,→,➜',
  require: (name) => requireEnv(name),
};

module.exports = { env };