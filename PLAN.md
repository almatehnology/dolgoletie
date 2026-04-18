# TravelDataBase — план MVP

Информационный портал с локальной базой для учёта физлиц и мероприятий.

## 0. Принятые решения

| № | Пункт | Решение |
|---|---|---|
| 1 | Авторизация | Один общий пароль → `iron-session` cookie, middleware защищает всё кроме `/login` |
| 2 | Язык UI | Только русский |
| 3 | Паспорт | **Один на человека**, поля инлайн в `Person` |
| 4 | Сканы | Несколько файлов на паспорт; JPG/PNG/WebP/PDF; ≤ 10 MB/файл |
| 5 | Поиск | Частичное совпадение в любом месте + SQLite FTS5 |
| 6 | Валюта | RUB / USD, одна на мероприятие (`Event.currency`) |
| 7 | Удаление | Soft-delete (`deletedAt`), UI-раздел «Архив» |
| 8 | История изменений | В MVP не реализуется |

## 1. Стек

- Node.js 22 LTS, TypeScript 5
- **Next.js 15** (App Router, Server Components)
- React 19
- **HeroUI v3** + TailwindCSS v4
- **Redux Toolkit** + **RTK Query** (глобальное состояние и серверный кеш)
- Prisma 6 + SQLite (WAL)
- `zod` — валидация (общая для API и форм)
- `react-hook-form` + `@hookform/resolvers/zod`
- `iron-session` — сессия по cookie
- `sharp` + `pdfjs-dist` — превью сканов
- `archiver` / `unzipper` — импорт/экспорт zip
- `pino` — логи
- Docker + docker-compose

## 2. Структура проекта

```
TravelDataBase/
├─ app/
│  ├─ (auth)/login/page.tsx
│  ├─ (app)/
│  │  ├─ layout.tsx
│  │  ├─ page.tsx                    # главная: поиск, ближайшие мероприятия
│  │  ├─ people/
│  │  │  ├─ page.tsx                 # список + фильтры
│  │  │  ├─ new/page.tsx
│  │  │  └─ [id]/page.tsx            # карточка
│  │  ├─ events/
│  │  │  ├─ page.tsx
│  │  │  ├─ new/page.tsx
│  │  │  └─ [id]/page.tsx
│  │  ├─ archive/page.tsx
│  │  └─ data/page.tsx               # импорт/экспорт
│  └─ api/
│     ├─ auth/{login,logout}/route.ts
│     ├─ people/route.ts
│     ├─ people/[id]/route.ts
│     ├─ people/[id]/scans/route.ts
│     ├─ scans/[id]/route.ts
│     ├─ scans/[id]/thumb/route.ts
│     ├─ events/route.ts
│     ├─ events/[id]/route.ts
│     ├─ events/[id]/participants/route.ts
│     ├─ participations/[id]/route.ts
│     ├─ search/route.ts
│     ├─ export/route.ts
│     └─ import/route.ts
├─ components/
├─ lib/
│  ├─ db.ts                           # Prisma singleton
│  ├─ session.ts                      # iron-session
│  ├─ uploads.ts                      # валидация, sharp-превью
│  ├─ search.ts                       # FTS5
│  ├─ export.ts / import.ts
│  ├─ validators.ts                   # zod
│  └─ store/                          # Redux
│     ├─ index.ts
│     ├─ provider.tsx
│     ├─ ui-slice.ts
│     └─ api.ts                       # RTK Query
├─ prisma/
│  ├─ schema.prisma
│  └─ migrations/
├─ data/                              # volume: SQLite
├─ uploads/                           # volume: сканы
├─ Dockerfile
├─ docker-compose.yml
├─ next.config.ts
├─ tailwind.config.ts
├─ tsconfig.json
├─ .env.example
└─ README.md
```

## 3. Модель данных (Prisma)

