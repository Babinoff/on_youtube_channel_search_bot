const { Bot } = require("grammy");
const { logger, getLoggerCtx } = require("./config/logger");
const { env, setGlobalChannelId, validateEnv } = require("./config/env");

const { searchUnified } = require("./services/vector/search");
const { splitTextByLimit, formatLatestItem, formatSearchItem } = require("./services/telegram/format");
const { buildSettingsKeyboard, buildMainKeyboard } = require("./services/telegram/keyboards");

const { fetchLatestVideos } = require("./services/youtube/latest");
const { ACTIONS, parse } = require("./services/telegram/callbacks");
const { getUserSettings, updateUserSettings, resetUserSettings } = require("./services/user/settings_store");
const { setPendingInput, getPendingInput, clearPendingInput, hasPendingInput } = require("./services/telegram/state");
const { getAdminChannels } = require("./services/admin/channels_store");
const { applyAdminCommands } = require("./services/admin/router");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ранняя проверка окружения
const validation = validateEnv();
if (!validation.ok) {
  logger.error("Остановка: ошибки окружения");
  process.exit(1);
}

function requireEnvOrWarn(name, ctx) {
  const val = env[name];
  if (!val) {
    const msg = `${name} отсутствует в .env — заполните перед проверкой.`;
    logger.warn(msg);
    if (ctx) ctx.reply(msg);
  }
  return val;
}



// Удаляю вспомогательную склейку сообщений, форматирование теперь в services/telegram/format
// function splitItemsIntoMessages(...) { /* removed */ }

// Удаляю локальный truncateForLatest, он теперь в services/telegram/format
// function truncateForLatest(...) { /* removed */ }

