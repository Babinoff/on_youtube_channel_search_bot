const { Bot } = require("grammy");
const { logger } = require("./config/logger");
const { env } = require("./config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("./services/youtube/client");
const { searchTopK } = require("./services/vector/lancedb");

function requireEnvOrWarn(name, ctx) {
  const val = env[name];
  if (!val) {
    const msg = `${name} отсутствует в .env — заполните перед проверкой.`;
    logger.warn(msg);
    if (ctx) ctx.reply(msg);
  }
  return val;
}

async function fetchLatestVideos({ input, limit = 10 }) {
  const client = createYouTubeClient(env.YOUTUBE_API_KEY);
  const channelId = input ? (input.match(/^UC/) ? input : await resolveChannelId(input, client)) : env.YOUTUBE_CHANNEL_ID;
  if (!channelId) throw new Error("Не задан канал: добавьте YOUTUBE_CHANNEL_ID в .env или укажите аргумент.");

  const uploadsId = await getUploadsPlaylistId(channelId, client);
  const page = await listUploadsVideos(uploadsId, client);
  const videoIds = (page.items || []).map(i => i.contentDetails?.videoId).filter(Boolean).slice(0, limit);
  const details = videoIds.length ? await getVideosDetails(videoIds, client) : [];
  return details.map(v => ({
    id: v.id,
    title: v.snippet?.title || "",
    description: v.snippet?.description || "",
    url: `https://youtu.be/${v.id}`,
  }));
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
      "/latest [канал] — показать последние 10 видео канала.",
      "Если канал не указан, используется YOUTUBE_CHANNEL_ID из .env.",
      "Примеры: /latest, /latest @handle, /latest https://youtube.com/channel/UC...",
      "/search <запрос> — семантический поиск по локальной таблице LanceDB.",
      "Можно указать порог совпадения: /search <запрос> | threshold=0.75",
      "/threshold <число> — установить глобальный порог (без перезапуска)",
    ].join("\n"));
  });

  // /latest
  bot.command("latest", async (ctx) => {
    try {
      if (!requireEnvOrWarn("YOUTUBE_API_KEY", ctx)) return;
      const text = ctx.message?.text || "";
      const arg = text.split(" ").slice(1).join(" ").trim();
      const input = arg || env.YOUTUBE_CHANNEL_ID;
      const videos = await fetchLatestVideos({ input, limit: 10 });
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

  // /search
  bot.command("search", async (ctx) => {
    try {
      if (!requireEnvOrWarn("MISTRAL_API_KEY", ctx)) return;
      const text = ctx.message?.text || "";
      const raw = text.split(" ").slice(1).join(" ").trim();
      if (!raw) {
        await ctx.reply("Использование: /search <запрос> | threshold=0.75");
        return;
      }
      // Позволяем указать порог через суффикс "| threshold=0.75"
      const parts = raw.split("|");
      const query = parts[0].trim();
      let maxDistance = env.SEARCH_MAX_DISTANCE;
      const extra = parts[1] && parts[1].trim();
      if (extra) {
        const m = extra.match(/threshold\s*=\s*([0-9]*\.?[0-9]+)/i);
        if (m) {
          const v = parseFloat(m[1]);
          if (!Number.isNaN(v)) maxDistance = v;
        }
      }

      const results = await searchTopK(query, 5, { maxDistance });
      if (!results.length) {
        await ctx.reply(`Нет результатов при пороге ${maxDistance}. Попробуйте изменить threshold или другой запрос.`);
        return;
      }
      const lines = results.map(r => `${r.index}. ${r.title}\n${r.url}${r.score !== undefined ? `\nscore: ${r.score}` : ""}`);
      await ctx.reply(lines.join("\n\n"));
    } catch (err) {
      const msg = err?.response?.data?.error?.message || err.message || "Ошибка при поиске";
      logger.error({ err: msg }, "Ошибка /search");
      await ctx.reply(`Ошибка: ${msg}`);
    }
  });

  // Команда для установки глобального порога
  bot.command("threshold", async (ctx) => {
    const text = ctx.message?.text || "";
    const m = text.match(/\/threshold\s+([0-9]*\.?[0-9]+)/i);
    if (!m) {
      return ctx.reply("Использование: /threshold <число>. Пример: /threshold 0.75");
    }
    const v = parseFloat(m[1]);
    if (Number.isNaN(v)) return ctx.reply("Некорректное число.");
    env.SEARCH_MAX_DISTANCE = v;
    return ctx.reply(`Глобальный порог обновлён: ${v}`);
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