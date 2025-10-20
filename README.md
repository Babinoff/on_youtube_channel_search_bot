# YouTube RAG Bot — README

Проект: Telegram‑бот и CLI‑скрипты для индексации YouTube‑видео в локальную векторную базу (LanceDB) и семантического поиска по ним. Скрипты читают канал, чистят описания, получают эмбеддинги (Mistral) и сохраняют документы. Бот отдаёт последние видео и ищет по базе.

## Быстрый старт
- Требования: `Node.js LTS`, доступ к YouTube API и Mistral API.
- Установка:
  - Скопируйте `.env.example` → `.env` и заполните ключи.
  - Установите зависимости: `npm install`.
- Запуск бота (polling): `npm run dev` или `npm start`.
- Проверка индексации на 10 видео: `npm run index:test -- <channelId|url|@handle>`.
- Предпросмотр очистки описаний: `npm run preview:index` (берёт канал из `.env`).

## Переменные окружения
Обязательные:
- `TELEGRAM_BOT_TOKEN` — токен бота.
- `YOUTUBE_API_KEY` — ключ YouTube Data API v3.
- `MISTRAL_API_KEY` — ключ Mistral API (эмбеддинги).

Канал:
- `YOUTUBE_CHANNELS_ID` — список каналов, доступных пользователям в боте; CSV или `|` (например: `@my,UCabc123|https://youtube.com/@other`).

Ограничения и очистка описаний:
- `DESC_MAX_CHARS` — единый лимит длины описания для `/latest` и индексации (по умолчанию `500`).
- `INDEX_DESC_STRIP_AFTER_PATTERNS` — CSV‑список паттернов; если любой встречается в описании, текст обрезается по первому совпадению.
- `INDEX_DESC_AD_LINE_PREFIX_CHARS` — CSV‑список символов/маркеров; строки, начинающиеся с любого из них, удаляются при предочистке.

Поиск:
- `SEARCH_MAX_DISTANCE` — порог семантической «дистанции» (меньше — строже), по умолчанию `0.7`.
- `SEARCH_TOP_K` — количество результатов по умолчанию, по умолчанию `5`.

Векторная БД (LanceDB) и устойчивость:
- `VECTOR_DB` — `lancedb` (поддерживается текущей реализацией).
- `LANCEDB_DIR` — путь к данным LanceDB (по умолчанию `./data/lancedb`).
- `LANCEDB_INSERT_BATCH_SIZE`, `LANCEDB_INSERT_MAX_ATTEMPTS` — размер чанка и ретраи вставки.

Эмбеддинги:
- `EMBEDDINGS_BATCH_SIZE`, `EMBEDDINGS_MAX_ATTEMPTS`, `EMBEDDINGS_TIMEOUT_MS` — батчи и ретраи для запроса эмбеддингов.

Прочее:
- `DATABASE_URL` — путь к SQLite (метаданные).
- `TELEGRAM_SEND_DELAY_MS` — задержка между сообщениями бота (мс), помогает избежать rate‑limit.
- `INDEX_STOP_ON_FIRST_KNOWN` — остановить пагинацию на первом известном `videoId` при батч‑индексации (по умолчанию `false` для dev).

## Нормализация описаний
Для стабильных эмбеддингов и читаемого вывода применяется единая очистка:
1) Удаление рекламных строк по префиксам из `INDEX_DESC_AD_LINE_PREFIX_CHARS`.
2) Обрезка после первого совпадения из `INDEX_DESC_STRIP_AFTER_PATTERNS`.
3) Нормализация пробелов и трим.
4) Усечение по `DESC_MAX_CHARS`.

Эта логика используется в скриптах индексации (`index:test`, `index:batch`) и предпросмотра (`preview:index`), а также при выводе `/latest` в боте.

## Скрипты (CLI)
Все команды запускаются через `npm run <script> -- [аргументы]`.

