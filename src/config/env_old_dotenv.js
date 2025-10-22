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
  YOUTUBE_CHANNEL_ID: process.env.YOUTUBE_CHANNEL_ID || "",
  YOUTUBE_CHANNELS_ID: process.env.YOUTUBE_CHANNELS_ID || "",
  EMBEDDINGS_PROVIDER: process.env.EMBEDDINGS_PROVIDER || "xenova",
  EMBEDDINGS_PROVIDER_CHAIN: process.env.EMBEDDINGS_PROVIDER_CHAIN || "",
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  VECTOR_DB: process.env.VECTOR_DB || "lancedb",
  LANCEDB_DIR: process.env.LANCEDB_DIR || "./data/lancedb",
  DATABASE_URL: process.env.DATABASE_URL || "./data/db.sqlite",
  EMBEDDINGS_MAX_CONCURRENCY: Number(process.env.EMBEDDINGS_MAX_CONCURRENCY || 1),
  EMBEDDINGS_CACHE_SIZE: Number(process.env.EMBEDDINGS_CACHE_SIZE || 200),
  SEARCH_MAX_DISTANCE: Number(process.env.SEARCH_MAX_DISTANCE || 0.7),
  // Synonyms for search distance bounds
  SEARCH_MAX_DISTANCE_MIN: Number(process.env.SEARCH_DISTANCE_MIN ?? process.env.SEARCH_MAX_DISTANCE_MIN ?? 0.1),
  SEARCH_MAX_DISTANCE_MAX: Number(process.env.SEARCH_DISTANCE_MAX ?? process.env.SEARCH_MAX_DISTANCE_MAX ?? 2),
  SEARCH_DISTANCE_MIN: Number(process.env.SEARCH_DISTANCE_MIN ?? process.env.SEARCH_MAX_DISTANCE_MIN ?? 0.1),
  SEARCH_DISTANCE_MAX: Number(process.env.SEARCH_DISTANCE_MAX ?? process.env.SEARCH_MAX_DISTANCE_MAX ?? 2),
  // Unified description length limit for both display and indexing
  DESC_MAX_CHARS: Number(process.env.DESC_MAX_CHARS || 500),
  // Messaging: delay between Telegram messages to avoid rate limits
  TELEGRAM_SEND_DELAY_MS: Number(process.env.TELEGRAM_SEND_DELAY_MS || 250),
  // Search defaults
  SEARCH_TOP_K: Number(process.env.SEARCH_TOP_K || 5),
  // Enable/disable query text normalization before embedding
  SEARCH_NORMALIZE_QUERY: ["1","true","yes","on"].includes(String(process.env.SEARCH_NORMALIZE_QUERY || "true").toLowerCase()),
  // Max cap for adjustable k via settings (default 20)
  SEARCH_MAX_K: Number(process.env.SEARCH_MAX_K || 20),
  INDEX_DESC_STRIP_AFTER_PATTERNS: process.env.INDEX_DESC_STRIP_AFTER_PATTERNS || 'https,📺 Больше контента здесь:,ПОДДЕРЖАТЬ НАС МОЖНО,+++,По вопросам сотрудничества,подписывайтесь,subscribe,донат,donate,patreon,boosty,ссылки,links',
  INDEX_DESC_AD_LINE_PREFIX_CHARS: process.env.INDEX_DESC_AD_LINE_PREFIX_CHARS || '•,+,*,—,–,-,►,➡,→,➜',
  // Stop uploads pagination when first known videoId encountered (prod=true, dev=false)
  INDEX_STOP_ON_FIRST_KNOWN: ["1","true","yes","on"].includes(String(process.env.INDEX_STOP_ON_FIRST_KNOWN || "false").toLowerCase()),
  // Embeddings robustness
  EMBEDDINGS_BATCH_SIZE: Number(process.env.EMBEDDINGS_BATCH_SIZE || 8),
  EMBEDDINGS_MAX_ATTEMPTS: Number(process.env.EMBEDDINGS_MAX_ATTEMPTS || 5),
  EMBEDDINGS_TIMEOUT_MS: Number(process.env.EMBEDDINGS_TIMEOUT_MS || 30000),
  // LanceDB insert robustness
  LANCEDB_INSERT_BATCH_SIZE: Number(process.env.LANCEDB_INSERT_BATCH_SIZE || 50),
  LANCEDB_INSERT_MAX_ATTEMPTS: Number(process.env.LANCEDB_INSERT_MAX_ATTEMPTS || 3),
  require: (name) => requireEnv(name),
};

function setGlobalChannelId(id) {
  env.YOUTUBE_CHANNEL_ID = id || undefined;
}

