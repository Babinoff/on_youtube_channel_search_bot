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
  EMBEDDINGS_PROVIDER: process.env.EMBEDDINGS_PROVIDER || "xenova",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  VECTOR_DB: process.env.VECTOR_DB || "lancedb",
  LANCEDB_DIR: process.env.LANCEDB_DIR || "./data/lancedb",
  DATABASE_URL: process.env.DATABASE_URL || "./data/db.sqlite",
  require: (name) => requireEnv(name),
};

module.exports = { env };