- `check:youtube` — проверить доступность канала и плейлиста загрузок.
  - Пример: `npm run check:youtube -- <channelId|url|@handle>`.
  - Результат: резолв канала, плейлист загрузок, список `videoId` первой страницы.

- `preview:index` — предпросмотр очистки описаний и JSON‑документов (без эмбеддингов).
  - Канал берётся из `.env` (`YOUTUBE_CHANNEL_ID`) без аргументов.
  - Показывает «raw» и «cleaned» описание, а также JSON‑объект, который пойдёт в БД.

- `index:test` — тестовая индексация 10 видео в временную таблицу.
  - Пример: `npm run index:test -- <channelId|url|@handle>`.
  - Действия: резолв канала → загрузка 10 `videoId` → детали → очистка описаний → эмбеддинги (Mistral) → создание тестовой таблицы LanceDB и вставка.

- `index:batch` — батч‑индексация N видео канала в таблицу канала.
  - Обязательные ключи: `--limit <число>`.
  - Пример (берёт канал из .env): `npm run index:batch -- --limit 500`.
  - Пример (с явным каналом): `npm run index:batch -- @handle --limit 500`.
  - Дополнительно: `--stop-on-first-known false` — продолжать пагинацию, даже если встретился уже индексированный `videoId`.
  - Поведение: дедупликация по существующей таблице, очистка описаний, эмбеддинги, вставка батчами с ретраями.
  - Сообщение «Нечего добавлять» означает, что выбранные `videoId` уже есть в таблице.

- `search:test` — локальный поиск по тестовой таблице.
  - Пример: `npm run search:test -- BIM IFC SQLite`.
  - Вывод: `title`, `url`, метрика (`score`/`distance`), top‑5 по умолчанию.

- `lock:status` — статус лок‑файла (по умолчанию `indexing`).
  - Пример: `npm run lock:status` или `npm run lock:status -- indexing`.
  - Вывод: pid, стадия, прогресс, обновления, «stale».

- `lock:force` — принудительная разблокировка `indexing`.
  - Просто: `npm run lock:force` (в пакете уже зашито `indexing --force`).

- `channel:count` — вывести количество видео в плейлисте загрузок канала.
  - Пример: `npm run channel:count -- <channelId|url|@handle>`.

## Команды бота (Telegram)
- `/latest [канал]` — последние 10 видео канала.
  - Примеры: `/latest`, `/latest @handle`, `/latest https://youtube.com/channel/UC...`.
  - Описание очищается и усекается по `DESC_MAX_CHARS`.
- `/search <запрос> | threshold=0.75 | k=10` — семантический поиск по LanceDB.
  - Можно управлять порогом (`threshold`) и количеством результатов (`k`).
- `/threshold <число>` — динамически обновить глобальный порог поиска.

## Примеры
- Предпросмотр очистки по `.env`: `npm run preview:index`.
- Тестовая индексация 10 видео: `npm run index:test -- https://youtube.com/@mychannel`.
- Батч 500 видео без ранней остановки: `npm run index:batch -- @mychannel --limit 500 --stop-on-first-known false`.
- Поиск в тестовой таблице: `npm run search:test -- "BIM IFC SQLite"`.

## Частые проблемы
- Неверная передача аргумента лимита: используйте `--limit 500`, а не `--500`.
- «Нечего добавлять»: собранные `videoId` уже в таблице — это нормально.
- Ошибка ключей: заполните `YOUTUBE_API_KEY` и `MISTRAL_API_KEY` в `.env`.
- Отображение кириллицы в терминале Windows: установите кодировку UTF‑8:
  - PowerShell: `chcp 65001` и `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`.

## Замечания
- Эмбеддинги Mistral платные — индексация больших объёмов требует бюджета.
- В `.gitignore` исключены `data/` и `.env` — храните ключи локально.
- Формат очистки описаний полностью управляется `.env` и единообразен в скриптах и боте.