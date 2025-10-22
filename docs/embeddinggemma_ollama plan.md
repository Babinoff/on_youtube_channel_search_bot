# EmbeddingGemma (Ollama) — план интеграции

Цель: добавить локальный провайдер эмбеддингов EmbeddingGemma (через Ollama) без ломки текущей архитектуры, с отдельными таблицами на провайдера, используя общие параметры для тюнинга эмбеддингов и рекомендации из документации Gemma.

## Принципы архитектуры
- Не изменяем общие настройки: используем существующие переменные окружения для эмбеддингов (`EMBEDDINGS_MAX_CONCURRENCY`, `EMBEDDINGS_CACHE_SIZE`, `EMBEDDINGS_BATCH_SIZE`, `EMBEDDINGS_MAX_ATTEMPTS`, `EMBEDDINGS_TIMEOUT_MS`, `EMBEDDINGS_MAX_CHUNK_LEN`, `EMBEDDINGS_CHUNK_OVERLAP`).
- Каждый провайдер пишет в свою таблицу: `video_embeddings_<provider>_<channelId>` (LanceDB). Для Ollama будет `video_embeddings_ollama_<channelId>` — миграции не требуются.
- Провайдеры могут иметь разные размерности (dims); поиск и индексация всегда смотрят на таблицу провайдера из `env.EMBEDDINGS_PROVIDER`.
- Цепочка провайдеров поддерживается существующим механизмом `EMBEDDINGS_PROVIDER_CHAIN`; в дальнейшем каждый провайдер работает с «своими» базами.
- Метрика/порог: используем `cosine_distance`, верхняя граница для адаптивного порога — провайдер-специфична (по умолчанию 2).

