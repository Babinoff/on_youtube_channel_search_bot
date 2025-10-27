const { env } = require("../../config/env");
const { logger, getLoggerCtx } = require("../../config/logger");
const { splitTextByLimit } = require("../telegram/format");
const path = require("path");
const { execFile } = require("child_process");
const { createYouTubeClient, resolveChannelId } = require("../youtube/client");
const { getAdminChannels } = require("./channels_store");
const { addChannel, setActiveChannel, getActiveChannelId, getServerSettings } = require("./server_settings_store");

// Реестр админ-команд: описание и пример использования
const ADMIN_COMMANDS = [
  { name: "lock_status", usage: "/lock_status [name]", description: "показать статус блокировок." },
  { name: "lock_force", usage: "/lock_force [name] [--force]", description: "принудительно снять блокировку." },
  { name: "list_channels", usage: "/list_channels", description: "показать все каналы из настроек сервера." },
  { name: "add_channel", usage: "/add_channel <@хэндл|channelId>", description: "добавить новый канал в серверные настройки." },
  { name: "active_channel", usage: "/active_channel", description: "показать текущий активный канал." },
  { name: "set_channel", usage: "/set_channel <@хэндл|channelId>", description: "сменить активный канал." },
  { name: "channel_db_list", usage: "/channel_db_list", description: "список таблиц каналов в LanceDB." },
  { name: "channel_db_delete", usage: "/channel_db_delete --yes", description: "удалить таблицу активного канала в LanceDB." },
  { name: "channel_stats", usage: "/channel_stats", description: "сводная статистика индексации активного канала." },
  { name: "channel_db_stats", usage: "/channel_db_stats", description: "статистика по LanceDB для активного канала (без запросов в YouTube)." },
  { name: "check_youtube", usage: "/check_youtube", description: "проверка YouTube API для активного канала." },
  { name: "index_latest", usage: "/index_latest", description: "индексировать последние 10 видео активного канала." },
  { name: "index_batch", usage: "/index_batch [--limit N] [--stop-on-first-known on|off]", description: "массовая индексация активного канала." },
  { name: "preview_latest", usage: "/preview_latest", description: "предпросмотр очистки последних 10 видео по активному каналу." },
  { name: "search_latest", usage: "/search_latest <query>", description: "тестовый поиск по тестовой таблице." },
  { name: "env_check", usage: "/env_check", description: "сводка и валидация окружения." },
  { name: "emb_status", usage: "/emb_status", description: "статус провайдера эмбеддингов и размерность." },
  { name: "emb_model", usage: "/emb_model", description: "текущая модель эмбеддингов (провайдер и модель)." },
  // Новые команды диагностики/реиндексации эмбеддингов
  { name: "invalid_embeds", usage: "/invalid_embeds [channel] [--show-all]", description: "диагностика: список записей с невалидными/нулевыми векторами." },
  { name: "reindex_zero", usage: "/reindex_zero [channel] [--limit N] [--dry-run] [--on-invalid mark|skip] [--provider P] [--chain A,B]", description: "реиндексация записей с пустыми/инвалидными векторами." },
];

function buildAdminHelpText() {
  const groups = [
    { title: 'Управление каналами', cmds: ['list_channels', 'add_channel', 'active_channel', 'set_channel', 'channel_db_list', 'channel_db_delete', 'channel_stats', 'channel_db_stats'] },
    { title: 'Индексация и превью', cmds: ['index_latest', 'index_batch', 'check_youtube', 'preview_latest'] },
    { title: 'Блокировки', cmds: ['lock_status', 'lock_force'] },
    { title: 'Окружение и эмбеддинги', cmds: ['env_check', 'emb_status', 'emb_model', 'invalid_embeds', 'reindex_zero'] },
  ];

  const byName = new Map(ADMIN_COMMANDS.map(c => [c.name, c]));

  const lines = [];
  lines.push('Админ‑панель: команды сгруппированы по разделам:');
  for (const g of groups) {
    lines.push('', `• ${g.title}:`);
    for (const name of g.cmds) {
      const c = byName.get(name);
      if (!c) continue;
      lines.push(`  – ${c.usage} — ${c.description}`);
    }
  }

  const examples = [
    '',
    'Примеры:',
    '• /set_channel @хэндл',
    '• /add_channel UCxxxxxxxxxxxxxxxxxxxxxxxxxx',
    '• /index_batch --limit 100 --stop-on-first-known on',
  ];

  return [...lines, ...examples].join('\n');
}

