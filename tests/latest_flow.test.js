import { describe, it, expect } from 'vitest';
import { applyOrderingForLatest } from '../src/services/youtube/latest.js';

describe('latest flow: ordering and limits (pure)', () => {
  it('applies type filter before slice(k): returns first k of filtered', () => {
    const mapped = [
      { id: 'a', type: 'video' },
      { id: 'b', type: 'short' },
      { id: 'c', type: 'short' },
      { id: 'd', type: 'short' },
      { id: 'e', type: 'video' },
    ];
    const res = applyOrderingForLatest(mapped, 2, 'short');
    const ids = res.map((x) => x.id);
    expect(ids).toEqual(['b', 'c']);
  });

  it('returns first k when type is null', () => {
    const mapped = [
      { id: 'a', type: 'video' },
      { id: 'b', type: 'short' },
      { id: 'c', type: 'short' },
      { id: 'd', type: 'short' },
      { id: 'e', type: 'video' },
    ];
    const res = applyOrderingForLatest(mapped, 2, null);
    const ids = res.map((x) => x.id);
    expect(ids).toEqual(['a', 'b']);
  });
});