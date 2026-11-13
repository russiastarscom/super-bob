-- ============================================================================
--  SUPER BOB: сетевые комнаты и итоги забегов (Supabase Postgres)
--  ЗАПУСК: Supabase Dashboard → SQL Editor → New query → вставить весь файл
--  целиком → Run. Игра подхватит таблицы сама (запросов ничего не ломает:
--  пока таблиц нет, кооп работает через Realtime + WebRTC без сохранений).
-- ============================================================================

create table if not exists public.rooms (
  code       text primary key,                 -- 4-символьный код комнаты («пропуск»)
  status     text not null default 'lobby',    -- lobby | playing | over
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.games (
  id       bigint generated always as identity primary key,
  code     text not null,
  wave     int  not null default 0,             -- волна, до которой дошла пара
  score    int  not null default 0,             -- общий счёт забега
  ended_at timestamptz not null default now()
);
create index if not exists games_code_idx on public.games (code, ended_at desc);

-- Журнал значимых игровых событий (резерв под будущие режимы — аркада не
-- поштучно логирует монеты: 60 Гц в базу не пишется никогда).
create table if not exists public.game_moves (
  id         bigint generated always as identity primary key,
  code       text not null,
  kind       text not null,                     -- 'wave' | 'coin' | 'stomp' | ...
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists moves_code_idx on public.game_moves (code, created_at desc);

-- ----------------------------------------------------------------------------
-- RLS: включена на всех таблицах. Анонимный вход в проекте выключен, поэтому
-- пропуском в комнату служит сам код: кто знает код — тот участник. Секретов
-- в таблицах нет (только коды, волны и счёт).
-- ----------------------------------------------------------------------------
alter table public.rooms      enable row level security;
alter table public.games      enable row level security;
alter table public.game_moves enable row level security;

drop policy if exists "rooms public play" on public.rooms;
drop policy if exists "games public play" on public.games;
drop policy if exists "moves public play" on public.game_moves;
create policy "rooms public play" on public.rooms
  for all to anon using (true) with check (true);
create policy "games public play" on public.games
  for all to anon using (true) with check (true);
create policy "moves public play" on public.game_moves
  for all to anon using (true) with check (true);

-- ----------------------------------------------------------------------------
-- ХОЧЕТСЯ СТРОЖЕ (личные идентификаторы игроков):
-- 1) Authentication → Providers → включите Anonymous sign-ins;
-- 2) игра будет входить анонимно и получать user_id (код игры это уже
--    умеет проверять — включается само, когда вход начинает работать);
-- 3) замените политики выше на проверку участника, например:
--
-- create table if not exists public.room_players (
--   id       bigint generated always as identity primary key,
--   code     text not null references public.rooms(code) on delete cascade,
--   user_id  uuid not null,
--   role     text not null,                       -- host | guest
--   joined_at timestamptz not null default now(),
--   unique (code, user_id)
-- );
-- create policy "rooms by member" on public.rooms for all to authenticated
--   using (exists (select 1 from public.room_players p
--                  where p.code = rooms.code and p.user_id = auth.uid()))
--   with check (true);
--
-- 4) приватный канал: в игре смените config канала на private:true и
--    добавьте политики на realtime.messages (SELECT/INSERT по участнику).
-- ----------------------------------------------------------------------------

-- Примечание: Broadcast и Presence таблиц НЕ требуют — канал 'bob5a-КОД'
-- создаётся на лету, игровые данные после рукопожатия идут по прямому
-- WebRTC мимо сервера. Скрипт достаточно выполнить один раз.
