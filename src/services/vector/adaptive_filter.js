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
  const initialFiltered = rowsTypeFiltered.filter((r) => {
    if (hasDistanceKey) {
      const d = r._distance ?? r.distance;
      return typeof d === 'number' ? d <= maxDistance : true;
    }
    if (isSimilarityScore) {
      const s = r.score;
      const minScore = Math.max(0, Math.min(1, 1 - (Number(maxDistance) || 0)));
      return typeof s === 'number' ? s >= minScore : true;
    }
    const d = r._distance ?? r.distance ?? r.score;
    return typeof d === 'number' ? d <= maxDistance : true;
  });

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
          return typeof d === 'number' ? d <= nextMax : true;
        });
      } else if (isSimilarityScore) {
        const minScoreIter = Math.max(0, Math.min(1, 1 - nextMax));
        adapted = rowsTypeFiltered.filter((r) => {
          const s = r.score;
          return typeof s === 'number' ? s >= minScoreIter : true;
        });
      } else {
        adapted = rowsTypeFiltered;
      }

      finalRows = adapted.slice(0, k);
      curMax = nextMax;
      if (finalRows.length >= k) break; // достаточно результатов
      if (curMax >= boundMax) break;    // достигли максимума провайдера
    }

    // Fallback: если всё ещё меньше k — просто вернуть top‑k без порога
    if (finalRows.length < k) {
      finalRows = rowsTypeFiltered.slice(0, k);
    }
  }

  return finalRows;
}

module.exports = { applyAdaptiveFilter };