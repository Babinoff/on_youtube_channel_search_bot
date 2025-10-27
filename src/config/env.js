const fs = require("fs");
const path = require("path");

function loadEnvFile() {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, "utf8");
    const lines = content.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const cleaned = line.startsWith("export ") ? line.slice(7) : line;
      const eq = cleaned.indexOf("=");
      if (eq === -1) continue;
      const key = cleaned.slice(0, eq).trim();
      let val = cleaned.slice(eq + 1).trim();
      if (!key) continue;
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch (_) {
    // keep silent
  }
}

loadEnvFile();

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    throw new Error(`Missing required env: ${name}`);
  }
  return val;
}

function parseBool(input, defaultVal = false) {
  const s = String(input ?? (defaultVal ? "true" : "false")).toLowerCase();
  if (["1","true","yes","on"].includes(s)) return true;
  if (["0","false","no","off"].includes(s)) return false;
  return defaultVal;
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  ADMIN_USER_ID: process.env.ADMIN_USER_ID ? Number(process.env.ADMIN_USER_ID) : undefined,
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
  YOUTUBE_CHANNEL_ID: process.env.YOUTUBE_CHANNEL_ID || "",
  YOUTUBE_CHANNELS_ID: process.env.YOUTUBE_CHANNELS_ID || "",
  YOUTUBE_CHANNEL_URL: process.env.YOUTUBE_CHANNEL_URL || "",
  YOUTUBE_CHANNEL_HANDLE: process.env.YOUTUBE_CHANNEL_HANDLE || "",
  EMBEDDINGS_PROVIDER: process.env.EMBEDDINGS_PROVIDER || "xenova",
  EMBEDDINGS_PROVIDER_CHAIN: process.env.EMBEDDINGS_PROVIDER_CHAIN || "",
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  VECTOR_DB: process.env.VECTOR_DB || "lancedb",
  LANCEDB_DIR: process.env.LANCEDB_DIR || "./data/lancedb",
  DATABASE_URL: process.env.DATABASE_URL || "./data/db.sqlite",

  // Ollama local provider
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || "embeddinggemma",

  // Embeddings provider tuning
  EMBEDDINGS_MAX_CONCURRENCY: Number(process.env.EMBEDDINGS_MAX_CONCURRENCY || 1),
  EMBEDDINGS_CACHE_SIZE: Number(process.env.EMBEDDINGS_CACHE_SIZE || 200),
  EMBEDDINGS_BATCH_SIZE: Number(process.env.EMBEDDINGS_BATCH_SIZE || 8),
  EMBEDDINGS_MAX_ATTEMPTS: Number(process.env.EMBEDDINGS_MAX_ATTEMPTS || 5),
  EMBEDDINGS_TIMEOUT_MS: Number(process.env.EMBEDDINGS_TIMEOUT_MS || 30000),
  EMBEDDINGS_MAX_CHUNK_LEN: Number(process.env.EMBEDDINGS_MAX_CHUNK_LEN || 1000),
  EMBEDDINGS_CHUNK_OVERLAP: Number(process.env.EMBEDDINGS_CHUNK_OVERLAP || 200),
  // Строгая валидация и поведение при невалидном векторе
  EMBEDDINGS_STRICT_VALIDATION: parseBool(process.env.EMBEDDINGS_STRICT_VALIDATION, true),
  EMBEDDINGS_ON_INVALID: process.env.EMBEDDINGS_ON_INVALID || 'mark', // 'skip' | 'mark'
  EMBEDDINGS_MIN_DIMS: Number(process.env.EMBEDDINGS_MIN_DIMS || 256),

  // Search thresholds and ranges
  SEARCH_MAX_DISTANCE: Number(process.env.SEARCH_MAX_DISTANCE || 0.7),

  // Unified description length limit for both display and indexing
  DESC_MAX_CHARS: Number(process.env.DESC_MAX_CHARS || 500),
  // Messaging: delay between Telegram messages to avoid rate limits
  TELEGRAM_SEND_DELAY_MS: Number(process.env.TELEGRAM_SEND_DELAY_MS || 250),

  // Search defaults
  SEARCH_TOP_K: Number(process.env.SEARCH_TOP_K || 5),
  // Enable/disable query text normalization before embedding
  SEARCH_NORMALIZE_QUERY: parseBool(process.env.SEARCH_NORMALIZE_QUERY, true),
  // Adaptive search tuning
  SEARCH_ADAPTIVE_ITERS: Number(process.env.SEARCH_ADAPTIVE_ITERS || 3),
  SEARCH_ADAPTIVE_STEP: Number(process.env.SEARCH_ADAPTIVE_STEP || 0.5),
  SEARCH_MAX_K: Number(process.env.SEARCH_MAX_K || 20),
  // Фильтровать записи с invalid_vector в обычном поиске
  SEARCH_FILTER_INVALID_EMBEDS: parseBool(process.env.SEARCH_FILTER_INVALID_EMBEDS, true),

  // YouTube shorts classification
  SHORTS_MAX_SECONDS: Number(process.env.SHORTS_MAX_SECONDS || 60),

  // Description normalization patterns
  INDEX_DESC_AD_LINE_PREFIX_CHARS: process.env.INDEX_DESC_AD_LINE_PREFIX_CHARS || '•,+,*,—,–,-,►,➡,→,➜',
  INDEX_DESC_STRIP_AFTER_PATTERNS: process.env.INDEX_DESC_STRIP_AFTER_PATTERNS || 'https,📺 Больше контента здесь:,ПОДДЕРЖАТЬ НАС МОЖНО,+++,По вопросам сотрудничества,подписывайтесь,subscribe,донат,donate,patreon,boosty,ссылки,links',

  // Indexing flow controls
  INDEX_STOP_ON_FIRST_KNOWN: parseBool(process.env.INDEX_STOP_ON_FIRST_KNOWN, false),
  LANCEDB_INSERT_BATCH_SIZE: Number(process.env.LANCEDB_INSERT_BATCH_SIZE || 50),
  LANCEDB_INSERT_MAX_ATTEMPTS: Number(process.env.LANCEDB_INSERT_MAX_ATTEMPTS || 3),

  // Compatibility helper
  require: (name) => requireEnv(name),
};

