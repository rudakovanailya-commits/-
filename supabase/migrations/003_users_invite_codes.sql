-- Выполните в Supabase: SQL Editor
-- Таблицы доступа: пользователи и одноразовые коды
-- users.id = внутренний uuid, users.chat_id = Telegram (уникален)

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null unique,
  name text,
  role text default 'user',
  is_active boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.invite_codes (
  code text primary key,
  role text default 'user',
  created_by bigint,
  used_by bigint,
  is_active boolean default true,
  created_at timestamptz default now()
);

-- Админа/бухгалтера (один раз), подставьте свой chat_id из Telegram:
-- insert into public.users (chat_id, name, role, is_active)
-- values (123456789, 'Имя', 'admin', true)
-- on conflict (chat_id) do update
--   set name = excluded.name, role = excluded.role, is_active = true;
