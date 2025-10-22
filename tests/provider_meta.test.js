import { describe, it, expect, beforeEach } from 'vitest';

// We import CommonJS module via dynamic import for Vitest ESM compatibility
async function getMax(chainInput) {
  const mod = await import('../src/services/embeddings/index.js');
  return mod.getProviderDistanceMax(chainInput);
}

beforeEach(() => {
  // Ensure defaults; providers all use cosine_distance with max=2 in code
  process.env.EMBEDDINGS_PROVIDER = '';
  process.env.EMBEDDINGS_PROVIDER_CHAIN = '';
});

describe('getProviderDistanceMax', () => {
  it('returns 2 for default chain (mistral,xenova)', async () => {
    const max = await getMax(['mistral', 'xenova']);
    expect(max).toBe(2);
  });

  it('returns 2 for single known provider', async () => {
    const max = await getMax(['openai']);
    expect(max).toBe(2);
  });

  it('returns 2 for unknown provider (falls back)', async () => {
    const max = await getMax(['unknown-provider']);
    expect(max).toBe(2);
  });

  it('uses first in chain only', async () => {
    const max = await getMax(['unknown', 'mistral']);
    expect(max).toBe(2);
  });
});