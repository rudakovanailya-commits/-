-- Выполните в Supabase: SQL Editor → New query → Run
-- Нужно, если вставка падает с PGRST204 (column not in schema)

alter table public.expenses add column if not exists category_id text;
alter table public.expenses add column if not exists subcategory text;
alter table public.expenses add column if not exists subcategory_id text;
alter table public.expenses add column if not exists user_id bigint;
alter table public.expenses add column if not exists created_at timestamptz default now();

-- Проверьте, что есть базовые поля; при необходимости:
-- alter table public.expenses add column if not exists file_url text;
-- alter table public.expenses add column if not exists file_name text;
-- alter table public.expenses add column if not exists category text;
-- alter table public.expenses add column if not exists comment text;
-- alter table public.expenses add column if not exists status text default 'new';
