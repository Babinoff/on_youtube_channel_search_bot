# План: предотвращение и контроль пустых эмбеддингов (нулевых векторов)

Цель: исключить появление записей в LanceDB с пустым/невалидным вектором, быстро выявлять и устранять такие случаи, а также гарантировать корректное ранжирование (исключая «нулевые» записи из поисковой выдачи, но допускаЯ их в режим «Последние», где ранжирование идёт по дате).

## Контекст проблемы
- Зафиксирован случай видео `https://youtu.be/y57rJbIso5E` с `vector_dims=0` в таблицах двух провайдеров (embeddinggemma/xenova).
- Пустые векторы могут случайно попадать в топ‑K из-за особенностей метрики/фоллбеков и приводить к ложной «низкой дистанции» по любой строке запроса.
- Активный провайдер (EmbeddingGemma) сейчас рабочий; проблема — отсутствие защит и диагностики при индексации/вставке.

## Цели и требования
- Жёстко валидировать полученные эмбеддинги: не вставлять пустые/повреждённые вектора.
- Маркировать и/или учитывать «проблемные» записи (для режима «Последние» доступ — да; для обычного поиска — нет).
- Предоставить админ‑диагностику: скрипты и маршруты для поиска и отчёта по нулевым/невалидным вектором.
- Добавить автоматические уведомления администратору при появлении таких случаев.

## Реализовано (на текущий момент)
- Индексация: в `src/scripts/index_batch.js` добавлена строгая проверка эмбеддингов (`isValidVector`), управление стратегией на невалидных через флаги `EMBEDDINGS_STRICT_VALIDATION`, `EMBEDDINGS_ON_INVALID` (`skip|mark`), `EMBEDDINGS_MIN_DIMS`. При `mark` записи сохраняются с `invalid_vector=true` и `vector=null`; при `skip` — пропускаются. Добавлены предупреждающие логи.
- Индексация: улучшено логирование причин невалидных векторов в `index_batch.js` — фиксируются активный провайдер, фактические/минимальные размерности и конкретные причины (NaN/Inf, пустой текст, малая размерность и т. п.).
- Поиск: в `src/services/vector/lancedb.js` реализована фильтрация `invalid_vector` по умолчанию для векторного поиска, с фоллбеком на старые таблицы без этого поля (предикат убирается, а пост‑фильтрация выполняется на результатах). Проверено на канале `UCdHck-m1XM74K-eYvbj0PEw` — поиск успешно работает и исключает некорректные записи.
- Диагностика: добавлен скрипт `src/scripts/list_invalid_vectors.js`, который собирает записи с `vector=null`, нестандартным типом/размерностью или `invalid_vector=true`. Скрипт корректно обрабатывает отсутствие поля `invalid_vector` в старых таблицах. Пример запуска: `node src/scripts/list_invalid_vectors.js UCdHck-m1XM74K-eYvbj0PEw`.
- Совместимость: старые таблицы (до реиндексации) не содержат `invalid_vector`; для них используется пост‑фильтрация в поиске и диагностике. Рекомендуется пересоздать таблицы после завершения рефакторинга.
- Флаги окружения: добавлены/задействованы `EMBEDDINGS_STRICT_VALIDATION`, `EMBEDDINGS_ON_INVALID`, `EMBEDDINGS_MIN_DIMS`, `SEARCH_FILTER_INVALID_EMBEDS`.
- Провайдеры: приоритет процессных overrides для `EMBEDDINGS_PROVIDER_CHAIN` и `EMBEDDINGS_PROVIDER` реализован в `src/services/embeddings/index.js`; добавлен юнит‑тест `tests/embeddings_provider_override.test.js`.

## Архитектурные изменения
### 1) Валидация эмбеддингов на уровне индексации
- Правило валидности вектора: `Array.isArray(vector) && vector.length >= minDims && every(Number.isFinite) && l2norm≈1.0`. 
  - Рекомендуемый `minDims`: 256 (перекрывает большинство моделей), или провайдер‑специфичный (например, Xenova=384, EmbeddingGemma=768), если доступно.
- В `src/scripts/index_batch.js`:
  - После `embedTexts(...)` фильтровать результаты:
  - Скипать вставку документов, где `vector` невалиден.
  - Опционально: вставлять документ с флагом `invalid_vector=true` (и `vector: null`), только если хотим показывать его в «Последних».

