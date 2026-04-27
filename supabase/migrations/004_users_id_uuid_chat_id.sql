-- Выполнять, если public.users ещё в старой схеме: id = bigint (Telegram) без chat_id
-- Эта миграция: id (uuid, PK), chat_id = Telegram, уникален
-- Для чистой установки по 003_users_invite_codes.sql — этот файл НЕ НУЖЕН

do $body$
declare
  pkey_name text;
  has_bigint_id boolean;
  has_uuid_id boolean;
  has_chat_id boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users'
      and column_name = 'id' and data_type = 'bigint'
  ) into has_bigint_id;
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users'
      and column_name = 'id'
      and (data_type = 'uuid' or udt_name = 'uuid')
  ) into has_uuid_id;
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users'
      and column_name = 'chat_id'
  ) into has_chat_id;

  if has_uuid_id and has_chat_id then
    return;
  end if;

  if not has_bigint_id then
    return;
  end if;

  alter table public.users add column if not exists chat_id bigint;
  update public.users set chat_id = id where chat_id is null;

  select c.conname into pkey_name
  from pg_constraint c
  join pg_class t on c.conrelid = t.oid
  join pg_namespace n on t.relnamespace = n.oid
  where n.nspname = 'public' and t.relname = 'users' and c.contype = 'p'
  limit 1;

  if pkey_name is not null then
    execute format('alter table public.users drop constraint %I', pkey_name);
  end if;

  alter table public.users drop column id;
  alter table public.users add column id uuid not null default gen_random_uuid();
  alter table public.users add primary key (id);
  alter table public.users alter column chat_id set not null;
  create unique index if not exists users_chat_id_ux on public.users (chat_id);
end
$body$;
