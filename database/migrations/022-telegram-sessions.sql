-- =====================================================================
-- PlotFarms PA — 022: Telegram bot sessions + link tokens
-- Links a Telegram chat_id to a survey user so employees can query
-- their visits and get AI-assisted answers via the PA Telegram bot.
-- =====================================================================

-- chat_id <-> user_id link (one per Telegram account)
create table if not exists survey.telegram_sessions (
  chat_id   bigint      primary key,
  user_id   text        not null,
  linked_at timestamptz not null default now(),
  active    boolean     not null default true
);

-- Short-lived OTP tokens issued by the bot to prove Telegram identity
-- during the web-based linking flow (expires in 10 minutes).
create table if not exists survey.telegram_link_tokens (
  token      text        primary key,
  chat_id    bigint      not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  used       boolean     not null default false
);

-- survey_app access
grant select, insert, update on survey.telegram_sessions    to survey_app;
grant select, insert, update on survey.telegram_link_tokens to survey_app;

-- VERIFY
select 'telegram_sessions'    as tbl, count(*) from survey.telegram_sessions union all
select 'telegram_link_tokens' as tbl, count(*) from survey.telegram_link_tokens;