// Добавлен генератор Markdown для README (список в виде маркдаун-«пулек»)
function buildAdminMarkdownList() {
  return ADMIN_COMMANDS.map(c => `- ${c.usage} — ${c.description}`).join('\n');
}

function isAdmin(ctx) {
  const uid = ctx?.from?.id;
  return env.ADMIN_USER_ID ? String(uid) === String(env.ADMIN_USER_ID) : false;
}

async function ensureAdmin(ctx) {
  if (!isAdmin(ctx)) {
    await ctx.reply("Команда доступна только администратору.");
    return false;
  }
  return true;
}

function extractArgs(messageText, command) {
  const text = String(messageText || "");
  const prefix = "/" + command;
  const idx = text.indexOf(prefix);
  if (idx < 0) return [];
  const tail = text.slice(idx + prefix.length).trim();
  if (!tail) return [];
  // Split by spaces, keeping simple quoted segments
  const tokens = [];
  let buf = "";
  let quote = null;
  for (const ch of tail) {
    if (quote) {
      if (ch === quote) {
        tokens.push(buf);
        buf = "";
        quote = null;
      } else {
        buf += ch;
      }
    } else {
      if (ch === '"' || ch === "'") {
        if (buf) { tokens.push(buf); buf = ""; }
        quote = ch;
      } else if (/\s/.test(ch)) {
        if (buf) { tokens.push(buf); buf = ""; }
      } else {
        buf += ch;
      }
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function joinOutput(stdout, stderr) {
  const out = String(stdout || "").trim();
  const err = String(stderr || "").trim();
  if (out && err) return out + "\n\n" + err;
  if (out) return out;
  if (err) return err;
  return "<no output>";
}

function runNodeScript(scriptRelPath, args = [], options = {}) {
  return new Promise((resolve) => {
    const node = process.execPath;
    const script = path.isAbsolute(scriptRelPath)
      ? scriptRelPath
      : path.join(process.cwd(), scriptRelPath);
    const timeout = options.timeoutMs ?? 10 * 60 * 1000; // default 10 minutes for long jobs
    const maxBuffer = options.maxBuffer ?? (1024 * 1024); // 1MB

    execFile(node, [script, ...args], { timeout, windowsHide: true, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, code: error.code ?? 1, stdout, stderr, error });
      } else {
        resolve({ ok: true, code: 0, stdout, stderr });
      }
    });
  });
}

async function replySplit(ctx, text) {
  const parts = splitTextByLimit(String(text || ""), 3800);
  for (const p of parts) {
    await ctx.reply(p);
  }
}