## Рекомендации из документации Gemma
- Характеристики модели: размерность выхода 768 (с поддержкой MRL-обрезки до 512/256/128), максимальная длина контекста 2K токенов, мультиязычность, низкая задержка и возможность офлайн-запуска на пользовательских устройствах [Model Card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card).
- MRL (Matryoshka): если потребуется уменьшить размерность, используем клиентское усечение вектора (первые N компонент из 768) и затем повторную L2-нормализацию. Важно держать размерность фиксированной для каждой базы провайдера (индекс/query одинаковые) [Model Card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card).
- Нормализация: применяем L2-нормализацию к итоговым эмбеддингам; метрика поиска — `cosine_distance` (диапазон [0, 2] при `1 - cosine_similarity`) для стабильной адаптации порога.
- Chunking: длинные тексты разбиваем по существующим общим параметрам; итоговый эмбеддинг текста — среднее по сегментам с последующей нормализацией. Контекстная длина 2048 токенов — ориентир для выбора размера чанка [ST Inference](https://ai.google.dev/gemma/docs/embeddinggemma/inference-embeddinggemma-with-sentence-transformers).
- Промпты/задачи (без HF): вместо параметра `prompt=task_name` из Sentence-Transformers используем строковые префиксы, например `"query:"` для запросов и `"passage:"` для документов. Это имитирует включение промпта (в ST конфиге `include_prompt: true`) и улучшает соответствие задачам IR/STS/QA [ST Inference](https://ai.google.dev/gemma/docs/embeddinggemma/inference-embeddinggemma-with-sentence-transformers), [Fine-tuning](https://ai.google.dev/gemma/docs/embeddinggemma/fine-tuning-embeddinggemma-with-sentence-transformers).
- Квантование: Ollama может использовать квантованные веса (например GGUF). Ожидаем небольшое падение качества по сравнению с FP — контролируем через `emb_status` и интеграционные тесты; избегаем экстремально низких квантов, если качество критично [Model Card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card).
- Ограничения Ollama vs HF: не используем HF Hub/токены и `SentenceTransformer`; опираемся на локальный API `POST /api/embeddings`. Все тюнинги (префиксы, нормализация, усреднение чанков, MRL-усечение) выполняются на стороне клиента и не требуют изменения схемы базы.

Источники: Model Card, Inference и Fine-tuning страницы EmbeddingGemma.

## Подготовка окружения
- Установить Ollama (Windows инсталлятор с сайта).
- Загрузить модель: `ollama pull embeddinggemma`.
- Проверка API: `curl http://localhost:11434/api/embeddings -d '{"model":"embeddinggemma","prompt":"Привет мир"}'` → в ответе массив `embedding`.

Примечание: не добавляем новых обязательных параметров окружения. Провайдер будет работать с разумными дефолтами: URL — `http://localhost:11434`, модель — `embeddinggemma`. При необходимости их можно переопределить позже, но это не обязательно на старте.

## Изменения в кодовой базе

### 1) Регистрация провайдера
- `src/services/embeddings/index.js`:
  - Добавить кейс: `case "ollama": return tryRequire("./ollama");`
  - Расширить `providerMeta`: `ollama: { metric: 'cosine_distance', distanceMax: 2 }`.

- `src/config/env.js`:
  - В список известных провайдеров добавить `"ollama"` для валидации.
  - (Опционально) варнинг, если `EMBEDDINGS_PROVIDER=ollama` и локальный сервер недоступен (проверка не обязательна, можно оставить диагностику на уровне провайдера).

### 2) Новый провайдер `src/services/embeddings/ollama.js`
Интерфейс: `async function embedTexts(texts)` → возвращает массив векторов по числу входных текстов.

Реализация:
- Подготовка:
  - `items = Array.isArray(texts) ? texts : [texts]`.
  - Параметры: брать из общих (`EMBEDDINGS_MAX_CHUNK_LEN`, `EMBEDDINGS_CHUNK_OVERLAP`, `EMBEDDINGS_BATCH_SIZE`, `EMBEDDINGS_MAX_CONCURRENCY`, `EMBEDDINGS_TIMEOUT_MS`, `EMBEDDINGS_MAX_ATTEMPTS`).
  - Дефолты провайдера: `baseUrl = 'http://localhost:11434'`, `model = 'embeddinggemma'`.
- Чанкинг:
  - Разбить каждый текст на сегменты, длина ≤ `EMBEDDINGS_MAX_CHUNK_LEN`, с перекрытием `EMBEDDINGS_CHUNK_OVERLAP` (как в `mistral.js`).
- Запросы к Ollama:
  - Для каждого сегмента: HTTP POST `baseUrl + '/api/embeddings'`, body: `{ model, prompt: segment }`.
  - Таймаут — `EMBEDDINGS_TIMEOUT_MS`.
  - Ретраи — до `EMBEDDINGS_MAX_ATTEMPTS` с экспоненциальной задержкой; ошибки сетевые/429/503 считаем ретраибл.
  - Последовательность/ограничение параллелизма — по `EMBEDDINGS_MAX_CONCURRENCY`.
- Агрегация:
  - Вектор сегмента → массив чисел `embedding`.
  - Итог для текста: усреднить все сегментные вектора (mean) и выполнить L2-нормализацию.
- Выход:
  - Массив векторов той же длины, что `items`.
  - Логировать `dims` первого вектора; при пустом результате вернуть `[]` (позволит цепочке провайдеров переключиться).

### 3) Диагностика
- `src/scripts/emb_status.js`:
  - В `providerModel(name)` добавить кейс `ollama`: возвращать `'embeddinggemma'`.
  - Скрипт уже умеет тестировать провайдеры, достаточно чтобы модуль существовал.

## Потоки индексации и поиска
- Индексация (`index:test`, `index:batch`):
  - При `EMBEDDINGS_PROVIDER=ollama` создаётся таблица `video_embeddings_ollama_<channelId>`.
  - Разные провайдеры создают разные таблицы — миграции не нужны.
- Поиск:
  - Всегда вычисляет эмбеддинг запроса текущим провайдером.
  - Открывает таблицу канала по текущему провайдеру (уже реализовано через `getChannelTableName`).
  - Адаптивный порог (`SEARCH_MAX_DISTANCE`, `SEARCH_ADAPTIVE_*`) продолжает работать как есть.

## Порядок выполнения
1. Установить Ollama и `pull embeddinggemma`; убедиться что API доступен локально.
2. Добавить провайдера `ollama` в `embeddings/index.js` и `providerMeta`.
3. Добавить `ollama` в список известных провайдеров в `env.js`.
4. Реализовать `src/services/embeddings/ollama.js` по описанию выше.
5. Обновить `emb_status.js` для отображения модели провайдера.
6. Заполнить `.env` только общими параметрами эмбеддингов; установить `EMBEDDINGS_PROVIDER=ollama`.
7. Запустить индексацию (`npm run index:test` или `npm run index:batch`) — создаст провайдер-специфичные таблицы.
8. Проверить `/emb_status` и `npm run search:test` — убедиться в валидной размерности и релевантности.

## Критерии готовности
- `emb_status` показывает валидную размерность (dims > 0), норму (не NaN), время ответа.
- В LanceDB появились таблицы `video_embeddings_ollama_<channelId>` с новыми векторами.
- Поиск выдаёт корректные результаты, адаптивный порог логируется, ошибки отсутствуют.
- CI-тесты проходят без регрессий.

## Риски и заметки
- Разная размерность между провайдерами — это ожидаемо; базы изолированы по имени таблицы.
- Долгие описания — регулируются общими параметрами (чанкинг). Для Gemma ориентироваться на 2K токенов контекста.
- MRL/уменьшение размерности возможно позже, без изменения архитектуры; важно применять одинаково для индекса и запросов.
- Внешние сбои Ollama (не запущен, порт недоступен) — корректно логируются, цепочка провайдеров может перейти на запасной.

## Ссылки
- Обзор EmbeddingGemma: https://ai.google.dev/gemma/docs/embeddinggemma?hl=ru
- Модель в Ollama: https://ollama.com/library/embeddinggemma