```prisma
enum PaymentStatus { UNPAID PREPAID PAID }
enum Currency      { RUB USD }
enum TransportType { BUS TRAIN PLANE OTHER }

model Person {
  id                String   @id @default(cuid())
  lastName          String
  firstName         String
  middleName        String?
  phone             String?
  passportNumber    String?
  passportIssuedBy  String?
  passportIssuedAt  DateTime?
  passportExpiresAt DateTime?
  passportDetails   String?
  notes             String?
  scans             PassportScan[]
  participations    Participation[]
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  deletedAt         DateTime?
  @@index([lastName, firstName])
  @@index([passportNumber])
}

model PassportScan {
  id         String   @id @default(cuid())
  personId   String
  person     Person   @relation(fields: [personId], references: [id], onDelete: Cascade)
  filename   String
  storedPath String
  thumbPath  String?
  mimeType   String
  sizeBytes  Int
  uploadedAt DateTime @default(now())
}

model Event {
  id                 String   @id @default(cuid())
  title              String
  startDate          DateTime
  endDate            DateTime
  location           String
  cost               Decimal?
  currency           Currency @default(RUB)
  program            String?
  isOutbound         Boolean  @default(false)
  accommodationPlace String?
  accommodationOrder String?
  mealType           String?
  staysFrom          DateTime?
  staysTo            DateTime?
  accommodationCost  Decimal?
  transportType      TransportType?
  transportInfo      String?
  transportCost      Decimal?
  excursions         Excursion[]
  participations     Participation[]
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
  deletedAt          DateTime?
  @@index([startDate, endDate])
  @@index([title])
}

model Excursion {
  id       String  @id @default(cuid())
  eventId  String
  event    Event   @relation(fields: [eventId], references: [id], onDelete: Cascade)
  name     String
  cost     Decimal?
}

model Participation {
  id             String        @id @default(cuid())
  personId       String
  eventId        String
  person         Person @relation(fields: [personId], references: [id], onDelete: Cascade)
  event          Event  @relation(fields: [eventId], references: [id], onDelete: Cascade)
  paymentStatus  PaymentStatus @default(UNPAID)
  prepaidAmount  Decimal?
  totalDue       Decimal?
  notes          String?
  createdAt      DateTime @default(now())
  @@unique([personId, eventId])
}
```

FTS5 создаётся raw-SQL миграцией, синхронизация через Prisma middleware:

```sql
CREATE VIRTUAL TABLE person_fts USING fts5(
  personId UNINDEXED, fullName, phone, passportNumber,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE event_fts USING fts5(
  eventId UNINDEXED, title, location, program,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

## 4. API

Все эндпоинты JSON, защищены middleware; ошибки — `{error:{code,message,fields?}}`.

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/api/auth/login` | `{password}` → cookie |
| POST | `/api/auth/logout` | очистка cookie |
| GET | `/api/people` | `q, page, pageSize, archived` |
| POST | `/api/people` | создать |
| GET/PATCH/DELETE | `/api/people/:id` | |
| POST | `/api/people/:id/restore` | |
| POST | `/api/people/:id/scans` | multipart, 1+ файлов |
| GET | `/api/scans/:id` | отдаёт файл |
| GET | `/api/scans/:id/thumb` | превью |
| DELETE | `/api/scans/:id` | |
| GET | `/api/events` | `q, from, to, archived` |
| POST/GET/PATCH/DELETE | `/api/events[...]` | |
| POST | `/api/events/:id/participants` | |
| PATCH/DELETE | `/api/participations/:id` | |
| GET | `/api/search` | `q, scope` |
| GET | `/api/export` | `scope, ids` → zip |
| POST | `/api/import` | zip, `mode, dryRun` |

## 5. UI-экраны

1. **Логин** — одно поле пароля + кнопка входа, rate limit.
2. **Главная** — `Input` с автокомплитом, блок «Ближайшие мероприятия», `DateRangePicker` «Найти по диапазону».
3. **Список людей** — HeroUI `Table`, поиск, пагинация, фильтр «архив».
4. **Карточка человека** — блоки: ФИО/контакты → Паспорт (инлайн-поля) → Документы (скрыты по умолчанию, кнопка «Показать сканы» раскрывает грид превью; клик → модалка полноэкранного просмотра) → Мероприятия (таблица с оплатой, переход в мероприятие).
5. **Список мероприятий** — таблица, `DateRangePicker`, поиск.
6. **Карточка мероприятия** — общие поля → `Switch isOutbound` (раскрывает размещение/питание/транспорт) → экскурсии (динамический список) → участники (клик → карточка человека, inline оплата).
7. **Архив** — два таба (люди, мероприятия), восстановление.
8. **Импорт/экспорт** — radio scope + download; импорт zip с dry-run и выбором merge/replace.

