require("dotenv").config();
const { logger } = require("../config/logger");
const { env } = require("../config/env");
const { resolveProviderChain, getProviderDistanceMax } = require("../services/embeddings");
const { findLatestTestTableName, openLatestTestTable, openChannelTableIfExists, searchTopK } = require("../services/vector/lancedb");

function fmtMs(ms) {
  return `${Math.round(ms)}ms`;
}

async function tryImportXenova() {
  try { await import("@xenova/transformers"); return { ok: true }; } catch (err) {
    return { ok: false, err: err?.message || String(err) };
  }
}

function providerModel(name) {
  const p = String(name || '').toLowerCase();
  switch (p) {
    case 'xenova':
      return process.env.EMBEDDINGS_XENOVA_MODEL || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
    case 'google':
      return env.EMBEDDINGS_MODEL_ID || 'text-embedding-004';
    case 'mistral':
      return 'mistral-embed';
    case 'openai':
      return env.EMBEDDINGS_MODEL_ID || 'text-embedding-3-large';
    case 'embeddinggemma':
      return env.OLLAMA_MODEL || 'embeddinggemma';
    default:
      return '(unknown)';
  }
}

async function testProvider(name, sampleText) {
  let mod = null;
  try { mod = require(`../services/embeddings/${name}`); } catch (_) {}
  if (!mod || typeof mod.embedTexts !== 'function') {
    const reason = 'модуль провайдера отсутствует';
    return { name, ok: false, reason };
  }

  const t0 = Date.now();
  try {
    const vecs = await mod.embedTexts([sampleText]);
    const dt = Date.now() - t0;
    const v = Array.isArray(vecs) ? vecs[0] : null;
    if (!Array.isArray(v) || !v.length) {
      let reason = 'пустой результат';
      if (name === 'xenova') {
        const xi = await tryImportXenova();
        if (!xi.ok) reason = `@xenova/transformers не установлен: ${xi.err}`;
      }
      return { name, ok: false, reason, time: dt };
    }
    // norm
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return { name, ok: true, dims: v.length, time: dt, model: providerModel(name), l2norm: norm };
  } catch (err) {
    const dt = Date.now() - t0;
    return { name, ok: false, reason: err?.response?.data || err?.message || String(err), time: dt };
  }
}

async function readTableStats(channelIdOverride) {
  const out = {};
  // Latest test table
  try {
    const latestName = findLatestTestTableName();
    out.latestTest = { name: latestName || null };
    if (latestName) {
      const { table } = await openLatestTestTable();
      try {
        const qb = table.query().select(["id"]);
        const rows = typeof qb.toArray === 'function' ? await qb.toArray() : await qb.limit(100000000).toArray();
        out.latestTest.count = Array.isArray(rows) ? rows.length : undefined;
      } catch (e) {
        out.latestTest.countError = e?.message;
      }
    }
  } catch (e) {
    out.latestTest = { error: e?.message || String(e) };
  }

  // Channel table
  try {
    const chRaw = channelIdOverride || env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_CHANNEL_ID || null;
    out.channel = { id: chRaw };
    if (chRaw) {
      const { table, tableName } = await openChannelTableIfExists(chRaw);
      out.channel.name = tableName;
      if (!table) {
        out.channel.exists = false;
      } else {
        out.channel.exists = true;
        try {
          const qb = table.query().select(["id"]);
          const rows = typeof qb.toArray === 'function' ? await qb.toArray() : await qb.limit(100000000).toArray();
          out.channel.count = Array.isArray(rows) ? rows.length : undefined;
        } catch (e) {
          out.channel.countError = e?.message;
        }
      }
    }
  } catch (e) {
    out.channel = { error: e?.message || String(e) };
  }

  return out;
}

async function testSearch(sampleText, channelIdOverride) {
  try {
    const channelId = channelIdOverride || env.YOUTUBE_CHANNEL_ID || null;
    const providerMax = getProviderDistanceMax();
    const res = await searchTopK(sampleText, 5, { channelId, maxDistance: providerMax });
    const scores = res.map(r => Number(r.score)).filter(n => Number.isFinite(n));
    const stats = scores.length ? {
      count: scores.length,
      min: Math.min(...scores),
      max: Math.max(...scores),
      avg: scores.reduce((s, n) => s + n, 0) / scores.length,
    } : { count: 0 };
    return { ok: true, res, stats, providerMax };
  } catch (e) {
    return { ok: false, err: e?.message || String(e) };
  }
}

function printAdaptiveRecommendation(active, stats) {
  if (!active) return;
  const iters = Number(env.SEARCH_ADAPTIVE_ITERS || 3);
  const step = Number(env.SEARCH_ADAPTIVE_STEP || 0.1);
  const start = Number(env.SEARCH_MAX_DISTANCE || 0.7);
  const providerMax = getProviderDistanceMax();

  console.log("\n=== Рекомендация по порогу (адаптивно) ===");
  console.log(`Активный провайдер: ${active}`);
  console.log(`Диапазон метрики: [0..${providerMax}]`);
  console.log(`Стартовый порог SEARCH_MAX_DISTANCE: ${start}`);
  console.log(`Адаптация: iters=${iters}, step=${step}`);
  if (Number.isFinite(stats?.avg) && Number.isFinite(stats?.max)) {
    console.log(`Статистика выборки: score[min=${stats.min?.toFixed ? stats.min.toFixed(4) : stats.min}, max=${stats.max?.toFixed ? stats.max.toFixed(4) : stats.max}, avg=${stats.avg?.toFixed ? stats.avg.toFixed(4) : stats.avg}]`);
  }
  console.log("Алгоритм: при пустом первом проходе порог увеличивается итеративно до верхней границы провайдера. Финальный фоллбек — топ‑k без порога.");
}