Пример (псевдокод дифф):
```js
const isValidVector = (v) => Array.isArray(v) && v.length >= 256 && v.every(Number.isFinite);
const withInvalidFlag = String(env.EMBEDDINGS_ON_INVALID || 'mark') === 'mark';

const docs = [];
for (let i = 0; i < docsMeta.length; i++) {
  const vec = vectors[i];
  if (isValidVector(vec)) {
    docs.push({ ...docsMeta[i], vector: vec, invalid_vector: false });
  } else if (withInvalidFlag) {
    docs.push({ ...docsMeta[i], vector: null, invalid_vector: true });
    logger.warn({ id: docsMeta[i].id }, "Пустой/неверный эмбеддинг, invalid_vector=true");
  } else {
    logger.warn({ id: docsMeta[i].id }, "Пропуск вставки: пустой/неверный эмбеддинг");
  }
}

await addDocsToChannelTable(channelId, docs.filter(d => d.invalid_vector !== true));
```

- Новые env‑параметры:
  - `EMBEDDINGS_STRICT_VALIDATION=true` — включить строгую проверку.
  - `EMBEDDINGS_ON_INVALID=skip|mark` — стратегия при невалидном векторе (пропустить или пометить).
  - `EMBEDDINGS_MIN_DIMS=256` — минимальная размерность.

### 2) Маркировка и фильтрация в поиске
- Добавить логическую колонку `invalid_vector` в документы.
- В `searchTopK()` (src/services/vector/lancedb.js):
  - По умолчанию исключать `invalid_vector=true` из обычного поиска (до `vectorSearch`, через `where`/`filter`, если доступно).
  - В режиме «Последние» (новый опциональный режим) возвращать записи независимо от `invalid_vector`, сортируя по `published_at` (без вызова `vectorSearch`).

Псевдокод фильтра:
```js
const latestMode = Boolean(opts.latestMode);
if (!latestMode) {
  // префильтр
  if (typeof qb.where === 'function') qb = qb.where("invalid_vector != true");
}
// latestMode: используем table.query() с сортировкой по published_at, limit=k
```

### 3) Админ‑диагностика и видимость
- Скрипт `find_zero_vectors.js`: обойти все таблицы `video_embeddings_*`, выбрать документы с `vector == null` или `vector.length == 0` или `invalid_vector == true`, вывести отчёт.
- Скрипт `reindex_one.js`: по `videoId` заново получить детали, вызвать `embedTexts`, перезаписать запись (если вектор стал валидным — снять флаг).
- Расширить `emb_status.js`:
  - Показать счётчик `invalid_vector` записей для активной таблицы канала.
  - Включить статистику по размерностям (min/max/avg) среди валидных.
- Админ‑маршрут (например, `/admin/diagnostics/invalid-embeds`): список проблемных видео + кнопка реиндексации.
- Уведомления: при индексации, если обнаружены невалидные — отправить администратору сообщение (через `notifyAdminProgress`).

### 4) Схема LanceDB (опционально)
- Рассмотреть явную схему с `FixedSizeList(Float32, dims)` для `vector` — жёсткое ограничение размерности на уровне хранения.
- Плюсы: аппаратный контроль несоответствия.
- Минусы: гибкость ниже; при смене модели потребуется миграция.
- Если остаёмся на динамической схеме, строго фильтруем перед вставкой и дополнительно маркируем.

## Изменения в тестах
- Добавить юнит‑тесты на валидацию:
  - Индексатор пропускает/маркирует документ, если `vector` пустой.
  - Поиск исключает `invalid_vector=true` (кроме `latestMode`).
- Интеграционный тест на `emb_status.js`: корректно отчёт по invalid.

## Миграция и развёртывание
1) Внести флаги `.env`:
   - `EMBEDDINGS_STRICT_VALIDATION=true`
   - `EMBEDDINGS_ON_INVALID=mark` (или `skip`)
   - `SEARCH_FILTER_INVALID_EMBEDS=true` (новый флаг для поиска)
2) Внести изменения в `index_batch.js` (валидация/маркировка) и `lancedb.js` (фильтрация/режим latest).
3) Пересоздать таблицы канала и переиндексировать (как уже запланировано).
4) Запустить `find_zero_vectors.js` и убедиться, что отчёт пуст или понятен.
5) Проверить поисковую выдачу и режим «Последние».