// fetchLatestVideos moved to services/youtube/latest.js

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
  const defaultMessage = "Можно запускать следующий поиск.";
  applyAdminCommands(bot);



  // /start
  bot.command("start", async (ctx) => {
    await ctx.reply("Привет! Я бот для поиска релевантных YouTube‑видео. Попробуйте /help.", { reply_markup: buildMainKeyboard() });
  });

  // /help
  bot.command("help", async (ctx) => {
    await ctx.reply([
      "Как пользоваться ботом через клавиатуру:",
      "• \"🔎 Поиск\" — введите текст запроса; количество результатов (k) берётся из ⚙️ Настроек.",
      "• \"🆕 Последние\" — показывает последние k видео выбранного канала (канал берётся из ⚙️ Настроек).",
      "• \"⚙️ Настройки\" — управление типом выдачи (short/stream/video), количеством результатов (k) и выбором канала.",
      "• \"ℹ️ Помощь\" — выводит эту подсказку и возвращает клавиатуру."
    ].join("\n"), { reply_markup: buildMainKeyboard() });
  });

  // Кнопка: Поиск
  bot.hears('🔎 Поиск', async (ctx) => {
    setPendingInput(ctx.from.id, { mode: 'search', createdAt: Date.now() });
    await ctx.reply('Введите поисковый запрос:', { reply_markup: { force_reply: true } });
  });

  // Кнопка: Последние
  bot.hears('🆕 Последние', async (ctx) => {
    // Показываем сразу последние видео для активного канала
    if (!requireEnvOrWarn('YOUTUBE_API_KEY', ctx)) return;
    const us = getUserSettings(ctx.from?.id);
    const adminChannels = await getAdminChannels();
    const logLatest = getLoggerCtx(ctx, { action: 'latest' });
    if (!adminChannels.length) {
      logLatest.warn("Список каналов администратора пуст");
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
    logLatest.info({ channelId: inputId, k: limitK, type: typeFilter }, `Запрос последних видео: channel=${inputId} k=${limitK} type=${typeFilter || 'none'}`);
    const videos = await fetchLatestVideos({ input: inputId, limit: limitK, type: typeFilter });
    if (!videos.length) { await ctx.reply('Видео не найдены.'); return; }
    for (const item of videos.map(v => formatLatestItem(v))) {
      const parts = splitTextByLimit(item, 3800);
      for (const p of parts) { await ctx.reply(p); await sleep(Number(env.TELEGRAM_SEND_DELAY_MS || 0)); }
    }
    // Показать клавиатуру после вывода последних видео
    await ctx.reply(`Готово. Показано ${videos.length} видео. ${defaultMessage}`, { reply_markup: buildMainKeyboard() });
  });

  // Обработчик текстового ввода после кнопки "Поиск"
  bot.on('message:text', async (ctx, next) => {
    const state = getPendingInput(ctx.from.id);
    if (!state) return next();

    if (state.mode === 'search') {
      const raw = (ctx.message?.text || '').trim();

      // Поддержка отмены из клавиатуры во время ожидания ввода
      if (raw.toLowerCase() === 'отмена') {
        clearPendingInput(ctx.from.id);
        await ctx.reply('Отменено. ' + defaultMessage, { reply_markup: buildMainKeyboard() });
        return;
      }

      clearPendingInput(ctx.from.id);
      let query = raw;
      let k = Math.max(1, Number(getUserSettings(ctx.from.id)?.k) || 1);
      const threshold = Number(env.SEARCH_MAX_DISTANCE);
      let typeFilter = getUserSettings(ctx.from.id)?.type || null;

      // Поддержка параметров через "|"
      if (raw.includes('|')) {
        const parts = raw.split('|').map(p => p.trim()).filter(Boolean);
        query = (parts.shift() || '').trim();
        for (const p of parts) {
          const mType = p.match(/^type\s*=\s*(short|stream|video)/i);
          if (mType) typeFilter = mType[1];
        }
      }

      if (!query) {
        await ctx.reply('Пустой запрос.');
        await ctx.reply(defaultMessage, { reply_markup: buildMainKeyboard() });
        return;
      }

      // Сообщение ожидания и индикатор набора
      const waitMsg = await ctx.reply('Идёт поиск… Сервер размышляет…');
      const typingTimer = setInterval(() => {
        ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
      }, 4500);

      try {
        const us = getUserSettings(ctx.from.id);
        const logSearch = getLoggerCtx(ctx, { action: 'search' });
        logSearch.info({ query, k, type: typeFilter, channelId: us?.channelId }, `Запрос поиска: "${query}" | k=${k} type=${typeFilter || 'none'}`);
        const results = await searchUnified(query, k, { channelId: us?.channelId, type: typeFilter });

        if (!results.length) {
          clearInterval(typingTimer);
          try { await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, 'Ничего не найдено.'); } catch {}
          await ctx.reply(defaultMessage, { reply_markup: buildMainKeyboard() });
          return;
        }

        for (const [i, r] of results.entries()) {
          const base = { ...r, index: i + 1 };
          const item = us?.showScore ? base : { ...base, score: undefined };
          const text = formatSearchItem(item);
          const parts = splitTextByLimit(text, 3800);
          for (const p of parts) {
            await ctx.reply(p);
            await sleep(Number(env.TELEGRAM_SEND_DELAY_MS || 0));
          }
        }
        clearInterval(typingTimer);
        try { await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, 'Готово.'); } catch {}
        await ctx.reply(`Готово. Показано ${results.length} видео. ${defaultMessage}`, { reply_markup: buildMainKeyboard() });
      } catch (err) {
        clearInterval(typingTimer);
        try { await ctx.api.editMessageText(ctx.chat.id, waitMsg.message_id, 'Ошибка поиска'); } catch {}
        const logSearch = getLoggerCtx(ctx, { action: 'search' });
        logSearch.error({ err: err?.message || err }, `Ошибка поиска: "${query}" | k=${k} type=${typeFilter || 'none'}`);
        await ctx.reply(`Ошибка поиска: ${err?.message || err}`);
        await ctx.reply(defaultMessage, { reply_markup: buildMainKeyboard() });
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
      `k: ${s.k}`,
      `score: ${s.showScore ? 'показывать' : 'скрывать'}`,
    ].join('\n');

    await ctx.reply(text, { reply_markup: buildSettingsKeyboard(s, channels) });
  });

  // Кнопка: Помощь — вывести описание и вернуть клавиатуру
  bot.hears('ℹ️ Помощь', async (ctx) => {
    await ctx.reply([
      'Как пользоваться ботом через клавиатуру:',
      '• "🔎 Поиск" — введите запрос; количество результатов (k) берётся из ⚙️ Настроек.',
      '• "🆕 Последние" — показывает последние k видео выбранного канала.',
      '• "⚙️ Настройки" — настройка типа выдачи, k и канала.',
      '• "ℹ️ Помощь" — краткая справка.',
      '• "Отмена" — сброс ожидаемого ввода.',
      '\nПодсказка: k настраивается кнопками в ⚙️ Настройках; максимум ограничен SEARCH_MAX_K.'
    ].join('\n'), { reply_markup: buildMainKeyboard() });
  });

  // Кнопка: Отмена — очистить ожидаемый ввод и показать клавиатуру
  bot.hears('Отмена', async (ctx) => {
    clearPendingInput(ctx.from.id);
    await ctx.reply('Отменено. ' + defaultMessage, { reply_markup: buildMainKeyboard() });
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

  // Скрытая команда для администратора: список админ-команд
  bot.command("admin", async (ctx) => {
    const isAdmin = env.ADMIN_USER_ID ? String(ctx.from?.id) === String(env.ADMIN_USER_ID) : false;
    if (!isAdmin) {
      return; // Ничего не показываем для не-админов
    }

    const adminHelp = [
      'Админ-команды (запуск служебных скриптов):',
      '• /lock_status [name] — показать статус блокировок.',
      '• /lock_force [name] [--force] — принудительно снять блокировку.',
      '• /channel_stats [@handle|channelId] — статистика по каналам (LanceDB).',
      '• /channel_count [@handle|channelId] — количество видео в канале.',
      '• /channel_db_list — список таблиц в LanceDB.',
      '• /channel_db_delete <@handle|channelId> --yes — удалить таблицу канала.',
      '• /check_youtube [@handle|channelId] — проверка YouTube API.',
      '• /index_latest [@handle|channelId] — индексировать последние 10 видео.',
      '• /index_batch [@handle|channelId] [--limit N] [--stop-on-first-known on|off] — массовая индексация.',
      '• /preview_latest — предпросмотр последних 10 видео (только .env).',
      '• /search_latest <query> — тест семантического поиска.',
      '• /env_check — проверка окружения.',
      '',
      'Примеры:',
      '• /index_latest @handle',
      '• /index_batch @handle --limit 100 --stop-on-first-known on',
      '• /channel_db_delete @handle --yes',
    ].join('\n');

    await ctx.reply(adminHelp);
  });

  // Catch‑all: только неизвестные сообщения вне режима ввода — показать основное меню
  const knownButtons = new Set(['🔎 Поиск', '🆕 Последние', '⚙️ Настройки', 'ℹ️ Помощь', 'Отмена']);
  bot.on('message', async (ctx) => {
    const txt = ctx.message?.text;
    if (typeof txt === 'string' && knownButtons.has(txt)) return;
    if (hasPendingInput(ctx.from.id)) return;
    await ctx.reply(defaultMessage, { reply_markup: buildMainKeyboard() });
  });

  // Обработчик callback кнопок
  bot.on("callback_query:data", async (ctx) => {
    const userId = ctx.from?.id;
    const data = ctx.callbackQuery?.data || "";
    const { action, value } = parse(data);
    let s = getUserSettings(userId);
    const channels = await getAdminChannels();
    if (!s.channelId && channels.length) { s = updateUserSettings(userId, { channelId: channels[0].id }); setGlobalChannelId(channels[0].id); }
    const logSettings = getLoggerCtx(ctx, { action: 'settings' });

    try {
      if (action === ACTIONS.SET_TYPE) {
        const type = value === "none" ? null : (value === "short" || value === "stream" || value === "video" ? value : null);
        s = updateUserSettings(userId, { type });
        logSettings.info({ action, value: type }, `Настройки: SET_TYPE -> ${type || 'none'}`);
        await ctx.answerCallbackQuery({ text: `Тип: ${type || 'не задан'}` });
      } else if (action === ACTIONS.SET_K) {
        const delta = parseInt(value, 10);
        const maxK = Number(env.SEARCH_MAX_K || 20);
        const cur = Number(s.k || 0) || 1;
        let next = cur + (Number.isFinite(delta) ? delta : 0);
        next = Math.max(1, Math.min(maxK, next));
        s = updateUserSettings(userId, { k: next });
        logSettings.info({ action, delta, from: cur, to: next, maxK }, `Настройки: SET_K -> ${next}/${maxK} (delta=${delta})`);
        await ctx.answerCallbackQuery({ text: `k: ${next}/${maxK}` });
      } else if (action === ACTIONS.TOGGLE && value === 'score') {
        s = updateUserSettings(userId, { showScore: !s.showScore });
        logSettings.info({ action, showScore: s.showScore }, `Настройки: TOGGLE score -> ${s.showScore ? 'on' : 'off'}`);
        await ctx.answerCallbackQuery({ text: s.showScore ? 'Показывать score' : 'Скрывать score' });
      } else if (action === ACTIONS.RESET && value === 'all') {
        s = resetUserSettings(userId);
        if (!s.channelId && channels.length) {
          s = updateUserSettings(userId, { channelId: channels[0].id });
          setGlobalChannelId(channels[0].id);
        }
        logSettings.info({ action }, 'Настройки: RESET all');
        await ctx.answerCallbackQuery({ text: 'Настройки сброшены' });
      } else if (action === ACTIONS.SET_CHANNEL) {
        const cid = value;
        if (cid === 'none') {
          const firstId = channels[0]?.id;
          if (firstId) {
            s = updateUserSettings(userId, { channelId: firstId });
            setGlobalChannelId(firstId);
            logSettings.info({ action, channelId: firstId }, 'Настройки: SET_CHANNEL -> first');
            await ctx.answerCallbackQuery({ text: 'Выбран первый канал' });
          } else {
            await ctx.answerCallbackQuery({ text: 'Список каналов пуст' });
          }
        } else {
          const allowedIds = channels.map(c => c.id);
          if (!allowedIds.includes(cid)) {
            logSettings.info({ action, attempted: cid }, 'Настройки: SET_CHANNEL -> not allowed');
            await ctx.answerCallbackQuery({ text: 'Канал не разрешён администратором' });
          } else {
            s = updateUserSettings(userId, { channelId: cid });
            setGlobalChannelId(cid);
            logSettings.info({ action, channelId: cid }, 'Настройки: SET_CHANNEL -> selected');
            await ctx.answerCallbackQuery({ text: 'Канал выбран' });
          }
        }
      } else if (action === ACTIONS.CLOSE && value === 'settings') {
        logSettings.info({ action }, 'Настройки: CLOSE settings');
        await ctx.answerCallbackQuery({ text: 'Закрыто' });
        try { await ctx.editMessageReplyMarkup(); } catch {}
        await ctx.reply(`Готово. ${defaultMessage}`, { reply_markup: buildMainKeyboard() });
        return;
      } else {
        await ctx.answerCallbackQuery();
      }

      const text = [
        "Настройки пользователя:",
        `Тип выдачи: ${s.type || 'не задан'}`,
        `k: ${s.k}`,
        `score: ${s.showScore ? 'показывать' : 'скрывать'}`,
      ].join("\n");

      try {
        await ctx.editMessageText(text, { reply_markup: buildSettingsKeyboard(s, channels) });
      } catch {
        await ctx.reply(text, { reply_markup: buildSettingsKeyboard(s, channels) });
      }
    } catch (err) {
      const logSettings = getLoggerCtx(ctx, { action: 'settings' });
      logSettings.error({ err: err?.message || err }, 'Ошибка обработки callback');
      try { await ctx.answerCallbackQuery({ text: 'Ошибка' }); } catch {}
    }
  });

  // Глобальный обработчик ошибок
  bot.catch((err) => {
    try {
      const log = getLoggerCtx(err?.ctx, { area: 'bot' });
      log.error({ err }, 'BotError');
    } catch (e) { console.error('BotError', err); }
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