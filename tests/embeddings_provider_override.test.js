import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  delete process.env.EMBEDDINGS_PROVIDER_CHAIN;
  delete process.env.EMBEDDINGS_PROVIDER;
});

async function loadEmbeddingsModule() {
  const mod = await import('../src/services/embeddings/index.js');
  return mod.default || mod; // CJS interop
}

describe('resolveProviderChain overrides', () => {
  it('uses EMBEDDINGS_PROVIDER_CHAIN from process.env when set', async () => {
    process.env.EMBEDDINGS_PROVIDER_CHAIN = 'google, openai';
    const api = await loadEmbeddingsModule();
    const chain = api.resolveProviderChain();
    expect(chain).toEqual(['google', 'openai']);
  });

  it('uses EMBEDDINGS_PROVIDER when chain is not provided', async () => {
    process.env.EMBEDDINGS_PROVIDER = 'xenova';
    const api = await loadEmbeddingsModule();
    const chain = api.resolveProviderChain();
    expect(chain[0]).toBe('xenova');
  });

  it('falls back to a non-empty chain when no overrides', async () => {
    delete process.env.EMBEDDINGS_PROVIDER_CHAIN;
    delete process.env.EMBEDDINGS_PROVIDER;
    const api = await loadEmbeddingsModule();
    const chain = api.resolveProviderChain();
    expect(Array.isArray(chain)).toBe(true);
    expect(chain.length).toBeGreaterThan(0);
    const allowed = ['google', 'openai', 'mistral', 'xenova', 'ollama'];
    // ensure all resolved providers are known
    for (const p of chain) {
      expect(allowed).toContain(p);
    }
  });
});