Global `SearchModal` на `Cmd/Ctrl+K` (подписан на `ui-slice`).

## 6. Redux

- **Slices**: `uiSlice` (searchModalOpen, activeFilters, toasts), `authSlice` (status).
- **RTK Query api** с тегами: `People`, `Person`, `Events`, `Event`, `Scans`, `Participations`, `Search`. Invalidate по действиям.
- Провайдер подключён в `app/(app)/layout.tsx`.

## 7. Импорт/экспорт

Zip-формат:
```
manifest.json     # {version, exportedAt, scope, counts}
people.json       # массив Person со вложенным массивом scans (metadata)
events.json       # массив Event со excursions
participations.json
uploads/<personId>/<scanId>.<ext>
```
- **merge** — ключ Person: `passportNumber` (если есть) иначе ФИО+DOB недоступен, fallback `id`; ключ Event: `(title, startDate)`; Participation: `(personId, eventId)`.
- **replace** — в транзакции очищает и вставляет.
- `sha256` в манифесте для проверки целостности.

## 8. Безопасность

- `APP_PASSWORD_HASH` (bcrypt) в `.env`, установка через `npm run set-password`.
- Rate-limit на `/api/auth/login` (5/10 мин, LRU in-memory).
- Валидация multipart: mime-whitelist, magic-bytes (`file-type`), лимит по размеру.
- httpOnly + `sameSite=lax` cookie, `SESSION_SECRET` из env.
- zod-валидация на входе всех API.

## 9. Docker

- Dockerfile: multi-stage `deps → build → runtime` (node:22-alpine, `output: 'standalone'`).
- `docker-compose.yml`: сервис `app`, volumes `./data:/app/data`, `./uploads:/app/uploads`, порт 3000.
- Entrypoint: `prisma migrate deploy && node server.js`.
- `.env.example` с `APP_PASSWORD_HASH`, `SESSION_SECRET`, `DATABASE_URL`, `UPLOADS_DIR`, `MAX_UPLOAD_MB`.

Локально: `cp .env.example .env && npm run set-password && docker compose up -d --build`.
Без Docker: `npm i && npx prisma migrate deploy && npm run build && npm start`.

## 10. Roadmap

| № | Этап | Состав | Оценка |
|---|---|---|---|
| 0 | Скелет | Next.js + HeroUI + Tailwind + Prisma + Redux + Docker + middleware пароля | 0.5д |
| 1 | Модель | Prisma schema, миграции, FTS5, seed | 0.5д |
| 2 | Люди CRUD | Список, форма, soft-delete, архив | 1д |
| 3 | Паспорт + сканы | Загрузка, превью, скрытие по умолчанию, модалка | 0.75д |
| 4 | Мероприятия CRUD | Все поля, условные выездные, экскурсии | 1д |
| 5 | Participations | Участники, статусы оплаты | 0.5д |
| 6 | Навигация | Переходы, хлебные крошки | 0.25д |
| 7 | Поиск | `Cmd+K`, FTS5, диапазон дат | 1д |
| 8 | Импорт/экспорт | zip, merge/replace, dry-run | 1д |
| 9 | Полировка | Валидация, тосты, пустые состояния, README | 0.5д |
| 10 | Приёмка | Ручной прогон, правка багов | 0.5д |

Итого ~7 дней.

## 11. Риски

- FTS5 + кириллица → `unicode61 remove_diacritics 2`, тест на реальных ФИО.
- PDF-превью → `pdfjs-dist` для первой страницы, fallback — иконка PDF.
- Decimal в SQLite → строковое представление, форматирование `Intl.NumberFormat`.
- Next standalone + SQLite volume → миграции в entrypoint до старта сервера.
- Zip-экспорт — стриминг, без буферизации в память.
