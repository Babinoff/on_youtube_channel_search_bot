const { Bot } = require("grammy");
const { logger } = require("./config/logger");
const { env, setGlobalChannelId } = require("./config/env");
const { createYouTubeClient, resolveChannelId, getUploadsPlaylistId, listUploadsVideos, getVideosDetails } = require("./services/youtube/client");
const { searchTopK } = require("./services/vector/lancedb");
const { formatLatestItem, formatSearchItem } = require("./services/telegram/format");
const { deriveType } = require("./services/youtube/classify");
const { getUserSettings, updateUserSettings, resetUserSettings } = require("./services/user/settings_store");
const { getAdminChannels } = require("./services/admin/channels_store");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requireEnvOrWarn(name, ctx) {
  const val = env[name];
  if (!val) {
    const msg = `${name} отсутствует в .env — заполните перед проверкой.`;
    logger.warn(msg);
    if (ctx) ctx.reply(msg);
  }
  return val;
}

// Безопасная отправка длинного текста: разбивает на части по лимиту Telegram (~4096)
function splitTextByLimit(text, maxLen = 3800) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLen, text.length);
    if (end < text.length) {
      // попытка разрыва по \n или пробелу
      let breakPos = text.lastIndexOf("\n", end);
      if (breakPos <= start) breakPos = text.lastIndexOf(" ", end);
      if (breakPos <= start) breakPos = end;
      end = breakPos;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

// Удаляю вспомогательную склейку сообщений, форматирование теперь в services/telegram/format
// function splitItemsIntoMessages(...) { /* removed */ }

// Удаляю локальный truncateForLatest, он теперь в services/telegram/format
// function truncateForLatest(...) { /* removed */ }

async function fetchLatestVideos({ input, limit = 10 }) {
  const client = createYouTubeClient(env.YOUTUBE_API_KEY);
  const channelId = input ? (input.match(/^UC/) ? input : await resolveChannelId(input, client)) : env.YOUTUBE_CHANNEL_ID;
  if (!channelId) throw new Error("Не задан канал: добавьте YOUTUBE_CHANNEL_ID в .env или укажите аргумент.");

  const uploadsId = await getUploadsPlaylistId(channelId, client);
  const page = await listUploadsVideos(uploadsId, client);
  const limitN = Math.max(1, Number(limit) || 1);
  const videoIds = (page.items || []).map(i => i.contentDetails?.videoId).filter(Boolean).slice(0, limitN);
  const details = videoIds.length ? await getVideosDetails(videoIds, client) : [];
  return details.map(v => ({
    id: v.id,
    title: v.snippet?.title || "",
    description: v.snippet?.description || "",
    url: `https://youtu.be/${v.id}`,
    type: deriveType(v),
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

  // Хранилище ожидаемого ввода по кнопкам
  const pendingInputs = new Map(); // key: userId, value: { mode: 'search'|'latest', createdAt: number }

  // Основная клавиатура
  function buildMainKeyboard() {
    return {
      keyboard: [
        [{ text: '🔎 Поиск' }, { text: '🆕 Последние' }],
        [{ text: '⚙️ Настройки' }, { text: 'ℹ️ Помощь' }, { text: 'Отмена' }],
      ],
      resize_keyboard: true,
      is_persistent: true,
      input_field_placeholder: 'Введите запрос или используйте клавиатуру',
    };
  }

  // /start
  bot.command("start", async (ctx) => {
    await ctx.reply("Привет! Я бот для поиска релевантных YouTube‑видео. Попробуйте /help.", { reply_markup: buildMainKeyboard() });
  });

  // /help
  bot.command("help", async (ctx) => {
    await ctx.reply([
      "Команды:",
      "/latest [канал] — показать последние k видео (k из настроек).",
      "Если канал не указан, используется выбранный в настройках (по умолчанию — первый из списка администратора). Глобальная YOUTUBE_CHANNEL_ID всегда равна текущему выбранному каналу.",
      "Поддерживает фильтр типа: /latest [канал] | type=short|stream|video",
      "Примеры: /latest, /latest @handle, /latest https://youtube.com/channel/UC...",
      "/search <запрос> — семантический поиск по локальной таблице LanceDB.",
      "По умолчанию используется выбранный в настройках канал (если есть).",
      "Можно указать порог совпадения: /search <запрос> | threshold=0.75",
      "Количество результатов (k) настраивается кнопками в ⚙️ Настройках",
      "Фильтр типа результата: /search <запрос> | type=short|stream|video",
      "/settings — настроить кнопками: тип выдачи, threshold, k и канал",
      "/threshold <число> — установить глобальный порог (без перезапуска)",
      "\nТакже доступна клавиатура: 'Поиск', 'Последние', 'Настройки' и 'Помощь'."
    ].join("\n"), { reply_markup: buildMainKeyboard() });
  });

  // Кнопка: Поиск
  bot.hears('🔎 Поиск', async (ctx) => {
    pendingInputs.set(ctx.from.id, { mode: 'search', createdAt: Date.now() });
    await ctx.reply('Введите поисковый запрос:', { reply_markup: { force_reply: true } });
  });

  // Кнопка: Последние
  bot.hears('🆕 Последние', async (ctx) => {
    // Показываем сразу последние видео для активного канала
    if (!requireEnvOrWarn('YOUTUBE_API_KEY', ctx)) return;
    const us = getUserSettings(ctx.from?.id);
    const adminChannels = await getAdminChannels();
    if (!adminChannels.length) {
      logger.warn("Список каналов администратора пуст");
      await ctx.reply("Список каналов администратора пуст. Обратитесь к администратору.");
      return;
    }
    const allowedIds = adminChannels.map(c => c.id);
    let inputId = null;
    if (us.channelId && allowedIds.includes(us.channelId)) {
      inputId = us.channelId;
      setGlobalChannelId(inputId);
    } else {
      inputId = allowedIds[0];
      if (!us.channelId || !allowedIds.includes(us.channelId)) {
        updateUserSettings(ctx.from?.id, { channelId: inputId });
      }
      setGlobalChannelId(inputId);
    }
    let typeFilter = us.type || null;
    const limitK = Math.max(1, Number(us.k) || 1);
    const videosRaw = await fetchLatestVideos({ input: inputId, limit: limitK });
    const videos = typeFilter ? videosRaw.filter(v => (v.type || 'video') === typeFilter) : videosRaw;
    if (!videos.length) { await ctx.reply('Видео не найдены.'); return; }
    for (const item of videos.map(v => formatLatestItem(v))) {
      const parts = splitTextByLimit(item, 3800);
      for (const p of parts) { await ctx.reply(p); await sleep(Number(env.TELEGRAM_SEND_DELAY_MS || 0)); }
    }
    // Показать клавиатуру после вывода последних видео
    await ctx.reply('Готово. Выберите действие на клавиатуре.', { reply_markup: buildMainKeyboard() });
  });

  // Обработчик текстового ввода после кнопки "Поиск"
  bot.on('message:text', async (ctx, next) => {
    const state = pendingInputs.get(ctx.from.id);
    if (!state) return next();

    if (state.mode === 'search') {
      const raw = (ctx.message?.text || '').trim();

      // Поддержка отмены из клавиатуры во время ожидания ввода
      if (raw.toLowerCase() === 'отмена') {
        pendingInputs.delete(ctx.from.id);
        await ctx.reply('Отменено. Выберите действие на клавиатуре.', { reply_markup: buildMainKeyboard() });
        return;
      }

      pendingInputs.delete(ctx.from.id);
      let query = raw;
      let k = Math.max(1, Number(getUserSettings(ctx.from.id)?.k) || 1);
       let threshold = getUserSettings(ctx.from.id)?.threshold;
       if (typeof threshold !== 'number') threshold = parseFloat(threshold) || env.SEARCH_MAX_DISTANCE;
       let typeFilter = getUserSettings(ctx.from.id)?.type || null;
 
       // Поддержка параметров через "|"
       if (raw.includes('|')) {
         const parts = raw.split('|').map(p => p.trim()).filter(Boolean);
         query = (parts.shift() || '').trim();
         for (const p of parts) {
           const mT = p.match(/^threshold\s*=\s*([0-9.]+)/i);
           const mType = p.match(/^type\s*=\s*(short|stream|video)/i);
           if (mT) threshold = parseFloat(mT[1]);
           else if (mType) typeFilter = mType[1];
         }
       }

      if (!query) {
        await ctx.reply('Пустой запрос.');
        await ctx.reply('Выберите действие на клавиатуре.', { reply_markup: buildMainKeyboard() });
        return;
      }

      try {
        const us = getUserSettings(ctx.from.id);
        const results = await searchTopK(query, k, { maxDistance: threshold, channelId: us?.channelId });
        const filtered = typeFilter ? results.filter(r => (r.type || 'video') === typeFilter) : results;

        if (!filtered.length) {
          await ctx.reply('Ничего не найдено.');
          await ctx.reply('Выберите действие на клавиатуре.', { reply_markup: buildMainKeyboard() });
          return;
        }

        for (const r of filtered) {
          const item = us?.showScore ? r : { ...r, score: undefined };
          const text = formatSearchItem(item);
          const parts = splitTextByLimit(text, 3800);
          for (const p of parts) {
            await ctx.reply(p);
            await sleep(Number(env.TELEGRAM_SEND_DELAY_MS || 0));
          }
        }
        await ctx.reply('Готово. Выберите действие на клавиатуре.', { reply_markup: buildMainKeyboard() });
      } catch (err) {
        await ctx.reply(`Ошибка поиска: ${err?.message || err}`);
        await ctx.reply('Выберите действие на клавиатуре.', { reply_markup: buildMainKeyboard() });
      }
    }
  });

  // Кнопка: Настройки — показать inline‑клавиатуру с чекбоксами
  bot.hears('⚙️ Настройки', async (ctx) => {
    const userId = ctx.from?.id;
    let s = getUserSettings(userId);
    const channels = await getAdminChannels();
    if (!s.channelId && channels.length) { s = updateUserSettings(userId, { channelId: channels[0].id }); setGlobalChannelId(channels[0].id); }

    const text = [
      'Настройки пользователя:',
      `Тип выдачи: ${s.type || 'не задан'}`,
      `threshold: ${typeof s.threshold === 'number' ? s.threshold.toFixed(2) : s.threshold}`,
      `k: ${s.k}`,
      `score: ${s.showScore ? 'показывать' : 'скрывать'}`,
    ].join('\n');

    await ctx.reply(text, { reply_markup: buildSettingsKeyboard(s, channels) });
  });

  // Кнопка: Помощь — вывести описание и вернуть клавиатуру
  bot.hears('ℹ️ Помощь', async (ctx) => {
    await ctx.reply([
      'Команды:',
      '/latest [канал] — показать последние k видео (k из настроек).',
      'Если канал не указан, используется выбранный в настройках (по умолчанию — первый из списка администратора). Глобальная YOUTUBE_CHANNEL_ID всегда равна текущему выбранному каналу.',
      'Поддерживает фильтр типа: /latest [канал] | type=short|stream|video',
      'Примеры: /latest, /latest @handle, /latest https://youtube.com/channel/UC...',
      '/search <запрос> — семантический поиск по локальной таблице LanceDB.',
      'По умолчанию используется выбранный в настройках канал (если есть).',
      'Можно указать порог совпадения: /search <запрос> | threshold=0.75',
      'Количество результатов (k) настраивается кнопками в ⚙️ Настройках',
      'Фильтр типа результата: /search <запрос> | type=short|stream|video',
      '/settings — настроить кнопками: тип выдачи, threshold, k и канал',
      '/threshold <число> — установить глобальный порог (без перезапуска)',
      '\nТакже доступна клавиатура: "Поиск", "Последние", "Настройки" и "Помощь".'
    ].join('\n'), { reply_markup: buildMainKeyboard() });
  });

  // Кнопка: Отмена — очистить ожидаемый ввод и показать клавиатуру
  bot.hears('Отмена', async (ctx) => {
    pendingInputs.delete(ctx.from.id);
    await ctx.reply('Отменено. Выберите действие на клавиатуре.', { reply_markup: buildMainKeyboard() });
  });

  // Админ: список каналов
  bot.command("channels", async (ctx) => {
    if (env.ADMIN_USER_ID && ctx.from?.id !== env.ADMIN_USER_ID) {
      await ctx.reply('Команда доступна только администратору.');
      return;
    }
    const list = await getAdminChannels();
    if (!list.length) { await ctx.reply('Список каналов пуст.'); return; }
    const lines = list.map((c, i) => `• ${c.title}${c.handle ? ` (${c.handle})` : ''} — ${c.id}`);
    const text = ['Каналы (админ):', ...lines].join('\n');
    for (const part of splitTextByLimit(text, 3800)) {
      await ctx.reply(part);
    }
  });

  // Админ: добавить канал
  bot.command("add_channel", async (ctx) => {
    if (env.ADMIN_USER_ID && ctx.from?.id !== env.ADMIN_USER_ID) {
      await ctx.reply('Команда доступна только администратору.');
      return;
    }
    await ctx.reply('Список каналов управляется через .env (YOUTUBE_CHANNELS_ID). Команда отключена.');
  });

  // Админ: удалить канал
  bot.command("remove_channel", async (ctx) => {
    if (env.ADMIN_USER_ID && ctx.from?.id !== env.ADMIN_USER_ID) {
      await ctx.reply('Команда доступна только администратору.');
      return;
    }
    await ctx.reply('Список каналов управляется через .env (YOUTUBE_CHANNELS_ID). Команда отключена.');
  });

  // Обработчик callback кнопок
  bot.on("callback_query:data", async (ctx) => {
    const userId = ctx.from?.id;
    const data = ctx.callbackQuery?.data || "";
    let s = getUserSettings(userId);
    const channels = await getAdminChannels();
    if (!s.channelId && channels.length) { s = updateUserSettings(userId, { channelId: channels[0].id }); setGlobalChannelId(channels[0].id); }

    try {
      if (data.startsWith("set_type:")) {
        const t = data.split(":")[1];
        const type = t === "none" ? null : (t === "short" || t === "stream" || t === "video" ? t : null);
        s = updateUserSettings(userId, { type });
        await ctx.answerCallbackQuery({ text: `Тип: ${type || 'не задан'}` });
      } else if (data.startsWith("set_threshold:")) {
        const stepStr = data.split(":")[1];
        const step = parseFloat(stepStr);
        const cur = typeof s.threshold === 'number' ? s.threshold : parseFloat(s.threshold) || 0.75;
        let next = cur + step;
        // Ограничим разумные пределы [0.3 .. 1.5]
        next = Math.max(0.3, Math.min(1.5, next));
        s = updateUserSettings(userId, { threshold: next });
        await ctx.answerCallbackQuery({ text: `threshold: ${next.toFixed(2)}` });
      } else if (data.startsWith("set_k:")) {
        const deltaStr = data.split(":")[1];
        const delta = parseInt(deltaStr, 10);
        const maxK = Number(env.SEARCH_MAX_K || 20);
        const cur = Number(s.k || 0) || 1;
        let next = cur + (Number.isFinite(delta) ? delta : 0);
        next = Math.max(1, Math.min(maxK, next));
        s = updateUserSettings(userId, { k: next });
        await ctx.answerCallbackQuery({ text: `k: ${next}/${maxK}` });
      } else if (data === "toggle:score") {
        s = updateUserSettings(userId, { showScore: !s.showScore });
        await ctx.answerCallbackQuery({ text: s.showScore ? 'Показывать score' : 'Скрывать score' });
      } else if (data === "reset:all") {
        s = resetUserSettings(userId);
        if (!s.channelId && channels.length) {
          s = updateUserSettings(userId, { channelId: channels[0].id });
          setGlobalChannelId(channels[0].id);
        }
        await ctx.answerCallbackQuery({ text: 'Настройки сброшены' });
      } else if (data.startsWith("set_channel:")) {
        const cid = data.split(":")[1];
        if (cid === 'none') {
          const firstId = channels[0]?.id;
          if (firstId) {
            s = updateUserSettings(userId, { channelId: firstId });
            setGlobalChannelId(firstId);
            await ctx.answerCallbackQuery({ text: 'Выбран первый канал' });
          } else {
            await ctx.answerCallbackQuery({ text: 'Список каналов пуст' });
          }
        } else {
          const allowedIds = channels.map(c => c.id);
          if (!allowedIds.includes(cid)) {
            await ctx.answerCallbackQuery({ text: 'Канал не разрешён администратором' });
          } else {
            s = updateUserSettings(userId, { channelId: cid });
            setGlobalChannelId(cid);
            await ctx.answerCallbackQuery({ text: 'Канал выбран' });
          }
        }
      } else {
        await ctx.answerCallbackQuery();
      }

      const text = [
        "Настройки пользователя:",
        `Тип выдачи: ${s.type || 'не задан'}`,
        `threshold: ${typeof s.threshold === 'number' ? s.threshold.toFixed(2) : s.threshold}`,
        `k: ${s.k}`,
        `score: ${s.showScore ? 'показывать' : 'скрывать'}`,
      ].join("\n");

      // Обновляем текст и клавиатуру
      try {
        await ctx.editMessageText(text, { reply_markup: buildSettingsKeyboard(s, channels) });
      } catch {
        // Если нельзя редактировать (например, старое сообщение) — отправим новое
        await ctx.reply(text, { reply_markup: buildSettingsKeyboard(s, channels) });
      }
    } catch (err) {
      await ctx.answerCallbackQuery({ text: 'Ошибка' });
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


function buildSettingsKeyboard(s, channels) {
  const typeRow = [
    { text: `Shorts${s.type === 'short' ? ' ✅' : ''}`, callback_data: 'set_type:short' },
    { text: `Stream${s.type === 'stream' ? ' ✅' : ''}`, callback_data: 'set_type:stream' },
    { text: `Video${s.type === 'video' ? ' ✅' : ''}`, callback_data: 'set_type:video' },
    { text: `${s.type ? 'Сброс' : '—'}`, callback_data: 'set_type:none' },
  ];

  const thr = typeof s.threshold === 'number' ? s.threshold : parseFloat(s.threshold) || 0.75;
  const thrRow = [
    { text: 'threshold -0.05', callback_data: 'set_threshold:-0.05' },
    { text: `threshold ${thr.toFixed(2)}`, callback_data: 'noop' },
    { text: 'threshold +0.05', callback_data: 'set_threshold:+0.05' },
  ];

  const maxK = Number(env.SEARCH_MAX_K || 20);
  const curK = Number(s.k || 0) || 1;
  const kRow = [
    { text: 'k -5', callback_data: 'set_k:-5' },
    { text: `k ${curK}/${maxK}`, callback_data: 'noop' },
    { text: 'k +5', callback_data: 'set_k:+5' },
  ];

  const channelRows = [];
  for (let i = 0; i < channels.length; i += 2) {
    const a = channels[i];
    const b = channels[i + 1];
    const row = [];
    if (a) row.push({ text: `${s.channelId === a.id ? '✅ ' : ''}${a.title}`, callback_data: `set_channel:${a.id}` });
    if (b) row.push({ text: `${s.channelId === b.id ? '✅ ' : ''}${b.title}`, callback_data: `set_channel:${b.id}` });
    if (row.length) channelRows.push(row);
  }

  const miscRow = [
    { text: `${s.showScore ? 'Скрыть score' : 'Показывать score'}`, callback_data: 'toggle:score' },
    { text: 'Сбросить всё', callback_data: 'reset:all' },
  ];

  return { inline_keyboard: [typeRow, thrRow, kRow, ...channelRows, miscRow] };
}