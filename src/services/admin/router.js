const { env } = require("../../config/env");
const { logger, getLoggerCtx } = require("../../config/logger");
const { splitTextByLimit } = require("../telegram/format");
const path = require("path");
const { execFile } = require("child_process");

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
    const callArgs = input ? [input, "--yes"] : ["--yes"];
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
    const res = await runNodeScript("src/scripts/channel_stats.js", input ? [input] : [], { timeoutMs: 180_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: channel_stats");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка channel_stats (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // channel_count [channel]
  bot.command("channel_count", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "channel_count");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "channel_count" });
    log.info({ args }, `Вызов admin-команды: channel_count${args.length ? ' ' + args.join(' ') : ''}`);
    const input = args.find(a => a && !a.startsWith("-"));
    const res = await runNodeScript("src/scripts/channel_count.js", input ? [input] : [], { timeoutMs: 180_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: channel_count");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка channel_count (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // check_youtube [channel]
  bot.command("check_youtube", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "check_youtube");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "check_youtube" });
    log.info({ args }, `Вызов admin-команды: check_youtube${args.length ? ' ' + args.join(' ') : ''}`);
    const input = args.find(a => a && !a.startsWith("-"));
    const res = await runNodeScript("src/scripts/check_youtube.js", input ? [input] : [], { timeoutMs: 180_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: check_youtube");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка check_youtube (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // index_latest [channel]
  bot.command("index_latest", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const args = extractArgs(ctx.message?.text, "index_latest");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "index_latest" });
    log.info({ args }, `Вызов admin-команды: index_latest${args.length ? ' ' + args.join(' ') : ''}`);
    const input = args.find(a => a && !a.startsWith("-"));
    const res = await runNodeScript("src/scripts/index_latest_10.js", input ? [input] : [], { timeoutMs: 10 * 60_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: index_latest");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка index_latest (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
    await replySplit(ctx, text);
  });

  // index_batch [channel] [--limit N] [--stop-on-first-known on|off]
  bot.command("index_batch", async (ctx) => {
    if (!(await ensureAdmin(ctx))) return;
    const tokens = extractArgs(ctx.message?.text, "index_batch");
    const log = getLoggerCtx(ctx, { area: "admin", cmd: "index_batch" });
    log.info({ args: tokens }, `Вызов admin-команды: index_batch${tokens.length ? ' ' + tokens.join(' ') : ''}`);
    const res = await runNodeScript("src/scripts/index_batch.js", tokens, { timeoutMs: 15 * 60_000 });
    if (!res.ok) log.error({ code: res.code }, "Ошибка выполнения admin-команды: index_batch");
    const text = res.ok ? joinOutput(res.stdout, res.stderr) : ("Ошибка index_batch (code=" + res.code + ")\n" + joinOutput(res.stdout, res.stderr));
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
}

module.exports = {
  applyAdminCommands,
  extractArgs,
  isAdmin,
  ensureAdmin,
};