async function main() {
  const chain = resolveProviderChain();
  const provider = String(env.EMBEDDINGS_PROVIDER || '').toLowerCase();
  const argv = process.argv.slice(2);
  const channelArg = argv.find(a => a && (a.startsWith("@") || /^UC[\w-]{20,}$/.test(a) || /^https?:\/\//.test(a)));
  const sampleText = argv.filter(a => a !== channelArg).join(' ') || 'Аббадон';

  let activeId = null;
  try { ({ getActiveChannelId } = require("../services/admin/server_settings_store")); } catch (_) {}
  try { activeId = typeof getActiveChannelId === 'function' ? await getActiveChannelId() : null; } catch (_) { activeId = null; }
  const inputEnv = env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_CHANNEL_ID || null;
  const raw = channelArg || inputEnv || activeId;
  let channelId = raw || null;
  try {
    if (raw && !/^UC[\w-]{20,}$/.test(raw) && env.YOUTUBE_API_KEY) {
      const { createYouTubeClient, resolveChannelId } = require("../services/youtube/client");
      const client = createYouTubeClient(env.YOUTUBE_API_KEY);
      channelId = await resolveChannelId(raw, client);
    }
  } catch (_) {}

  console.log("=== Embeddings: окружение ===");
  console.log(`EMBEDDINGS_PROVIDER: ${provider}`);
  console.log(`EMBEDDINGS_PROVIDER_CHAIN: ${chain.join(', ')}`);
  console.log(`SEARCH_MAX_DISTANCE: ${env.SEARCH_MAX_DISTANCE}`);
  console.log(`SEARCH_MAX_K: ${env.SEARCH_MAX_K}`);
  console.log(`SEARCH_ADAPTIVE_ITERS: ${env.SEARCH_ADAPTIVE_ITERS}`);
  console.log(`SEARCH_ADAPTIVE_STEP: ${env.SEARCH_ADAPTIVE_STEP}`);
  console.log(`LANCEDB_DIR: ${env.LANCEDB_DIR || './data/lancedb'}`);
  console.log(`CHANNEL_SOURCE: ${channelArg ? 'argv' : (inputEnv ? 'env' : (activeId ? 'active' : 'none'))}`);
  console.log(`CHANNEL_ID: ${channelId || '(не задан)'}`);

  console.log("\n=== Провайдеры: статус ===");
  const results = [];
  for (const name of chain) {
    const r = await testProvider(name, sampleText);
    results.push(r);
    if (r.ok) {
      console.log(`- ${name}: OK | model=${r.model} | dims=${r.dims} | l2norm=${r.l2norm?.toFixed(4)} | time=${fmtMs(r.time)}`);
    } else {
      console.log(`- ${name}: FAIL | reason=${r.reason} | time=${r.time ? fmtMs(r.time) : '-'}`);
    }
  }
  const active = results.find(r => r.ok)?.name || null;
  console.log(`Активный провайдер: ${active || '(нет)'}`);

  console.log("\n=== LanceDB: таблицы ===");
  const stats = await readTableStats(channelId);
  if (stats.latestTest?.error) {
    console.log(`latest10: ERROR ${stats.latestTest.error}`);
  } else if (stats.latestTest?.name) {
    console.log(`latest10: ${stats.latestTest.name} | rows=${stats.latestTest.count ?? '?'}`);
  } else {
    console.log(`latest10: отсутствует (запустите npm run index:test)`);
  }
  if (stats.channel?.error) {
    console.log(`channel: ERROR ${stats.channel.error}`);
  } else if (stats.channel?.id) {
    console.log(`channel: ${stats.channel.name} | exists=${stats.channel.exists} | rows=${stats.channel.count ?? '?'}`);
  } else {
    console.log(`channel: не задан (активный или .env)`);
  }

  console.log("\n=== Поиск: быстрая проверка (порог = максимум провайдера) ===");
  const s = await testSearch(sampleText, channelId);
  if (!s.ok) {
    console.log(`search: ERROR ${s.err}`);
  } else {
    console.log(`search: ${s.stats.count} результатов | score[min=${s.stats.min ?? '-'}, max=${s.stats.max ?? '-'}, avg=${s.stats.avg?.toFixed(4) ?? '-'}]`);
    (s.res || []).slice(0, 5).forEach((r, i) => {
      console.log(`  ${i + 1}. score=${r.score?.toFixed ? r.score.toFixed(6) : r.score} | ${r.title} | ${r.url}`);
    });
  }

  // Adaptive configuration & recommendation
  printAdaptiveRecommendation(active, s.stats);
}

main().catch((err) => {
  logger.error({ err: err?.message || err }, "Ошибка emb_status");
  console.error("emb_status: ERROR", err?.message || err);
  process.exit(1);
});