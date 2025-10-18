const { Bot } = require("grammy");
const { logger } = require("./config/logger");
const { env } = require("./config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("./services/youtube/client");

function requireEnvOrWarn(name, ctx) {
  const val = env[name];
  if (!val) {
    const msg = `${name} отсутствует в .env — заполните перед проверкой.`;
    logger.warn(msg);
    if (ctx) ctx.reply(msg);
  }
  return val;
}

async function fetchLatestVideos({ input, limit = 5 }) {
  const client = createYouTubeClient(env.YOUTUBE_API_KEY);
  const channelId = input ? (input.match(/^UC/) ? input : await resolveChannelId(input, client)) : env.YOUTUBE_CHANNEL_ID;
  if (!channelId) throw new Error("Не задан канал: добавьте YOUTUBE_CHANNEL_ID в .env или укажите аргумент.");

  const uploadsId = await getUploadsPlaylistId(channelId, client);
  const page = await listUploadsVideos(uploadsId, client);
  const videoIds = (page.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
  const details = videoIds.length ? await getVideosDetails(videoIds.slice(0, limit), client) : [];

  return details.map(v => {
    const id = v.id;
    const title = v.snippet?.title || "(без названия)";
    const description = (v.snippet?.description || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    const publishedAt = v.snippet?.publishedAt || "";
    const url = `https://youtu.be/${id}`;
    return { id, title, description, publishedAt, url };
  });
}

async function main() {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN отсутствует — заполните .env");
    process.exit(1);
  }
  if (!env.YOUTUBE_API_KEY) {
    logger.warn("YOUTUBE_API_KEY отсутствует — команда /latest работать не будет");
  }

  const bot = new Bot(token);

  // /start
  bot.command("start", async (ctx) => {
    await ctx.reply("Привет! Я бот для поиска релевантных YouTube‑видео. Попробуйте /help.");
  });

  // /help
  bot.command("help", async (ctx) => {
    await ctx.reply([
      "Команды:",
      "/latest [канал] — показать последние видео канала.",
      "Если канал не указан, используется YOUTUBE_CHANNEL_ID из .env.",
      "Примеры: /latest, /latest @handle, /latest https://youtube.com/channel/UC...",
    ].join("\n"));
  });

  // /latest
  bot.command("latest", async (ctx) => {
    try {
      if (!requireEnvOrWarn("YOUTUBE_API_KEY", ctx)) return;
      const text = ctx.message?.text || "";
      const arg = text.split(" ").slice(1).join(" ").trim();
      const input = arg || env.YOUTUBE_CHANNEL_ID;
      const videos = await fetchLatestVideos({ input, limit: 5 });
      if (!videos.length) {
        await ctx.reply("Видео не найдены.");
        return;
      }
      const lines = videos.map(v => {
        const desc = v.description ? `\n${v.description}` : "";
        return `${v.title}\n${v.url}${desc}`;
      });
      await ctx.reply(lines.join("\n\n"));
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err.message || "Ошибка при получении видео";
      logger.error({ err: msg }, "Ошибка /latest");
      await ctx.reply(`Ошибка: ${msg}`);
    }
  });

  // Запуск polling
  logger.info("Запускаю бота (polling)…");
  bot.start();

  // Корректное завершение
  process.once("SIGINT", () => {
    logger.info("SIGINT — останавливаю бота");
    bot.stop();
  });
  process.once("SIGTERM", () => {
    logger.info("SIGTERM — останавливаю бота");
    bot.stop();
  });
}

main().catch((err) => {
  logger.error({ err: err?.message }, "Фатальная ошибка запуска бота");
  process.exit(1);
});