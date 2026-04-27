# Telegram-бот: учёт счетов (Supabase)

MVP-бот на Node.js: приём фото/файла счёта, выбор категории, комментарий, загрузка в **Supabase Storage** и запись в таблицу **expenses**, уведомление бухгалтера.

## Требования

- Node.js 18+ (нужен встроенный `fetch`)
- Аккаунт Supabase
- Токен Telegram-бота

## Установка

```bash
npm install
```

Скопируйте `.env.example` в `.env` и заполните переменные (см. ниже).

## 1. Создание бота в Telegram

1. Откройте чат с [@BotFather](https://t.me/BotFather).
2. Команда `/newbot` — задайте имя и ник.
3. Скопируйте выданный **HTTP API token** в `TELEGRAM_BOT_TOKEN` в `.env`.

## 2. Как узнать `chat_id`

- **Свой id (для бухгалтера):** напишите боту [@userinfobot](https://t.me/userinfobot) или [@getidsbot](https://t.me/getidsbot) — в ответе будет `Id` (число). Подставьте его в `ACCOUNTANT_CHAT_ID`.
- **Проверка id чата** можно также через [getUpdates](https://core.telegram.org/bots/api#getupdates) API после того, как пользователь написал вашему боту.

`ACCOUNTANT_CHAT_ID` в MVP — **личный чат** с ботом (число, как строка: например `123456789`). Бухгалтеру нужно **хотя бы раз нажать /start** у вашего бота, иначе Telegram не доставит ему исходящие сообщения от бота.

## 3. Настройка Supabase

### Таблица `expenses`

В SQL Editor выполните (подстройте при необходимости):

```sql
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  file_url text not null,
  file_name text not null,
  category text not null,
  category_id text,
  subcategory text,
  subcategory_id text,
  comment text,
  status text not null default 'new',
  user_id bigint,
  created_at timestamptz not null default now()
);
```

Если таблица уже создана без `category_id` / `subcategory` / `subcategory_id`, выполните:

```sql
alter table public.expenses add column if not exists category_id text;
alter table public.expenses add column if not exists subcategory text;
alter table public.expenses add column if not exists subcategory_id text;
```

Поле `user_id` хранит `chat.id` из Telegram. В `category` / `subcategory` сохраняются названия, в `category_id` / `subcategory_id` — идентификаторы из `src/categories.js`. Бот передаёт `created_at` при вставке; если в таблице уже есть `default now()`, значение с клиента и так будет корректным.

### Storage

1. **Storage** → **New bucket** → имя, например `invoices` (как `SUPABASE_BUCKET` в `.env`).
2. Для **публичной ссылки** на файл: в настройках бакета включите **public** (или в MVP храните ссылку из `getPublicUrl` — она рассчитана для публичного бакета).
3. Политика доступа: бот использует **service role** key — RLS на Storage для серверной загрузки обычно настраивается отдельно; для MVP часто делают бакет с загрузкой по service role (см. [документацию Supabase Storage](https://supabase.com/docs/guides/storage)).

## 4. Переменные `.env`

| Переменная | Описание |
|------------|----------|
| `TELEGRAM_BOT_TOKEN` | Токен от BotFather |
| `SUPABASE_URL` | URL проекта (Settings → API) |
| `SUPABASE_SERVICE_ROLE_KEY` | **service_role** (секретно, не в клиенте) |
| `SUPABASE_BUCKET` | Имя бакета, по умолчанию `invoices` |
| `ACCOUNTANT_CHAT_ID` | Chat id бухгалтера для уведомлений и кнопок «Одобрить / Отклонить» |

## 5. Запуск

```bash
npm start
```

В логе должно появиться: «Бот запущен…». Напишите боту `/start` и отправьте PDF или фото счёта.

## Поведение

- `/start` — приглашение отправить файл или фото.
- Документ или фото → выбор категории (инлайн-кнопки) → комментарий или «Пропустить».
- Файл сохраняется в Storage по пути `telegram/{timestamp}-{имя_файла}`.
- В `expenses` создаётся запись со статусом `new`.
- Бухгалтеру уходит уведомление; кнопки **Одобрить** / **Отклонить** обновляют `status` в `approved` / `rejected`.

## Структура

```
src/
  index.js       — бот, сессии, сценарий
  supabase.js    — клиент, загрузка, запись/обновление
  categories.js  — дерево категорий и подкатегорий (все подписи и id правятся здесь)
.env.example
package.json
```

## Безопасность

- Ключ `SUPABASE_SERVICE_ROLE_KEY` нельзя публиковать и вшивать в мобильные/веб-клиенты: только на сервере, где крутится бот.
- В MVP нет списка «разрешённых» пользователей: имейте в виду, что писать боту сможет любой, кто найдёт username бота. Для продакшена ограничьте `chat_id` владельца.