function applyAdminCommands(bot) {
  // list_channels
  bot.command("list_channels", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "list_channels" });
    log.info("Вызов admin-команды: list_channels");
    const list = await getAdminChannels();
    const activeId = await getActiveChannelId();
    if (!list.length) { await ctx.reply("Список каналов пуст."); return; }
    const lines = list.map((c) => {
      const mark = c.id === activeId ? "[active] " : "";
      const handle = c.handle ? ` (${c.handle})` : "";
      return `• ${mark}${c.title}${handle} — ${c.id}`;
    });
    const text = ["Каналы:", ...lines].join("\n");
    await replySplit(ctx, text);
  });

  // add_channel <@handle|channelId>
  bot.command("add_channel", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "add_channel");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "add_channel" });
    log.info({ args }, `Вызов admin-команды: add_channel${args.length ? ' ' + args.join(' ') : ''}`);
    const input = args[0];
    if (!input) { await ctx.reply("Использование: /add_channel <@хэндл|channelId>"); return; }
    try {
      const id = await resolveChannelIdBestEffort(input);
      const info = await fetchInfoBestEffort(id);
      await addChannel({ id, handle: info.handle, title: info.title });
      await ctx.reply(`Канал добавлен: ${info.title}${info.handle ? ' ' + info.handle : ''} — ${id}`);
    } catch (err) {
      await ctx.reply(`Ошибка добавления канала: ${err?.message || err}`);
    }
  });

  // active_channel
  bot.command("active_channel", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "active_channel" });
    log.info("Вызов admin-команды: active_channel");
    const id = await getActiveChannelId();
    if (!id) { await ctx.reply("Активный канал не задан."); return; }
    const info = await fetchInfoBestEffort(id);
    await ctx.reply(`Активный канал: ${info.title}${info.handle ? ' ' + info.handle : ''} — ${id}`);
  });

  // set_channel <@handle|channelId>
  bot.command("set_channel", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "set_channel");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "set_channel" });
    log.info({ args }, `Вызов admin-команды: set_channel${args.length ? ' ' + args.join(' ') : ''}`);
    const input = args[0];
    if (!input) { await ctx.reply("Использование: /set_channel <@хэндл|channelId>"); return; }
    try {
      const id = await resolveChannelIdBestEffort(input);
      const info = await fetchInfoBestEffort(id);
      // Ensure channel exists in server list
      const settings = await getServerSettings();
      const exists = (settings.channels || []).some((c) => c.id === id);
      if (!exists) await addChannel({ id, handle: info.handle, title: info.title });
      await setActiveChannel(id);
      await ctx.reply(`Активный канал установлен: ${info.title}${info.handle ? ' ' + info.handle : ''} — ${id}`);
    } catch (err) {
      await ctx.reply(`Ошибка установки активного канала: ${err?.message || err}`);
    }
  });

  // lock_status [name]
  bot.command("lock_status", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "lock_status");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "lock_status" });
    log.info({ args }, `Вызов admin-команды: lock_status${args.length ? ' ' + args.join(' ') : ''}`);
    const name = args[0] || "indexing";
    const res = await runNodeScript("src/scripts/lock_status.js", [name], { timeoutMs: 60_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: lock_status");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка lock_status (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // lock_force [name] [--force]
  bot.command("lock_force", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "lock_force");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "lock_force" });
    log.info({ args }, `Вызов admin-команды: lock_force${args.length ? ' ' + args.join(' ') : ''}`);
    const name = args.find(a => !a.startsWith("-")) || "indexing";
    const hasForce = args.includes("--force") || args.includes("--yes");
    const callArgs = hasForce ? [name, "--force"] : [name];
    const res = await runNodeScript("src/scripts/lock_force.js", callArgs, { timeoutMs: 60_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: lock_force");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка lock_force (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // channel_db_list
  bot.command("channel_db_list", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "channel_db_list" });
    log.info("Вызов admin-команды: channel_db_list");
    const res = await runNodeScript("src/scripts/channel_db_list.js", [], { timeoutMs: 120_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: channel_db_list");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка channel_db_list (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // channel_db_delete <input> [--yes]
  bot.command("channel_db_delete", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "channel_db_delete");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "channel_db_delete" });
    log.info({ args }, `Вызов admin-команды: channel_db_delete${args.length ? ' ' + args.join(' ') : ''}`);
    const yes = args.includes("--yes") || args.includes("-y");
    const input = args.find(a => a && !a.startsWith("-"));
    if (!yes) {
      await ctx.reply("Добавьте --yes для подтверждения удаления таблицы канала.");
      return;
    }
    const channel = input || await getActiveChannelId();
    const callArgs = channel ? [channel, "--yes"] : ["--yes"];
    const res = await runNodeScript("src/scripts/channel_db_delete.js", callArgs, { timeoutMs: 120_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: channel_db_delete");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка channel_db_delete (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // channel_stats [channel]
  bot.command("channel_stats", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "channel_stats");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "channel_stats" });
    log.info({ args }, `Вызов admin-команды: channel_stats${args.length ? ' ' + args.join(' ') : ''}`);
    const input = args.find(a => a && !a.startsWith("-"));
    const channel = input || await getActiveChannelId();
    const res = await runNodeScript("src/scripts/channel_stats.js", channel ? [channel] : [], { timeoutMs: 180_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: channel_stats");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка channel_stats (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // channel_db_stats [channel]
  bot.command("channel_db_stats", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "channel_db_stats");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "channel_db_stats" });
    log.info({ args }, `Вызов admin-команды: channel_db_stats${args.length ? ' ' + args.join(' ') : ''}`);
    const input = args.find(a => a && !a.startsWith("-"));
    const channel = input || await getActiveChannelId();
    const res = await runNodeScript("src/scripts/channel_db_stats.js", channel ? [channel] : [], { timeoutMs: 120_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: channel_db_stats");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка channel_db_stats (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // channel_db_delete <input> [--yes]
  bot.command("channel_db_delete", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "channel_db_delete");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "channel_db_delete" });
    log.info({ args }, `Вызов admin-команды: channel_db_delete${args.length ? ' ' + args.join(' ') : ''}`);
    const yes = args.includes("--yes") || args.includes("-y");
    const input = args.find(a => a && !a.startsWith("-"));
    if (!yes) {
      await ctx.reply("Добавьте --yes для подтверждения удаления таблицы канала.");
      return;
    }
    const channel = input || await getActiveChannelId();
    const callArgs = channel ? [channel, "--yes"] : ["--yes"];
    const res = await runNodeScript("src/scripts/channel_db_delete.js", callArgs, { timeoutMs: 120_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: channel_db_delete");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка channel_db_delete (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // preview_latest [env only]
  bot.command("preview_latest", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "preview_latest" });
    log.info("Вызов admin-команды: preview_latest");
    const res = await runNodeScript("src/scripts/preview_latest_10.js", [], { timeoutMs: 180_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: preview_latest");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка preview_latest (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // search_latest <query>
  bot.command("search_latest", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const rawArgs = ctx.message?.text?.replace(/^\/?search_latest\b/, "").trim() || "";
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "search_latest" });
    log.info({ query: rawArgs }, `Вызов admin-команды: search_latest${rawArgs ? ' ' + rawArgs : ''}`);
    if (!rawArgs) {
      await ctx.reply("Укажите текст запроса после команды: /search_latest <query>");
      return;
    }
    const res = await runNodeScript("src/scripts/search_latest_10.js", [rawArgs], { timeoutMs: 120_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: search_latest");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка search_latest (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // index_latest [channel?]
  bot.command("index_latest", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "index_latest");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "index_latest" });
    log.info({ args }, `Вызов admin-команды: index_latest${args.length ? ' ' + args.join(' ') : ''}`);
    const input = args.find(a => a && !a.startsWith("-"));
    const channel = input || await getActiveChannelId();
    const callArgs = channel ? [channel] : [];
    const res = await runNodeScript("src/scripts/index_latest_10.js", callArgs, { timeoutMs: 300_000, maxBuffer: 2 * 1024 * 1024 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: index_latest");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка index_latest (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // index_batch [--limit N] [--stop-on-first-known on|off] [--progress] [--progress-every N]
  bot.command("index_batch", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "index_batch");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "index_batch" });
    log.info({ args }, `Вызов admin-команды: index_batch${args.length ? ' ' + args.join(' ') : ''}`);
    const input = args.find(a => a && !a.startsWith("-"));
    const channel = input || await getActiveChannelId();
    const callArgs = [];
    if (channel) callArgs.push(channel);
    const idxLimit = args.findIndex(a => a === "--limit");
    if (idxLimit >= 0 && args[idxLimit + 1] && !args[idxLimit + 1].startsWith("-")) {
      callArgs.push("--limit", args[idxLimit + 1]);
    }
    const idxStop = args.findIndex(a => a === "--stop-on-first-known");
    if (idxStop >= 0) {
      if (args[idxStop + 1] && !args[idxStop + 1].startsWith("-")) {
        callArgs.push("--stop-on-first-known", args[idxStop + 1]);
      } else {
        callArgs.push("--stop-on-first-known");
      }
    }
    if (args.includes("--progress")) callArgs.push("--progress");
    const idxProgEvery = args.findIndex(a => a === "--progress-every");
    if (idxProgEvery >= 0 && args[idxProgEvery + 1] && !args[idxProgEvery + 1].startsWith("-")) {
      callArgs.push("--progress-every", args[idxProgEvery + 1]);
    }

    const res = await runNodeScript("src/scripts/index_batch.js", callArgs, { timeoutMs: 20 * 60_000, maxBuffer: 2 * 1024 * 1024 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: index_batch");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка index_batch (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  

  // env_check
  bot.command("env_check", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "env_check" });
    log.info("Вызов admin-команды: env_check");
    const res = await runNodeScript("src/scripts/env_check.js", [], { timeoutMs: 60_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: env_check");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка env_check (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // emb_status
  bot.command("emb_status", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "emb_status" });
    log.info("Вызов admin-команды: emb_status");
    const res = await runNodeScript("src/scripts/emb_status.js", [], { timeoutMs: 120_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: emb_status");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка emb_status (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // emb_model
  bot.command("emb_model", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "emb_model" });
    log.info("Вызов admin-команды: emb_model");
    const provider = String(env.EMBEDDINGS_PROVIDER || '').toLowerCase();
    let model;
    switch (provider) {
      case 'xenova':
        model = process.env.EMBEDDINGS_XENOVA_MODEL || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
        break;
      case 'google':
        model = env.EMBEDDINGS_MODEL_ID || 'text-embedding-004';
        break;
      case 'mistral':
        model = 'mistral-embed';
        break;
      case 'openai':
        model = env.EMBEDDINGS_MODEL_ID || 'text-embedding-3-large';
        break;
      case 'embeddinggemma':
        model = env.OLLAMA_MODEL || 'embeddinggemma';
        break;
      default:
        model = '(unknown)';
        break;
    }
    const chain = env.EMBEDDINGS_PROVIDER_CHAIN || '';
    const text = [
      `Текущая модель эмбеддингов: ${model}`,
      `Провайдер: ${provider || '(not set)'}`,
      chain ? `Цепочка фоллбэков: ${chain}` : null,
    ].filter(Boolean).join('\n');
    await ctx.reply(text);
  });

  // invalid_embeds [channel] [--show-all]
  bot.command("invalid_embeds", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "invalid_embeds");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "invalid_embeds" });
    log.info({ args }, `Вызов admin-команды: invalid_embeds${args.length ? ' ' + args.join(' ') : ''}`);
    const input = args.find(a => a && !a.startsWith("-"));
    const callArgs = [];
    if (input) callArgs.push(input);
    if (args.includes("--show-all")) callArgs.push("--show-all");
    const res = await runNodeScript("src/scripts/list_invalid_vectors.js", callArgs, { timeoutMs: 180_000, maxBuffer: 2 * 1024 * 1024 });
    if (!res.ok) {
      log.error({ code: res.code }, "Ошибка выполнения admin-команды: invalid_embeds");
      const text = "Ошибка invalid_embeds (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr);
      await replySplit(ctx, text);
      return;
    }
    await replySplit(ctx, joinOutput(res.stdout, res.stderr));
  });

  // reindex_zero [channel] [--limit N] [--dry-run] [--on-invalid mark|skip] [--provider P] [--chain A,B]
  bot.command("reindex_zero", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "reindex_zero");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "reindex_zero" });
    log.info({ args }, `Вызов admin-команды: reindex_zero${args.length ? ' ' + args.join(' ') : ''}`);
    const input = args.find(a => a && !a.startsWith("-"));
    const callArgs = [];
    if (input) callArgs.push(input);
    // parse flags
    const idxLimit = args.findIndex(a => a === "--limit");
    if (idxLimit >= 0 && args[idxLimit + 1]) callArgs.push("--limit", args[idxLimit + 1]);
    if (args.includes("--dry-run")) callArgs.push("--dry-run");
    const idxOnInvalid = args.findIndex(a => a === "--on-invalid");
    if (idxOnInvalid >= 0 && args[idxOnInvalid + 1]) callArgs.push("--on-invalid", args[idxOnInvalid + 1]);
    const idxProvider = args.findIndex(a => a === "--provider");
    if (idxProvider >= 0 && args[idxProvider + 1]) callArgs.push("--provider", args[idxProvider + 1]);
    const idxChainArg = args.findIndex(a => a === "--chain");
    if (idxChainArg >= 0 && args[idxChainArg + 1]) callArgs.push("--chain", args[idxChainArg + 1]);

    const res = await runNodeScript("src/scripts/reindex_zero_vectors.js", callArgs, { timeoutMs: 600_000, maxBuffer: 2 * 1024 * 1024 });
    if (!res.ok) {
      log.error({ code: res.code }, "Ошибка выполнения admin-команды: reindex_zero");
      const text = "Ошибка reindex_zero (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr);
      await replySplit(ctx, text);
      return;
    }
    await replySplit(ctx, joinOutput(res.stdout, res.stderr));
  });
}