function setGlobalChannelId(id) {
  env.YOUTUBE_CHANNEL_ID = id || undefined;
}

function validateEnv() {
  const errors = [];
  const warnings = [];

  // Required tokens
  if (!env.TELEGRAM_BOT_TOKEN) {
    errors.push("TELEGRAM_BOT_TOKEN отсутствует — заполните .env");
  }
  if (!env.YOUTUBE_API_KEY) {
    warnings.push("YOUTUBE_API_KEY отсутствует — функции YouTube (🆕 Последние, индексация) недоступны");
  }

  // Search ranges
  if (!Number.isFinite(env.SEARCH_MAX_K) || env.SEARCH_MAX_K < 1) {
    errors.push("SEARCH_MAX_K должен быть положительным числом (>= 1)");
  }
  if (!Number.isFinite(env.SEARCH_MAX_DISTANCE) || env.SEARCH_MAX_DISTANCE <= 0 || env.SEARCH_MAX_DISTANCE > 2) {
    warnings.push("SEARCH_MAX_DISTANCE вне типичного диапазона (ожидается 0 < x ≤ 2)");
  }

  // Messaging rate limits
  if (!Number.isFinite(env.TELEGRAM_SEND_DELAY_MS) || env.TELEGRAM_SEND_DELAY_MS < 0) {
    warnings.push("TELEGRAM_SEND_DELAY_MS должен быть неотрицательным числом");
  }

  // Embeddings provider sanity
  const provider = String(env.EMBEDDINGS_PROVIDER || "").toLowerCase();
  const knownProviders = ["xenova", "mistral", "openai", "google", "embeddinggemma"];
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

  // Shorts classification
  if (!Number.isFinite(env.SHORTS_MAX_SECONDS) || env.SHORTS_MAX_SECONDS <= 0) {
    warnings.push("SHORTS_MAX_SECONDS не задан, используется 60");
  }

  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { env, setGlobalChannelId, validateEnv, requireEnv };