## Наблюдаемость и логирование
- Ввести чёткие логи на каждый случай невалидного вектора (id, провайдер, причина).
- Метрики: счётчик invalid per таблица/канал; процент невалидных среди новых вставок.
- Админ‑уведомления при пороге (например, ≥1 невалидных за индексацию).

## Риски и кейсы
- Смена модели (другая размерность): избегать жёсткого `== dims`, проверять диапазон `>= minDims`.
- Временные сбои провайдера: стратегия `EMBEDDINGS_PROVIDER_CHAIN` + ретраи; при окончательном пустом — `mark` и задача на переиндексацию позже.
- «Последние» без `vector`: используем plain‑query по дате, не вызываем `vectorSearch`.

## Краткий чеклист задач
- Индексация: добавить строгую валидацию и стратегию skip/mark.
- Поиск: исключить `invalid_vector` из выдачи; добавить `latestMode`.
- Диагностика: скрипт поиска invalid; реиндекс одного видео; отчёты в `emb_status.js`.
- Админ: маршрут и уведомления.
- Тесты: покрыть валидаторы/фильтры.
- Миграция: флаги, пересоздание таблиц, переиндексация.

## Инструменты выборочной переиндексации (только для нулевых векторов)

Цель: безопасно и быстро переиндексировать только проблемные видео (с `vector` пустым/`invalid_vector=true`) с временно скорректированными параметрами, не затрагивая остальную базу.

- Скрипт `reindex_zero_vectors.js` (предлагаемый):
  - Поиск всех записей с `vector == null` или `vector.length == 0` или `invalid_vector == true`.
  - Флаги запуска:
    - `--channel <channelId>`: ограничить переиндексацию одним каналом (иначе — все таблицы).
    - `--provider_override <chain>`: переопределить цепочку провайдеров, напр. `embeddinggemma|xenova`.
    - `--min_dims <n>`: временный минимум размерности для валидатора (перезаписывает `EMBEDDINGS_MIN_DIMS`).
    - `--texts_per_batch <n>`: уменьшить размер батча эмбеддинга (снижает вероятность таймаутов/лимитов).
    - `--max_retries <n>`, `--retry_delay_ms <ms>`, `--timeout_ms <ms>`: ретраи и таймауты на время запуска.
    - `--desc_max_chars <n>`: увеличить лимит нормализованного описания (если причина — чрезмерная усечка).
    - `--normalize_strategy <name>`: альтернативная нормализация (например, оставить эмодзи/ссылки или удалить).
    - `--dry_run`: только отчёт целей и предполагаемых параметров, без записи.
    - `--concurrency <n>`: безопасная параллельность (рекомендовано 1–3).
    - `--persist_invalid mark|skip`: как записывать оставшиеся невалидные (снять флаг/пометить/пропустить).

- Скрипт `reindex_selected.js` (предлагаемый):
  - Переиндексация по списку видео:
    - `--ids <id1,id2,...>` или `--file ids.txt`.
    - Поддерживает те же override‑флаги, что и `reindex_zero_vectors.js`.
  - Логика:
    - Получить детали видео (title/description_raw, `published_at`).
    - Применить нормализацию/усечение по override.
    - Вызвать `embedTexts` с `provider_override` и таймаутами/ретраями.
    - Провалидировать вектор и выполнить `upsert` в таблицу канала.
    - Если валиден — `invalid_vector=false`, очистить `invalid_reason`.

- Хранение метаданных запуска:
  - Добавить поля в документ или отдельную служебную таблицу:
    - `reindex_attempts` (int), `last_reindex_params` (json), `last_reindex_at` (timestamp).

Примеры usage (npm‑скрипты в `package.json`):
- `npm run reindex:zero -- --channel UCdHck-m1XM74K-eYvbj0PEw --provider_override embeddinggemma|xenova --min_dims 256 --max_retries 5 --texts_per_batch 1 --timeout_ms 30000`
- `npm run reindex:selected -- --ids y57rJbIso5E --provider_override xenova --desc_max_chars 4000 --retry_delay_ms 1500`

## Логирование причин нулевых векторов

Ввести унифицированные коды причин и подробную телеметрию, чтобы понимать, что именно привело к пустому/невалидному вектору и какие корректировки помогают:

- Коды причин:
  - `E_EMPTY_TEXT`: после нормализации текст стал пустым.
  - `E_TOO_SHORT_TEXT`: текст недостаточно информативен (мини‑порог длины).
  - `E_NORMALIZATION_EMPTIED`: стратегия нормализации удалила всё содержимое.
  - `E_PROVIDER_TIMEOUT`: провайдер не успел вернуть ответ.
  - `E_PROVIDER_RATE_LIMIT`: провайдер отдал лимит/429.
  - `E_PROVIDER_ERROR`: иная ошибка провайдера.
  - `E_EMBED_RETURNED_NULL`: провайдер вернул `null`/`undefined`/пустой массив без ошибки.
  - `E_DIM_MISMATCH`: длина вектора меньше минимума/не совпадает с ожидаемой для провайдера.
  - `E_NAN_OR_INF`: в векторе найдены нечисловые/бесконечные значения.
  - `E_ZERO_NORM`: L2‑норма ≈ 0 (некорректный эмбеддинг).
  - `E_SAVE_FAILED`: ошибка записи/`upsert` в LanceDB.

- Что логируем на каждый случай:
  - `video_id`, `url`, `channel_id`, `provider_chain` (порядок попыток), `chosen_provider`, `expected_dims` vs `actual_dims`.
  - `title_len`, `desc_raw_len`, `desc_indexed_len`, число токенов (если доступно).
  - `timeout_ms`, `max_retries`, `retry_delay_ms`, `texts_per_batch`, `desc_max_chars`, `normalize_strategy`.
  - `attempt`, `duration_ms`, `timestamp`, `stack/errmsg`.

- Куда логируем:
  - Структурированный файл `logs/embeddings/yyyy-mm-dd.ndjson`.
  - Админ‑уведомления (сводка по кодам причин за индексацию).
  - Поля в документе: `invalid_vector`, `invalid_reason`, `invalid_at`, `invalid_provider`, `invalid_attempts`.

## Могут ли параметры исправить ранее не созданный вектор?

Да, в ряде сценариев корректировки помогают.

- Вероятно исправимо:
  - Недоступность/таймауты провайдеров: увеличить `timeout_ms`, `max_retries`, `retry_delay_ms`; изменить `provider_chain` (перейти на резервного).
  - Лимиты/429: снизить `concurrency`, уменьшить `texts_per_batch`.
  - Слишком жёсткая усечка/нормализация (`DESC_MAX_CHARS`, агрессивные фильтры): увеличить лимит, смягчить стратегию; как минимум всегда использовать `title` (fallback), чтобы текст не пустел.
  - Несоответствие размерности: убедиться, что выбран правильный провайдер; задать валидатор по `>= minDims` и фиксировать фактическую длину.
  - `NaN/Inf`/норм≈0: часто лечится сменой провайдера или ретраями при сбоях.

- Маловероятно исправимо только параметрами:
  - Недоступны детали видео (удалено/приватно/API отказало).
  - Детерминированная ошибка конкретного провайдера на данном тексте (требует смены модели).

- Рекомендованные пресеты для переиндексации:
  - «Надёжный»: `max_retries=5`, `retry_delay_ms=1500`, `timeout_ms=30000`, `texts_per_batch=1`, `provider_override=embeddinggemma|xenova`.
  - «Агрессивный»: `timeout_ms=60000`, `max_retries=7`, `retry_delay_ms=2000`, `concurrency=1`.
  - «Фоллбек‑только»: `provider_override=xenova` (или другой второй провайдер) + уменьшенные батчи.

## API и пакетные команды

- `reindex:zero`: пакетная переиндексация всех проблемных видео с override‑параметрами.
- `reindex:selected`: переиндексация по списку id (файл или CLI‑список).
- `logs:invalid-embeds`: сбор и агрегация логов причин за период.

Примеры:
- `npm run reindex:zero -- --channel UC... --provider_override embeddinggemma|xenova --min_dims 256 --max_retries 5 --texts_per_batch 1 --timeout_ms 30000`
- `npm run reindex:selected -- --ids <videoId1,videoId2> --desc_max_chars 4000 --normalize_strategy keep-links`
- `npm run logs:invalid-embeds -- --since 24h`

## Дополнения к схеме LanceDB

- Новые поля в документе:
  - `invalid_vector` (bool), `invalid_reason` (string), `invalid_provider` (string), `invalid_at` (timestamp),
  - `reindex_attempts` (int), `last_reindex_params` (json), `last_reindex_at` (timestamp).
- При сохранении — строгая валидация: запись валидного вектора снимает флаг и очищает причину.