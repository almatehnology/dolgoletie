# Долголетие (dolgoletie)

Локальный портал учёта физлиц и мероприятий.

- Картотека людей с паспортом и сканами (JPG/PNG/WebP/PDF, скрыты по умолчанию).
- Мероприятия с датами, стоимостью (RUB/USD), программой, размещением и транспортом для выездных, экскурсиями.
- Участники с тремя статусами оплаты (не оплачено / предоплата / оплачено) и суммами.
- Глобальный поиск (`⌘K` / `Ctrl+K`) по ФИО, паспорту и мероприятиям через SQLite FTS5.
- Архив с восстановлением (soft-delete).
- Импорт/экспорт zip (полный, только люди, только мероприятия; merge/replace; dry-run).
- Защита единым паролем.

Технологии: **Next.js 15 (App Router) · React 19 · TypeScript · HeroUI v3 · Tailwind v4 · Redux Toolkit + RTK Query · Prisma 6 · SQLite (FTS5) · iron-session · sharp · archiver/unzipper · Docker**.

## Быстрый старт (Docker)

```bash
cp .env.example .env
# Сгенерировать SESSION_SECRET — любая случайная строка ≥ 32 символов
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env

docker compose build
# укажите пароль в .env: APP_PASSWORD=<ваш-пароль>
docker compose up -d
```

Открыть http://localhost:3000/login и войти паролем.

- БД лежит в `./data/data.db`, сканы — в `./uploads/`.
- Бэкап = скопировать эти две папки (или выгрузить zip через раздел «Данные»).
- Остановить: `docker compose down` (без `-v`, иначе volume НЕ трогаются — они bind-mount).

## Локальный запуск без Docker

```bash
cp .env.example .env
npm install
# отредактируйте .env: APP_PASSWORD=<ваш-пароль>
npx prisma migrate deploy     # применить миграции (включая FTS5)
npm run build
npm start                     # http://localhost:3000
```

Для разработки: `npm run dev`.

> Пароль хранится в `.env` в открытом виде — это локальное приложение без
> доступа в интернет, отдельное хеширование не нужно.

## Основные разделы

| Путь | Назначение |
|---|---|
| `/` | Главная с быстрыми ссылками |
| `/people` | Список людей, фильтр, пагинация |
| `/people/new`, `/people/:id` | Создание и карточка человека с паспортом, сканами, мероприятиями |
| `/events` | Список мероприятий + фильтр по диапазону дат |
| `/events/new`, `/events/:id` | Создание и карточка мероприятия с участниками |
| `/archive` | Архив людей и мероприятий с восстановлением |
| `/data` | Импорт/экспорт |
| `/login` | Вход паролем |

## Структура

```
app/                     # Next.js роуты и API (app/api/**)
components/              # UI-компоненты (HeroUI)
lib/                     # Prisma, session, Redux (store/), search, uploads, export, import, validators
prisma/                  # schema.prisma, миграции (включая FTS5)
data/                    # SQLite (создаётся автоматически, bind-mount в Docker)
uploads/                 # Сканы паспортов (bind-mount в Docker)
docker/                  # entrypoint контейнера
Dockerfile, docker-compose.yml, PLAN.md, README.md
```

Полный план архитектуры и этапы разработки — [PLAN.md](./PLAN.md).

## Скрипты

| Команда | Назначение |
|---|---|
| `npm run dev` | Dev-сервер |
| `npm run build` + `npm start` | Production-сборка и запуск |
| `npm run prisma:migrate` | Создать новую миграцию (dev) |
| `npm run prisma:deploy` | Применить миграции (prod) |
| `npm run prisma:studio` | GUI к SQLite |
| `npm run seed` | Seed (пусто по умолчанию) |

## Формат архива импорта/экспорта

```
backup-<scope>-YYYY-MM-DD.zip
├── manifest.json         # {version, exportedAt, scope, counts}
├── people.json           # массивы Person (со вложенными scans)
├── events.json           # массивы Event (со вложенными excursions)
├── participations.json
└── uploads/<personId>/<scanId>.<ext>
```

**merge** — объединяет по ключам: `passportNumber` (люди), `(title, startDate)` (мероприятия), `(personId, eventId)` (участия).
**replace** — транзакционно очищает таблицы и вставляет данные архива.
**dry-run** — показывает план без записи.

## Замечания

- HeroUI v3 использует compound-API в стиле shadcn (`Card.Header`, `Modal.Container`, `Button variant="primary|secondary|tertiary|ghost|outline|danger|danger-soft"`).
- Превью сканов генерируется `sharp` для изображений; для PDF показывается иконка.
- Поиск использует FTS5 с токенизатором `unicode61 remove_diacritics 2` (кириллица + префиксный поиск).
