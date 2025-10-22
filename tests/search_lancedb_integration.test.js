import { describe, it, expect, beforeEach, vi } from 'vitest'

beforeEach(() => {
  process.env.SEARCH_MAX_K = '5'
  process.env.SEARCH_MAX_DISTANCE = '0.7'
  process.env.SEARCH_ADAPTIVE_ITERS = '3'
  process.env.SEARCH_ADAPTIVE_STEP = '0.5'
  process.env.SEARCH_NORMALIZE_QUERY = '0'
  delete process.env.YOUTUBE_CHANNEL_ID
  process.env.LANCEDB_DIR = './tmp/lancedb_test'
})

// Мокаем зависимости, чтобы не трогать реальную LanceDB и файловую систему
vi.mock('../src/services/embeddings', () => ({
  embedTexts: vi.fn(async () => [[0.1, 0.2, 0.3]]),
  getProviderDistanceMax: vi.fn(() => 2),
}))

vi.mock('../src/services/concurrency/lock', () => ({
  isLocked: vi.fn(async () => false),
  waitForUnlock: vi.fn(async () => true),
  readLockInfo: vi.fn(async () => null),
}))

// ФС: чтобы openLatestTestTable нашёл "таблицу"
vi.mock('fs', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    mkdirSync: vi.fn(() => {}),
    readdirSync: vi.fn(() => ['video_embeddings_latest10']),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
  }
})

// LanceDB: возвращаем мок-таблицу с заранее заданными результатами
const mockRows = [
  { id: '1', title: 'A', _distance: 1.9, type: 'video' },
  { id: '2', title: 'B', _distance: 1.8, type: 'video' },
  { id: '3', title: 'C', distance: 2.1, type: 'video' }, // за пределами providerMax
]
const qb = {
  where: () => qb,
  filter: () => qb,
  prefilter: () => qb,
  limit: () => qb,
  toArray: () => mockRows,
}
const tableMock = {
  vectorSearch: () => qb,
  search: () => qb,
}

vi.mock('@lancedb/lancedb', () => ({
  connect: vi.fn(async () => ({
    openTable: vi.fn(async () => tableMock),
    createTable: vi.fn(),
  })),
}))


describe('searchTopK adaptive integration', () => {
  it('expands distance threshold via applyAdaptiveFilter and returns rows', async () => {
    vi.resetModules()

    // Жёстко мокаем env МОДУЛЬ до импорта lancedb
    vi.mock('../src/config/env.js', () => ({
      env: {
        SEARCH_MAX_K: 5,
        SEARCH_MAX_DISTANCE: 0.7,
        SEARCH_ADAPTIVE_ITERS: 3,
        SEARCH_ADAPTIVE_STEP: 0.5,
        SEARCH_NORMALIZE_QUERY: 0,
        YOUTUBE_CHANNEL_ID: 'UC7fI8SmlQm2Q9nNYkwiRatg',
        LANCEDB_DIR: './tmp/lancedb_test',
      },
      setGlobalChannelId: (val) => {},
    }))

    // На всякий случай перемокаем LanceDB после resetModules
    vi.mock('@lancedb/lancedb', () => ({
      connect: vi.fn(async () => ({
        openTable: vi.fn(async () => tableMock),
        createTable: vi.fn(),
      })),
    }))

    const mod = await import('../src/services/vector/lancedb.js')
    const out = await mod.searchTopK('hello world', 2, { mockTable: tableMock, mockTableName: 'video_embeddings_mock' })
    expect(out).toHaveLength(2)
    expect(out[0].id).toBe('1')
    expect(out[1].id).toBe('2')
    expect(out[0].score).toBe(1.9)
    expect(out[1].score).toBe(1.8)
  })
})