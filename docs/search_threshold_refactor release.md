# Рефакторинг порога поиска: адаптивная итерация

## Цели
- Упростить конфигурацию: один порог `SEARCH_MAX_DISTANCE` вместо мини/макс.
- Снизить количество пустых результатов: итеративно расширять порог до разумного предела.
- Нормализовать поведение между метриками (`distance`/`similarity`).

## Ключевые изменения
- Новый модуль `src/services/vector/adaptive_filter.js` с функцией `applyAdaptiveFilter(rows, k, { maxDistance, typeFilter, tableName })`.
- `src/services/vector/lancedb.js` вызывает `applyAdaptiveFilter` после первичного поиска в LanceDB.
- Используются `getProviderDistanceMax(chain)` и карта `providerMeta` из `src/services/embeddings/index.js`.
- Fallback: если итерации не дали результатов — вернуть `top‑k` без порога.

## Env
- `SEARCH_MAX_DISTANCE` — стартовый порог.
- `SEARCH_ADAPTIVE_ITERS` — макс. число итераций (дефолт 3).
- `SEARCH_ADAPTIVE_STEP` — шаг расширения порога (дефолт 0.1).

## Тесты
- Добавлен `tests/search_adaptive.test.js`: покрывает метрику `distance`, `similarity` и неизвестные случаи.
- Уточнены интеграционные тесты в `tests/search_unified_integration.test.js` при необходимости.
- План: добавить юнит-тесты для `getProviderDistanceMax` на разные цепочки провайдеров.

## Миграция
- Удалить старые настройки `SEARCH_MAX_DISTANCE_MIN/MAX` из README и кода.
- Обновить документацию: `docs/search_adaptive_algorithm.md` и этот файл.
- Проверить совместимость скриптов, использующих LanceDB.

## Дополнительно
- Логирование итераций (`from`, `to`, `iter`) помогает анализировать поведение.
- Алгоритм не меняет бизнес-логику ранжирования, только гарантирует ненулевой результат.