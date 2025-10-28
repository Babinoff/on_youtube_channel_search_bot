import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  process.env.SEARCH_MAX_K = '5';
  process.env.SEARCH_MAX_DISTANCE = '0.7';
  process.env.SEARCH_ADAPTIVE_ITERS = '3';
  process.env.SEARCH_ADAPTIVE_STEP = '0.5';
  // EMBEDDINGS_PROVIDER_CHAIN default yields distanceMax=2
});

describe('adaptive threshold filtering', () => {
  it('expands distance threshold and returns rows when initial filter is empty', async () => {
    const { applyAdaptiveFilter } = await import('../src/services/vector/adaptive_filter.js');
    const rows = [
      { id: '1', title: 'A', _distance: 1.9, type: 'video' },
      { id: '2', title: 'B', _distance: 1.8, type: 'video' },
      { id: '3', title: 'C', distance: 2.1, type: 'video' },
    ];
    const maxDistance = Number(process.env.SEARCH_MAX_DISTANCE);
    const out = applyAdaptiveFilter(rows, 2, { maxDistance, typeFilter: 'video', tableName: 'test' });
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('1');
    expect(out[1].id).toBe('2');
  });

  it('adapts similarity minScore when only score is present', async () => {
    const { applyAdaptiveFilter } = await import('../src/services/vector/adaptive_filter.js');
    const rows = [
      { id: 'a', title: 'A', score: 0.25, type: 'video' },
      { id: 'b', title: 'B', score: 0.29, type: 'video' },
      { id: 'c', title: 'C', score: 0.28, type: 'video' },
    ];
    const maxDistance = Number(process.env.SEARCH_MAX_DISTANCE);
    const out = applyAdaptiveFilter(rows, 2, { maxDistance, typeFilter: 'video', tableName: 'test' });
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('a');
    expect(out[1].id).toBe('b');
  });

  it('falls back to top-k when metric is unknown (flag enabled)', async () => {
    process.env.SEARCH_FALLBACK_TOPK = 'true';
    const { env } = await import('../src/config/env.js');
    expect(env.SEARCH_FALLBACK_TOPK).toBe(true);
    const { applyAdaptiveFilter } = await import('../src/services/vector/adaptive_filter.js');
    const rows = [
      { id: 'x', title: 'X', type: 'video' },
      { id: 'y', title: 'Y', type: 'video' },
      { id: 'z', title: 'Z', type: 'video' },
    ];
    const maxDistance = Number(process.env.SEARCH_MAX_DISTANCE);
    const out = applyAdaptiveFilter(rows, 2, { maxDistance, typeFilter: 'video', tableName: 'test' });
    expect(out).toHaveLength(2);
    expect(out.map(r => r.id)).toEqual(['x', 'y']);
  });

  it('returns empty when metric is unknown and fallback disabled', async () => {
    process.env.SEARCH_FALLBACK_TOPK = 'false';
    const { applyAdaptiveFilter } = await import('../src/services/vector/adaptive_filter.js');
    const rows = [
      { id: 'x', title: 'X', type: 'video' },
      { id: 'y', title: 'Y', type: 'video' },
      { id: 'z', title: 'Z', type: 'video' },
    ];
    const maxDistance = Number(process.env.SEARCH_MAX_DISTANCE);
    const out = applyAdaptiveFilter(rows, 2, { maxDistance, typeFilter: 'video', tableName: 'test' });
    expect(out).toHaveLength(0);
  });
});