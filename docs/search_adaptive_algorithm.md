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

## Псевдокод адаптации (lancedb.js)
```js
function adaptiveSearch({ query, k, type, channelId }) {
  let threshold = env.SEARCH_MAX_DISTANCE; // старт
  const iters = Number(env.SEARCH_ADAPTIVE_ITERS || 3);
  const step = Number(env.SEARCH_ADAPTIVE_STEP || 0.1);
  const distanceMaxProvider = getProviderDistanceMax(resolveProviderChain());

  for (let i = 0; i <= iters; i++) { // первая попытка — i=0
    const rows = searchOnce(query, k, { maxDistance: threshold, type, channelId });
    const filtered = applyTypeAndDistance(rows, type, threshold);
    if (filtered.length) return filtered.slice(0, k);

    // пусто: подготовить следующий порог
    const next = Math.min(threshold + step, distanceMaxProvider);
    if (next <= threshold) break; // достигли предела
    log.warn({ from: threshold, to: next, i }, 'Адаптивный порог: повышаю');
    threshold = next;
  }

  // fallback: вернуть top-k без порога (или с максимумом)
  const rowsAll = searchOnce(query, k, { maxDistance: distanceMaxProvider, type, channelId });
  return applyTypeAndDistance(rowsAll, type, distanceMaxProvider).slice(0, k);
}
```

## Особые случаи
- Если провайдер возвращает `similarity` вместо `distance`, используется эквивалентная адаптация `minScore = 1 - threshold` с повышением порога за счёт снижения минимальной схожести.
- Если метрика не распознана (нет `_distance|distance|score`), возвращается топ‑k без порога и с предупреждением в лог.

## Логирование
- На каждой итерации: `{ from, to, i, k, providerMax }`.
- Финальный итог: `count`, `finalThreshold`, `metricType`.

## Тестирование
- Юнит: проверка итераций при пустом первом проходе.
- Интеграция: фикстуры с заранее известными `distance`, когда `threshold` < лучших кандидатов.
- Граничные: `SEARCH_ADAPTIVE_ITERS=0` (одна попытка), `SEARCH_ADAPTIVE_STEP` очень мал/большой, `distanceMaxProvider` < стартового порога.

## Миграция
- Удаление `SEARCH_MAX_DISTANCE_MIN/MAX`.
- Переписать тесты и README.
- Игнорировать пользовательские значения `threshold` в настройках.

## Дорожная карта
1) Внедрить `providerMeta` и хелпер `getProviderDistanceMax`.
2) Обновить env и README.
3) Переписать адаптацию в LanceDB на итеративную.
4) Убрать порог из `settings_store` и команды из `index.js`.
5) Обновить тесты и CI.
6) Проверить скрипты `search_latest_10.js` и унифицировать с новой логикой.