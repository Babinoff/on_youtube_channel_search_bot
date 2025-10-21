import { describe, it, expect, beforeEach, vi } from 'vitest';

let infoSpy, warnSpy, errorSpy;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = 'dummy';
  process.env.YOUTUBE_API_KEY = 'fake-key';
  process.env.SEARCH_MAX_K = '20';
  process.env.SEARCH_MAX_DISTANCE = '0.7';
  process.env.EMBEDDINGS_PROVIDER = 'xenova';
});

describe('env_check script', () => {
  it('logs success summary and does not call process.exit', async () => {
    vi.resetModules();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Импорт скрипта запускает main() сразу
    await import('../src/scripts/env_check.js');

    // exit не должен вызываться
    expect(exitSpy).not.toHaveBeenCalled();

    // Проверяем stdout от pino
    const written = writeSpy.mock.calls.map((args) => String(args[0]));
    const hasValidMsg = written.some((line) => line.includes('Окружение валидно'));
    const hasDoneMsg = written.some((line) => line.includes('Проверка окружения завершена успешно'));

    expect(hasValidMsg).toBe(true);
    expect(hasDoneMsg).toBe(true);

    writeSpy.mockRestore();
    exitSpy.mockRestore();
  });
});