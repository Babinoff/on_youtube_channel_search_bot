const pino = require("pino");
const { env } = require("./env");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

function getLoggerCtx(ctx, extra = {}) {
  const base = {};
  try {
    const uid = ctx?.from?.id;
    if (uid) base.userId = uid;
  } catch {}
  if (env.YOUTUBE_CHANNEL_ID) base.channelId = env.YOUTUBE_CHANNEL_ID;
  return logger.child({ ...base, ...extra });
}

module.exports = { logger, getLoggerCtx };