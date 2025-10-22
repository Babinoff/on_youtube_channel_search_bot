![license](https://img.shields.io/badge/license-MIT-blue) ![powered_by](https://img.shields.io/badge/powered_by-LanceDB-orange) ![input](https://img.shields.io/badge/input-channelId%20%7C%20%40handle%20%7C%20url-555) ![output](https://img.shields.io/badge/output-LanceDB%20vectors%20%7C%20JSON%20logs-8bc34a) ![etl](https://img.shields.io/badge/ETL_pipeline-ready-brightgreen) ![ci](https://img.shields.io/badge/Ready_for-CI%2FCD_%26_Bots-brightgreen) ![tests](https://img.shields.io/badge/tests-12_files_%7C_35_passing-success) ![pricing](https://img.shields.io/badge/pricing-free-blue)

# YouTube RAG Bot — README

Проект: Telegram‑бот и CLI‑скрипты для индексации YouTube‑видео в локальную векторную базу (LanceDB) и семантического поиска по ним. Скрипты читают канал, чистят описания, получают эмбеддинги (переключаемые провайдеры) и сохраняют документы. Бот отдаёт последние видео и ищет по базе.

## Быстрый старт
- Требования: `Node.js LTS`, доступ к YouTube API и провайдеру эмбеддингов.
- Установка:
  - Скопируйте `.env.example` → `.env` и заполните ключи.
  - Установите зависимости: `npm install`.
- Проверка окружения: `node src/scripts/env_check.js` — валидирует ключи и диапазоны (`k`) и выводит сводку.
- Запуск бота (polling): `npm run dev` или `npm start`.
- Предпросмотр очистки описаний: `npm run preview:index` (берёт канал из `.env`).
- Индексация на 10 видео: `npm run index:test -- <channelId|url|@handle>`.

## Переменные окружения
Обязательные ключи:
- `TELEGRAM_BOT_TOKEN` — токен бота.
- `YOUTUBE_API_KEY` — ключ YouTube Data API v3 (для «Последние» и индексации).

Админ‑доступ:
- `ADMIN_USER_ID` — числовой `userId` администратора Telegram. Только ему доступны команды из раздела «Админ».

Каналы:
- `YOUTUBE_CHANNEL_ID` — канал по умолчанию для CLI (используют `preview:index`, `index:batch`, `check:youtube`).
- `YOUTUBE_CHANNELS_ID` — список каналов, доступных пользователям в боте; CSV или `|` (например: `@my,UCabc123|https://youtube.com/@other`).

Эмбеддинги (переключаемый провайдер):
- `EMBEDDINGS_PROVIDER` — `xenova` (локально, без сети), `mistral`, `openai`, `google`. По умолчанию `xenova`.
- `EMBEDDINGS_PROVIDER_CHAIN` — цепочка фоллбэков через `,` или `|` (например: `mistral,xenova`).
- `MISTRAL_API_KEY` — ключ Mistral (если `EMBEDDINGS_PROVIDER=mistral`).
- `OPENAI_API_KEY` — ключ OpenAI (если `EMBEDDINGS_PROVIDER=openai`).
- Параметры устойчивости: `EMBEDDINGS_MAX_CONCURRENCY` (по умолчанию `1`), `EMBEDDINGS_BATCH_SIZE` (по умолчанию `8`), `EMBEDDINGS_MAX_ATTEMPTS` (по умолчанию `5`), `EMBEDDINGS_TIMEOUT_MS` (по умолчанию `30000`).

Очистка описаний и вывод:
- `DESC_MAX_CHARS` — единый лимит длины описания для `/latest` и индексации (по умолчанию `500`).
- `INDEX_DESC_STRIP_AFTER_PATTERNS` — CSV‑список паттернов; если любой встречается в описании, текст обрезается по первому совпадению.
- `INDEX_DESC_AD_LINE_PREFIX_CHARS` — CSV‑список префиксов строк, которые удаляются как рекламные.

Поиск:
- `SEARCH_TOP_K` — количество результатов по умолчанию (по умолчанию `5`).
- `SEARCH_MAX_K` — верхняя граница для пользовательского `k` (по умолчанию `20`).
- `SEARCH_MAX_DISTANCE` — максимальный порог дистанции (типично `0 < x ≤ 2`; по умолчанию `0.7`).
- `SEARCH_ADAPTIVE_ITERS` — число итераций адаптации порога (по умолчанию `3`; `0` отключает).
- `SEARCH_ADAPTIVE_STEP` — шаг увеличения порога на итерацию (по умолчанию `0.5`).
- `SEARCH_NORMALIZE_QUERY` — включить/выключить нормализацию текста запроса перед эмбеддингами (`true|false`, по умолчанию `true`).

Векторная БД и устойчивость:
- `VECTOR_DB` — `lancedb` (поддерживается текущей реализацией).
- `LANCEDB_DIR` — путь к данным LanceDB (по умолчанию `./data/lancedb`).
- `LANCEDB_INSERT_BATCH_SIZE`, `LANCEDB_INSERT_MAX_ATTEMPTS` — размер чанка и ретраи вставки.

Прочее:
- `DATABASE_URL` — путь к SQLite (метаданные).
- `TELEGRAM_SEND_DELAY_MS` — задержка между сообщениями бота (мс), помогает избежать rate‑limit.
- `INDEX_STOP_ON_FIRST_KNOWN` — остановить пагинацию на первом известном `videoId` при батч‑индексации (`true/false`, по умолчанию `false`).

## Нормализация описаний
Единая очистка для стабильных эмбеддингов и читаемого вывода:
1) Удаление рекламных строк по префиксам из `INDEX_DESC_AD_LINE_PREFIX_CHARS`.
2) Обрезка после первого совпадения из `INDEX_DESC_STRIP_AFTER_PATTERNS`.
3) Нормализация пробелов и трим.
4) Усечение по `DESC_MAX_CHARS`.

