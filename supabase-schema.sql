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

-- ----------------------------------------------------------------------------
-- ДОПОЛНЕНИЕ (железные комнаты): updated_at обновляется сам при любом PATCH —
-- по нему видно, что хост жив (лобби хоста шлёт heartbeat PATCH каждые 8 с).
-- ----------------------------------------------------------------------------
create or replace function public.rooms_touch() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists rooms_touch_trg on public.rooms;
create trigger rooms_touch_trg before update on public.rooms
  for each row execute function public.rooms_touch();

-- ============================================================================
-- ТЕЛЕМЕТРИЯ ИГРОКОВ (metrics.js → admin.html): где игрок остановился,
-- когда ушёл, вернулся ли. Пишется клиентом игры, читается админ-панелью.
-- УСТАНОВКА: выполнить весь файл целиком (блоки ниже идемпотентны).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- player_sessions: одна строка = один визит игрока. Снапшот-поля обновляются
-- при каждом heartbeat (upsert по PK id) — в итоге там состояние НА МОМЕНТ
-- УХОДА: экран, уровень/мир/название, позиция в уровне %, печати, счёт,
-- монеты, жизни, волна арены, смерти, кооп-комната.
-- ----------------------------------------------------------------------------
create table if not exists public.player_sessions (
  id           uuid primary key,                   -- UUID сессии (генерит игра)
  pid          text not null,                      -- анонимный ID игрока (24 hex)
  n            int  not null default 1,            -- номер сессии игрока (1, 2, 3…)
  is_return    boolean not null default false,     -- это возврат (есть прошлые визиты)?
  since_prev_s bigint,                             -- секунд с прошлого визита
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,                        -- когда ушёл (null = не завершилась)
  duration_s   int,                                -- длина визита, сек
  exit_reason  text,                               -- close | tab_hidden | idle (null = обрыв)
  state        text,                               -- экран: play / title / arena / …
  level_idx    int,                                -- уровень (с нуля) на момент ухода
  level_name   text,                               -- название уровня (из карты)
  world        int,                                -- мир 1..6
  pos_pct      int,                                -- позиция в уровне, %
  score        int not null default 0,
  coins        int not null default 0,
  lives        int,
  seals        text,                               -- «10100» — какие печати собраны
  wave         int,                                -- арена: волна
  deaths       int not null default 0,             -- смертей в текущем уровне
  time_left    int,                                -- осталось времени на уровне, сек
  ua           text,                               -- краткая подпись устройства
  ver          int  not null default 1,            -- версия формата телеметрии
  updated_at   timestamptz not null default now()
);
create index if not exists psess_pid_idx   on public.player_sessions (pid, started_at desc);
create index if not exists psess_start_idx on public.player_sessions (started_at desc);
create index if not exists psess_state_idx on public.player_sessions (state, started_at desc);

-- ----------------------------------------------------------------------------
-- player_events: журнал игровых событий (старт уровня, смерть, победа, печать,
-- покупка, кооп-комната, смена экрана, старт/конец сессии). Пишется пачками.
-- ----------------------------------------------------------------------------
create table if not exists public.player_events (
  id         bigint generated always as identity primary key,
  pid        text not null,
  sid        uuid,                                  -- ссылка на сессию (nullable)
  kind       text not null,                         -- session_start / level_clear / death / …
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pevent_pid_idx  on public.player_events (pid, created_at desc);
create index if not exists pevent_kind_idx on public.player_events (kind, created_at desc);
create index if not exists pevent_sid_idx  on public.player_events (sid);

-- ----------------------------------------------------------------------------
-- updated_at сессии тикает сам при каждом upsert (heartbeat обновляет строку) —
-- по нему админка видит «сейчас в игре» даже без ended_at.
-- ----------------------------------------------------------------------------
create or replace function public.psess_touch() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists psess_touch_trg on public.player_sessions;
create trigger psess_touch_trg before update on public.player_sessions
  for each row execute function public.psess_touch();

-- ----------------------------------------------------------------------------
-- RLS: как у комнат — анонимный вход в проекте выключен, секретов в таблицах
-- нет (случайные ID, уровни и счёт). Кто знает публичный ключ — тот и пишет;
-- админ-панель читает тем же ключом (открытым по дизайну проекта).
-- ----------------------------------------------------------------------------
alter table public.player_sessions enable row level security;
alter table public.player_events   enable row level security;

drop policy if exists "metrics public play" on public.player_sessions;
drop policy if exists "metrics public play" on public.player_events;
create policy "metrics public play" on public.player_sessions
  for all to anon using (true) with check (true);
create policy "metrics public play" on public.player_events
  for all to anon using (true) with check (true);

-- ----------------------------------------------------------------------------
-- ХОЧЕТСЯ СТРОЖЕ (админ только по логину):
-- 1) Authentication → включите провайдера (например, Email);
-- 2) замените обе политики на чтение только для authenticated:
--    create policy "metrics read admin" on public.player_sessions
--      for select to authenticated using (true);
--    create policy "metrics write game" on public.player_sessions
--      for insert to anon with check (true);
--    (и аналогично для player_events; update сессий — только authenticated);
-- 3) админ-панель вызовет supabase.auth.signInWithPassword() перед чтением.
-- ----------------------------------------------------------------------------
