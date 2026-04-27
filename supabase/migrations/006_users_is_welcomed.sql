-- Флаг: авто-приветствие при первом открытии чата уже показан
alter table public.users add column if not exists is_welcomed boolean not null default false;