Логика используется в скриптах индексации (`index:test`, `index:batch`) и предпросмотра (`preview:index`), а также при выводе `/latest` в боте.

## Команды бота (Telegram)
- `/latest [канал]` — последние `k` видео канала (по умолчанию `k = SEARCH_TOP_K`).
  - Примеры: `/latest`, `/latest @handle`, `/latest https://youtube.com/channel/UC...`.
  - Описание очищается и усекается по `DESC_MAX_CHARS`.
- `/search <запрос> | k=10 | type=short|stream|video` — семантический поиск по LanceDB.
  - `k` клампится до `SEARCH_MAX_K`; порог distance берётся из `SEARCH_MAX_DISTANCE` (из `.env`).
    - Если результатов нет, порог адаптивно ослабляется до лучших кандидатов.
    - Текст запроса предварительно очищается (трим, одинарные пробелы). Дополнительно может применяться нормализация RU/EN (стемминг); управление через `SEARCH_NORMALIZE_QUERY` в `.env`.
    - Показ `score` управляется настройкой пользователя (включает/скрывает поле `score`).
- `/admin` — скрытое меню администратора (см. ниже).

## Админ‑команды (через `/admin`)
Доступны только пользователю с `ADMIN_USER_ID`:
- /lock_status [name] — показать статус блокировок.
- /lock_force [name] [--force] — принудительно снять блокировку.
- /channel_db_list — список таблиц каналов в LanceDB.
- /channel_db_delete <@хэндл YouTube-канала|channelId> --yes — удалить таблицу канала в LanceDB.
- /channel_stats [@хэндл YouTube-канала|channelId] — сводная статистика индексации по каналу.
- /channel_db_stats [@хэндл YouTube-канала|channelId] — статистика по LanceDB для канала (без запросов в YouTube).
- /check_youtube [@хэндл YouTube-канала|channelId] — проверка YouTube API: резолв канала и первые videoId.
- /index_latest [@хэндл YouTube-канала|channelId] — индексировать последние 10 видео канала.
- /index_batch [@хэндл YouTube-канала|channelId] [--limit N] [--stop-on-first-known on|off] — массовая индексация с лимитом и остановом на первом известном.
- /preview_latest — предпросмотр очистки последних 10 видео по .env.
- /search_latest <query> — тестовый поиск по тестовой таблице.
- /env_check — сводка и валидация окружения.
- /emb_status — статус провайдера эмбеддингов и размерность.

## Скрипты (CLI)
Все команды запускаются через `npm run <script> -- [аргументы]`.

- `check:youtube` — проверить доступность канала и плейлиста загрузок.
  - Пример: `npm run check:youtube -- <channelId|url|@handle>`.

- `preview:index` — предпросмотр очистки описаний и JSON‑документов (без эмбеддингов).
  - Канал берётся из `.env` (`YOUTUBE_CHANNEL_ID`) без аргументов.

