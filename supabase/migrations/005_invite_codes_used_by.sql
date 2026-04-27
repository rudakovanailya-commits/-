-- Кто использовал одноразовый код (Telegram chat_id)
alter table public.invite_codes add column if not exists used_by bigint;
