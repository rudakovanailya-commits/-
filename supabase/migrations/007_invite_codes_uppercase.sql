-- Однократно: привести старые коды к верхнему регистру (как в приложении)
update public.invite_codes
set code = upper(trim(code))
where code is distinct from upper(trim(code));