- `index:test` — тестовая индексация 10 видео в временную таблицу.
  - Пример: `npm run index:test -- <channelId|url|@handle>`.

- `index:batch` — батч‑индексация N видео канала в таблицу канала.
  - Обязательные ключи: `--limit <число>`.
  - Примеры: `npm run index:batch -- --limit 500` или `npm run index:batch -- @handle --limit 500`.
  - Дополнительно: `--stop-on-first-known on|off` — ранняя остановка при встрече известного `videoId`.

- `search:test` — локальный поиск по тестовой таблице.
  - Пример: `npm run search:test -- BIM IFC SQLite`.
  - Вывод: `title`, `url`, метрика `score`, top‑5 по умолчанию.

- `lock:status` — статус лок‑файла (по умолчанию `indexing`).
- `lock:force` — принудительная разблокировка `indexing`.
- `channel:count` — вывести количество видео канала.
- `channel:stats` — сводка по каналу.
- `channel:db:list` — список таблиц каналов в LanceDB.
- `channel:db:delete` — удалить таблицу канала.
- `node src/scripts/env_check.js` — самопроверка окружения (если удобнее без `npm run`).

## Формат вывода и поиск
- Поиск: единая метрика `score` (раньше `_distance|distance`). `score` округляется до 6 знаков; результаты нумеруются.
- Нормализация параметров:
  - `k ∈ [1 .. SEARCH_MAX_K]`.
  - Тип фильтра: `short|stream|video|null`.
- Адаптивный порог:
  - При пустом результате поиск ослабляет порог до лучшего кандидата (distance) или понижает минимальную схожесть (similarity).
  - Пользовательский `threshold` в настройках удалён и игнорируется; используется глобальный `SEARCH_MAX_DISTANCE` из `.env`.
  - Если стартовый порог отрицательный или слишком мал, адаптация автоматически поднимет его до разумного значения, не превышая `getProviderDistanceMax()`.

## Окружение (.env)
- `SEARCH_MAX_DISTANCE` — порог distance по умолчанию (напр. `0.7`).
- «Последние»: `type`‑фильтр применяется до `slice(0, k)`; описание нормализуется и усекается по `DESC_MAX_CHARS`.
- Длинные сообщения Telegram режутся функцией `splitTextByLimit` (~3800 символов) без разрывов слов.

## Примеры
- Предпросмотр очистки по `.env`: `npm run preview:index`.
- Тестовая индексация 10 видео: `npm run index:test -- https://youtube.com/@mychannel`.
- Батч 500 видео без ранней остановки: `npm run index:batch -- @mychannel --limit 500 --stop-on-first-known off`.
- Поиск в тестовой таблице: `npm run search:test -- "BIM IFC SQLite"`.

## Тесты и CI
- Запуск без интерактивного режима: `npm run test:ci --silent`.
- Набор покрывает нормализацию описаний, параметры поиска, поток «Последние», парсинг админ‑команд и проверку окружения.

## Частые проблемы
- Неверная передача аргумента лимита: используйте `--limit 500`, а не `--500`.
- «Нечего добавлять»: собранные `videoId` уже в таблице — это нормально.
- Ошибка ключей: заполните `YOUTUBE_API_KEY` и ключ для выбранного `EMBEDDINGS_PROVIDER`.
- Отображение кириллицы в терминале Windows: установите кодировку UTF‑8:
  - PowerShell: `chcp 65001` и `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`.

## Примечания
- Эмбеддинги облачных провайдеров платные — индексация больших объёмов требует бюджета; включено кэширование и фоллбэки провайдеров.
- В `.gitignore` исключены `data/` и `.env` — храните ключи локально.
- Формат очистки описаний полностью управляется `.env` и единообразен в скриптах и боте.

## Примечания по тестированию
- Для детерминизма интеграционных тестов поиска добавлен тест‑хук в `searchTopK`: используйте `opts.mockTable` и `opts.mockTableName` для подстановки мок‑таблицы и обхода выбора таблицы канала.
- Это позволяет тесту не зависеть от реальных данных LanceDB и состояния каналов, подтверждая работу адаптивного порога и фильтра.
- Пример: в тесте передайте `mockTable` с заранее подготовленными строками и `mockTableName`, затем вызовите `searchTopK(query, k, { mockTable, mockTableName })`.
- Хук используется только в тестах и не влияет на продакшен‑поведение.