function validateEnv() {
  const { logger } = require("./logger");
  const errors = [];
  const warnings = [];

  // Required tokens
  if (!env.TELEGRAM_BOT_TOKEN) {
    errors.push("TELEGRAM_BOT_TOKEN отсутствует — заполните .env");
  }
  if (!env.YOUTUBE_API_KEY) {
    // YouTube API key is needed for latest/indexing flows; warn if missing
    warnings.push("YOUTUBE_API_KEY отсутствует — функции YouTube (🆕 Последние, индексация) недоступны");
  }

  // Search ranges
  if (!Number.isFinite(env.SEARCH_MAX_K) || env.SEARCH_MAX_K < 1) {
    errors.push("SEARCH_MAX_K должен быть положительным числом (>= 1)");
  }
  if (!Number.isFinite(env.SEARCH_MAX_DISTANCE_MIN) || env.SEARCH_MAX_DISTANCE_MIN < 0) {
    warnings.push("SEARCH_MAX_DISTANCE_MIN должен быть ≥ 0");
  }
  if (!Number.isFinite(env.SEARCH_MAX_DISTANCE_MAX) || env.SEARCH_MAX_DISTANCE_MAX <= env.SEARCH_MAX_DISTANCE_MIN) {
    warnings.push("SEARCH_MAX_DISTANCE_MAX должен быть > SEARCH_MAX_DISTANCE_MIN");
  }
  if (!Number.isFinite(env.SEARCH_MAX_DISTANCE) || env.SEARCH_MAX_DISTANCE < env.SEARCH_MAX_DISTANCE_MIN || env.SEARCH_MAX_DISTANCE > env.SEARCH_MAX_DISTANCE_MAX) {
    warnings.push(`SEARCH_MAX_DISTANCE вне диапазона [${env.SEARCH_MAX_DISTANCE_MIN} .. ${env.SEARCH_MAX_DISTANCE_MAX}]`);
  }
  if (!Number.isFinite(env.SEARCH_MAX_DISTANCE) || env.SEARCH_MAX_DISTANCE <= 0 || env.SEARCH_MAX_DISTANCE > 2) {
    warnings.push("SEARCH_MAX_DISTANCE вне типичного диапазона (ожидается 0 < x ≤ 2)");
  }
  if (process.env.SEARCH_DISTANCE_MIN !== undefined && process.env.SEARCH_MAX_DISTANCE_MIN !== undefined) {
    warnings.push("Заданы оба: SEARCH_DISTANCE_MIN и SEARCH_MAX_DISTANCE_MIN — используем SEARCH_DISTANCE_MIN");
  }
  if (process.env.SEARCH_DISTANCE_MAX !== undefined && process.env.SEARCH_MAX_DISTANCE_MAX !== undefined) {
    warnings.push("Заданы оба: SEARCH_DISTANCE_MAX и SEARCH_MAX_DISTANCE_MAX — используем SEARCH_DISTANCE_MAX");
  }

  // Messaging rate limits
  if (!Number.isFinite(env.TELEGRAM_SEND_DELAY_MS) || env.TELEGRAM_SEND_DELAY_MS < 0) {
    warnings.push("TELEGRAM_SEND_DELAY_MS должен быть неотрицательным числом");
  }

  // Embeddings provider sanity
  const provider = String(env.EMBEDDINGS_PROVIDER || "").toLowerCase();
  const knownProviders = ["xenova", "mistral", "openai", "google"];
  if (provider && !knownProviders.includes(provider)) {
    warnings.push(`Неизвестный EMBEDDINGS_PROVIDER: ${env.EMBEDDINGS_PROVIDER} (известные: ${knownProviders.join(", ")})`);
  }
  const chainRaw = String(env.EMBEDDINGS_PROVIDER_CHAIN || '').trim();
  if (chainRaw) {
    const chain = chainRaw.split(/[\s,|]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = chain.filter((name) => !knownProviders.includes(name));
    if (unknown.length) {
      warnings.push(`EMBEDDINGS_PROVIDER_CHAIN содержит неизвестные провайдеры: ${unknown.join(", ")}`);
    }
  }
  if (provider === "mistral" && !env.MISTRAL_API_KEY) {
    warnings.push("MISTRAL_API_KEY отсутствует при EMBEDDINGS_PROVIDER=mistral — эмбеддинги могут не работать");
  }
  if (provider === "openai" && !env.OPENAI_API_KEY) {
    warnings.push("OPENAI_API_KEY отсутствует при EMBEDDINGS_PROVIDER=openai — эмбеддинги могут не работать");
  }

  // LanceDB config
  if (!env.LANCEDB_DIR) {
    warnings.push("LANCEDB_DIR не задан — используется ./data/lancedb");
  }

  // Log summary
  warnings.forEach((w) => logger.warn(w));
  errors.forEach((e) => logger.error(e));

  return { ok: errors.length === 0, errors, warnings };
}
module.exports = { env, setGlobalChannelId, validateEnv };