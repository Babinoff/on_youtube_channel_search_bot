import { describe, it, expect } from 'vitest';
import { env } from '../src/config/env';
import { normalizeQueryText } from '../src/services/text/query_normalize';
import { embedTexts, resolveProviderChain, getProviderDistanceMax } from '../src/services/embeddings';
import { openChannelTableIfExists } from '../src/services/vector/lancedb';
import { applyAdaptiveFilter } from '../src/services/vector/adaptive_filter';
import { getActiveChannelId } from '../src/services/admin/server_settings_store';

function averageVectors(vectors) {
  const arr = (vectors || []).filter((v) => Array.isArray(v));
  if (arr.length === 0) return undefined;
  const len = arr[0].length;
  const sum = new Array(len).fill(0);
  for (const v of arr) {
    if (!Array.isArray(v) || v.length !== len) continue;
    for (let i = 0; i < len; i++) sum[i] += v[i] || 0;
  }
  for (let i = 0; i < len; i++) sum[i] /= arr.length;
  return sum;
}

function euclideanDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return undefined;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    s += d * d;
  }
  return Math.sqrt(s);
}

function normalizeType(type) {
  const t = type === undefined ? null : type;
  const allowed = new Set([null, 'short', 'stream', 'video']);
  return allowed.has(t) ? t : null;
}

function tokensFromText(text) {
  const s = normalizeQueryText(String(text || ''));
  if (!s) return new Set();
  return new Set(s.split(' ').filter(Boolean));
}

function formatVectorSample(vec, max = 12) {
  if (!Array.isArray(vec)) return 'undefined';
  return `[${vec.slice(0, max).map((v) => Number(v).toFixed(6)).join(', ')} ...] (dims=${vec.length})`;
}

// Read hybrid settings from process.env directly to reflect current server values
function hybridSettings() {
  const titleWeight = Number(process.env.SEARCH_HYBRID_TITLE_WEIGHT || 3);
  const descWeight = Number(process.env.SEARCH_HYBRID_DESC_WEIGHT || 1);
  const boostFactor = Number(process.env.SEARCH_HYBRID_FACTOR || 0.5);
  const enabled = String(process.env.SEARCH_HYBRID_ENABLE || 'true').toLowerCase();
  return { titleWeight, descWeight, boostFactor, enabled: enabled !== 'false' && enabled !== '0' };
}

