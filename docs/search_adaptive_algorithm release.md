# Адаптивный алгоритм повышения порога поиска

Цель: гарантировать результат для пользователя без ручной настройки порога. Если первый поиск пустой, система временно повышает порог `SEARCH_MAX_DISTANCE` итеративно, ограниченное число раз, и не выходит за верхнюю границу метрики конкретного провайдера эмбеддингов.

## Термины и предпосылки
- Метрика distance: для косинусной «distance» (1 − cosine similarity) диапазон обычно [0..2]. Чем меньше, тем ближе.
- Провайдеры эмбеддингов могут отличаться. Нужна карта: `providerMeta[provider].distanceMax`.
- Основной порог — `env.SEARCH_MAX_DISTANCE`. Минимального порога нет.
- Итерируем до результата или до ограничения по шагам/пределу метрики.

## Параметры (.env)
- `SEARCH_MAX_DISTANCE`: стартовый порог (например, `0.7`).
- `SEARCH_ADAPTIVE_ITERS`: максимально допустимое количество итераций (дефолт `3`).
- `SEARCH_ADAPTIVE_STEP`: шаг увеличения порога (дефолт `0.1`).

## Хелперы (embeddings/index.js)
- `providerMeta`: карта максимума distance и типа метрики.
- `getProviderDistanceMax(chain)`: берёт первый доступный провайдер из цепочки и возвращает его `distanceMax`; если неизвестно — `2`.

## Реализация (модуль adaptive_filter)
- Модуль: `src/services/vector/adaptive_filter.js` экспортирует `applyAdaptiveFilter(rows, k, { maxDistance, typeFilter, tableName })`.
- Использование: вызывается из `lancedb.js` после первичного запроса в LanceDB — делает итеративную фильтрацию и безопасный fallback.

### Пример использования в LanceDB
```js
const { applyAdaptiveFilter } = require('./adaptive_filter');

// внутри searchTopK
const maxDistance = typeof opts.maxDistance === 'number' ? opts.maxDistance : env.SEARCH_MAX_DISTANCE;
const finalRows = applyAdaptiveFilter(rows, k, { maxDistance, typeFilter, tableName });
```

### Логика `applyAdaptiveFilter`
- Если в строках есть `_distance`/`distance`: фильтрация по `<= maxDistance` с итеративным расширением до `getProviderDistanceMax()`.
- Если есть только `score`: используется эквивалент `minScore = 1 - maxDistance`; при расширении порога `minScore` уменьшается.
- Если метрика неизвестна: fallback — вернуть `top-k` без порога.
- На каждой итерации логируется предупреждение: `from`, `to`, `iter`.

## Псевдокод адаптации
```js
function adaptiveSearch({ query, k, type, channelId }) {
  let threshold = env.SEARCH_MAX_DISTANCE; // старт
  const iters = Number(env.SEARCH_ADAPTIVE_ITERS || 3);
  const step = Number(env.SEARCH_ADAPTIVE_STEP || 0.1);
  const distanceMaxProvider = getProviderDistanceMax();

  for (let i = 0; i <= iters; i++) { // первая попытка — i=0
    const rows = searchOnce(query, k, { maxDistance: threshold, type, channelId });
    const filtered = applyTypeAndDistance(rows, type, threshold);
    if (filtered.length) return filtered.slice(0, k);

    const next = Math.min(threshold + step, distanceMaxProvider);
    if (next <= threshold) break; // достигли предела
    logger.warn({ from: threshold, to: next, iter: i+1 }, 'Адаптивный порог: повышаю');
    threshold = next;
  }

  // fallback: вернуть top-k без порога
  const rowsAll = searchOnce(query, k, { maxDistance: distanceMaxProvider, type, channelId });
  return applyTypeAndDistance(rowsAll, type, distanceMaxProvider).slice(0, k);
}
```

## Особые случаи
- Если провайдер возвращает `similarity` вместо `distance`, используется эквивалентная адаптация `minScore = 1 - threshold`.
- Если метрика не распознана (нет `_distance|distance|score`), возвращается `top‑k` без порога и пишется предупреждение в лог.

## Логирование
- На каждой итерации: `{ from, to, iter }`.
- Финальный итог: `{ count, finalThreshold, metricType }`.

## Тестирование
- Юнит: проверка итераций при пустом первом проходе.
- Интеграция: фикстуры с заранее известными `distance`/`score`, где стартовый порог меньше лучших кандидатов.
- Граничные: `SEARCH_ADAPTIVE_ITERS=0`, очень мал/большой `SEARCH_ADAPTIVE_STEP`, стартовый порог выше `distanceMaxProvider`.

## Миграция
- Удалить `SEARCH_MAX_DISTANCE_MIN/MAX`.
- Переписать тесты и README.
- Игнорировать порог пользователя в настройках.

## Семантика порога
- Глобальный порог: используется `SEARCH_MAX_DISTANCE` из `.env`; пользовательский порог в настройках удалён и игнорируется.
- Отрицательный стартовый порог или слишком малое значение: адаптация автоматически повышает порог до разумного уровня, не превышая `getProviderDistanceMax()` провайдера.
- Для метрики similarity порог интерпретируется эквивалентно: повышение допускает кандидатов с более низкой минимальной схожестью.