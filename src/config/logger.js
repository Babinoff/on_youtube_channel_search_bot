const pino = require("pino");
const { env } = require("./env");
const fs = require("fs");
const path = require("path");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

function getActiveChannelIdSync() {
  try {
    const settingsPath = path.resolve(process.cwd(), "data/server/settings.json");
    if (!fs.existsSync(settingsPath)) return undefined;
    const raw = fs.readFileSync(settingsPath, "utf8");
    const json = JSON.parse(raw);
    const id = json?.activeChannelId;
    return typeof id === "string" && id ? id : undefined;
  } catch (_) {
    return undefined;
  }
}

function getLoggerCtx(ctx, extra = {}) {
  const base = {};
  try {
    const uid = ctx?.from?.id;
    if (uid) base.userId = uid;
  } catch {}
  const activeId = getActiveChannelIdSync();
  if (activeId) base.channelId = activeId;
  return logger.child({ ...base, ...extra });
}

module.exports = { logger, getLoggerCtx };