describe('search live detailed (uses active env settings)', () => {
  it('runs detailed search and prints vectors of matches', async () => {
    const query = process.env.SEARCH_TEST_QUERY || 'Vampire The Masquerade';
    const k = Math.max(1, Number(process.env.SEARCH_TEST_K || env.SEARCH_TOP_K || 5));
    const type = normalizeType(process.env.SEARCH_TEST_TYPE ?? null);
    const channelId = process.env.SEARCH_TEST_CHANNEL_ID || await getActiveChannelId();
    const chain = resolveProviderChain();

    if (!channelId) {
      console.warn('SKIP: active channel not set. Provide SEARCH_TEST_CHANNEL_ID or set in settings.json');
      expect(true).toBe(true);
      return;
    }

    const { table, tableName } = await openChannelTableIfExists(channelId);
    if (!table) {
      console.warn(`SKIP: channel table not found: ${tableName}. Run indexing for the channel first.`);
      expect(true).toBe(true);
      return;
    }

    const useNorm = env.SEARCH_NORMALIZE_QUERY;
    const raw = String(query || '');
    const norm = useNorm ? normalizeQueryText(raw) : raw;
    const qVecs = await embedTexts(useNorm ? [raw, norm] : [raw]);
    const qVec = useNorm ? averageVectors(qVecs) : qVecs[0];
    if (!qVec || !Array.isArray(qVec)) throw new Error('Query embedding failed');

    console.log('=== Live Search: Environment ===');
    console.log(`Provider chain: ${chain.join(' -> ')}`);
    console.log(`SEARCH_MAX_DISTANCE: ${env.SEARCH_MAX_DISTANCE}`);
    console.log(`SEARCH_NORMALIZE_QUERY: ${env.SEARCH_NORMALIZE_QUERY}`);
    console.log(`SEARCH_ADAPTIVE_ITERS: ${env.SEARCH_ADAPTIVE_ITERS}`);
    console.log(`SEARCH_ADAPTIVE_STEP: ${env.SEARCH_ADAPTIVE_STEP}`);
    console.log(`SEARCH_MAX_K: ${env.SEARCH_MAX_K}`);
    console.log(`activeChannelId: ${channelId}`);

    const hs = hybridSettings();
    console.log('Hybrid settings:', hs);

    const tokensWantedArr = (normalizeQueryText(norm || raw) || '')
      .split(' ')
      .filter((t) => t && t.length >= 3 && t !== 'the');
    const tokensWanted = new Set(tokensWantedArr);

    console.log('=== Query ===');
    console.log(`raw: ${raw}`);
    console.log(`norm: ${norm}`);
    console.log(`qVec: ${formatVectorSample(qVec)}`);
    console.log(`tokensWanted: ${Array.from(tokensWanted).join(', ') || '(none)'}`);

    // Build LanceDB query compatible with both APIs
    let qb = typeof table.vectorSearch === 'function' ? table.vectorSearch(qVec) : table.search(qVec);
    try {
      if (type && typeof qb.where === 'function') qb = qb.where(`type = '${type}'`);
      else if (type && typeof qb.filter === 'function') {
        qb = qb.filter(`type = '${type}'`);
        if (typeof qb.prefilter === 'function') qb = qb.prefilter(true);
      }
    } catch {}

    const preLimit = Math.max(k, Number(env.SEARCH_MAX_K || 20));
    let res;
    if (typeof qb.toArray === 'function') res = await qb.limit(preLimit).toArray();
    else res = await qb.limit(preLimit).execute();
    const rows = Array.isArray(res) ? res : (typeof res?.toArray === 'function' ? res.toArray() : []);

    console.log(`Initial candidates: ${rows.length} (preLimit=${preLimit})`);

    const maxDistance = Number(env.SEARCH_MAX_DISTANCE || 0.7);
    const finalRows = applyAdaptiveFilter(rows, k, { maxDistance, typeFilter: type, tableName });

    // Metric type + threshold reconstruction
    const providerMax = getProviderDistanceMax();
    const hasDistanceKey = finalRows.some((r) => typeof (r._distance ?? r.distance) === 'number');
    const isSimilarityScore = !hasDistanceKey && finalRows.some((r) => typeof r.score === 'number');

    let finalThreshold = null;
    if (hasDistanceKey) {
      const distances = finalRows.map((r) => (typeof r._distance === 'number' ? r._distance : r.distance)).filter((v) => typeof v === 'number');
      finalThreshold = distances.length ? Math.max(...distances) : null;
    } else if (isSimilarityScore) {
      const scores = finalRows.map((r) => r.score).filter((v) => typeof v === 'number');
      finalThreshold = scores.length ? (1 - Math.min(...scores)) : null;
    }

    console.log('=== Adaptive Filter Result ===');
    console.log(`metricType: ${hasDistanceKey ? 'distance' : (isSimilarityScore ? 'similarity' : 'unknown')}`);
    console.log(`finalThreshold: ${finalThreshold}`);
    console.log(`providerMax: ${providerMax}`);
    console.log(`rows after adaptive: ${finalRows.length}`);

    // Hybrid boosting with detailed instrumentation
    let selectedRows = finalRows;
    if (hs.enabled) {
      const typeFilteredAll = type ? rows.filter((r) => (r.type || 'video') === type) : rows;
      let thr = typeof finalThreshold === 'number' ? finalThreshold : (typeof maxDistance === 'number' ? maxDistance : Number(env.SEARCH_MAX_DISTANCE || 0.7));

      let eligible = typeFilteredAll;
      const metricType = hasDistanceKey ? 'distance' : (isSimilarityScore ? 'similarity' : 'unknown');
      if (metricType === 'distance') {
        eligible = typeFilteredAll.filter((r) => {
          const d = typeof r._distance === 'number' ? r._distance : r.distance;
          return typeof d === 'number' ? d <= thr : true;
        });
      } else if (metricType === 'similarity') {
        const minScore = Math.max(0, Math.min(1, 1 - thr));
        eligible = typeFilteredAll.filter((r) => {
          const s = r.score;
          return typeof s === 'number' ? s >= minScore : true;
        });
      }

      const boosted = eligible.map((r, idx) => {
        const titleTokens = tokensFromText(r.title || r.snippet?.title || '');
        const descTokens = tokensFromText(r.description_indexed || r.snippet?.description || '');
        let hitsTitle = 0, hitsDesc = 0;
        for (const t of tokensWanted) {
          if (titleTokens.has(t)) hitsTitle++;
          if (descTokens.has(t)) hitsDesc++;
        }
        const boostRaw = hitsTitle * hs.titleWeight + hitsDesc * hs.descWeight;
        const boost = Math.max(0, boostRaw) * hs.boostFactor;
        return { r, idx, boost, hitsTitle, hitsDesc };
      });

      // Add extra out-of-threshold with token hits
      const idsEligible = new Set(eligible.map((r) => r.id));
      const extras = typeFilteredAll.filter((r) => !idsEligible.has(r.id)).map((r, idx) => {
        const titleTokens = tokensFromText(r.title || r.snippet?.title || '');
        const descTokens = tokensFromText(r.description_indexed || r.snippet?.description || '');
        let hitsTitle = 0, hitsDesc = 0;
        for (const t of tokensWanted) {
          if (titleTokens.has(t)) hitsTitle++;
          if (descTokens.has(t)) hitsDesc++;
        }
        const hasHits = (hitsTitle + hitsDesc) > 0;
        if (!hasHits) return null;
        const boostRaw = hitsTitle * hs.titleWeight + hitsDesc * hs.descWeight;
        const boost = Math.max(0, boostRaw) * hs.boostFactor;
        return { r, idx, boost, hitsTitle, hitsDesc, outsideThreshold: true };
      }).filter(Boolean);

      boosted.push(...extras);
      boosted.sort((a, b) => {
        if (b.boost !== a.boost) return b.boost - a.boost;
        return a.idx - b.idx;
      });

      // Deduplicate by id
      const seenIds = new Set();
      const uniq = [];
      for (const item of boosted) {
        const id = item?.r?.id;
        if (id && !seenIds.has(id)) { seenIds.add(id); uniq.push(item); }
      }

      selectedRows = uniq.slice(0, k).map((x) => x.r);

      // Report
      console.log('=== Hybrid Boost Report ===');
      for (const item of uniq.slice(0, k)) {
        const r = item.r;
        console.log(`id=${r.id} | boost=${item.boost.toFixed(3)} | hitsTitle=${item.hitsTitle} | hitsDesc=${item.hitsDesc} | outside=${item.outsideThreshold ? 'yes' : 'no'}`);
      }
    }

    // Fetch vectors for selected rows and compute real distances to qVec
    const ids = selectedRows.map((r) => r.id).filter(Boolean);
    if (ids.length) {
      // LanceDB query API: select needed columns
      let q = table.query();
      if (typeof q.where === 'function') q = q.where(`id IN (${ids.map((id) => `'${id}'`).join(',')})`);
      const res2 = await q.select(['id', 'title', 'description_indexed', 'vector', 'type', 'published_at']).toArray();
      const byId = new Map(res2.map((x) => [x.id, x]));

      console.log('=== Final Top-K with vectors ===');
      for (let i = 0; i < selectedRows.length; i++) {
        const r = selectedRows[i];
        const doc = byId.get(r.id);
        const vec = doc?.vector;
        const dist = vec ? euclideanDistance(qVec, vec) : undefined;
        const score = r._distance ?? r.score ?? r.distance ?? undefined;
        console.log(`#${i+1} id=${r.id} | title=${(r.title || '(no title)').slice(0, 80)}\n  providerScore=${typeof score==='number' ? score.toFixed(6) : String(score)} | euclidDist=${typeof dist==='number' ? dist.toFixed(6) : 'n/a'}\n  type=${r.type || doc?.type || 'unknown'}\n  titleTokens=${Array.from(tokensFromText(r.title || '')).slice(0, 10).join(', ')}\n  descTokens=${Array.from(tokensFromText(r.description_indexed || '')).slice(0, 10).join(', ')}`);
      }
    } else {
      console.log('=== Final Top-K: empty ===');
    }

    // Sanity assertions (non-strict): just ensure no throw and shape is correct
    expect(Array.isArray(selectedRows)).toBe(true);
    expect(selectedRows.length).toBeLessThanOrEqual(k);
  }, 60_000);
});