module.exports = {
  applyAdminCommands,
  extractArgs,
  isAdmin,
  ensureAdmin,
  ADMIN_COMMANDS,
  buildAdminHelpText,
  buildAdminMarkdownList,
};

function resolveChannelIdBestEffort(input) {
  const looksLikeId = input && /^UC[\w-]{20,}$/.test(input);
  if (looksLikeId) return Promise.resolve(input);
  if (!env.YOUTUBE_API_KEY) return Promise.resolve(input); // best-effort when no API key
  const client = createYouTubeClient(env.YOUTUBE_API_KEY);
  return resolveChannelId(input, client);
}

async function fetchInfoBestEffort(channelId) {
  if (!env.YOUTUBE_API_KEY) return { id: channelId, title: channelId, handle: null };
  try {
    const client = createYouTubeClient(env.YOUTUBE_API_KEY);
    const resp = await client.get("/channels", { params: { part: "snippet", id: channelId } });
    const item = resp?.data?.items?.[0];
    const title = item?.snippet?.title || channelId;
    const customUrl = item?.snippet?.customUrl || null;
    const handle = customUrl && customUrl.startsWith("@") ? customUrl : null;
    return { id: channelId, title, handle };
  } catch {
    return { id: channelId, title: channelId, handle: null };
  }
}