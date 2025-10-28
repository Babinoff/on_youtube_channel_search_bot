const { env } = require('../../config/env');
const { logger } = require('../../config/logger');
const { getProviderDistanceMax } = require('../embeddings');

function applyAdaptiveFilter(rows, k, { maxDistance, typeFilter, tableName }) {
  const arr = Array.isArray(rows) ? rows : [];
  const hasDistanceKey = arr.some((r) => typeof (r._distance ?? r.distance) === 'number');
  const isSimilarityScore = !hasDistanceKey && arr.some((r) => typeof r.score === 'number');

  const rowsTypeFiltered = typeFilter
    ? arr.filter((r) => (r.type || 'video') === typeFilter)
    : arr;

  // Базовая фильтрация по стартовому порогу
  // Начальная фильтрация по стартовому порогу; при неизвестной метрике — пусто
  let initialFiltered = [];
  if (hasDistanceKey) {
    initialFiltered = rowsTypeFiltered.filter((r) => {
      const d = r._distance ?? r.distance;
      return typeof d === 'number' ? d <= maxDistance : false;
    });
  } else if (isSimilarityScore) {
    const minScore = Math.max(0, Math.min(1, 1 - (Number(maxDistance) || 0)));
    initialFiltered = rowsTypeFiltered.filter((r) => {
      const s = r.score;
      return typeof s === 'number' ? s >= minScore : false;
    });
  } else {
    // Unknown metric: сразу вернуть top‑k если разрешено флагом, иначе пусто
    const s0 = String(process.env.SEARCH_FALLBACK_TOPK || 'false').toLowerCase();
    const allowTopK = ['1','true','yes','on'].includes(s0);
    if (allowTopK) {
      logger.warn({ tableName, k, allowTopK, reason: 'unknown_metric' }, 'Адаптивный порог: неизвестная метрика, применяю топ‑K фоллбек');
      return rowsTypeFiltered.slice(0, k);
    }
    initialFiltered = [];
  }

  let finalRows = initialFiltered.slice(0, k);

  // Новая логика: расширять порог, пока не наберём хотя бы k результатов
  const needAdapt = rowsTypeFiltered.length && finalRows.length < k;
  if (needAdapt) {
    const boundMax = getProviderDistanceMax();
    const iters = Number(env.SEARCH_ADAPTIVE_ITERS || 3);
    const step = Number(env.SEARCH_ADAPTIVE_STEP || 0.1);
    let curMax = Number(maxDistance) || 0.7;

    for (let i = 1; i <= iters; i++) {
      const nextMax = Math.min(curMax + step, boundMax);
      if (nextMax <= curMax) break;
      logger.warn({ tableName, from: curMax, to: nextMax, iter: i }, 'Адаптивный порог: расширяю maxDistance');

      let adapted;
      if (hasDistanceKey) {
        adapted = rowsTypeFiltered.filter((r) => {
          const d = r._distance ?? r.distance;
          return typeof d === 'number' ? d <= nextMax : false;
        });
      } else if (isSimilarityScore) {
        const minScoreIter = Math.max(0, Math.min(1, 1 - nextMax));
        adapted = rowsTypeFiltered.filter((r) => {
          const s = r.score;
          return typeof s === 'number' ? s >= minScoreIter : false;
        });
      } else {
        adapted = [];
      }

      finalRows = adapted.slice(0, k);
      curMax = nextMax;
      if (finalRows.length >= k) break; // достаточно результатов
      if (curMax >= boundMax) break;    // достигли максимума провайдера
    }

    // Fallback: если всё ещё меньше k — вернуть top‑k без порога ТОЛЬКО если разрешено флагом
    const s1 = String(process.env.SEARCH_FALLBACK_TOPK || 'false').toLowerCase();
    const allowTopK = ['1','true','yes','on'].includes(s1);
    if (finalRows.length < k && allowTopK) {
      logger.warn({ tableName, k, allowTopK, rowsLen: rowsTypeFiltered.length }, 'Адаптивный порог: применяю топ‑K фоллбек');
      finalRows = rowsTypeFiltered.slice(0, k);
    }
  }

  return finalRows;
}

module.exports = { applyAdaptiveFilter };