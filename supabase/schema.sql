-- Minogoe database schema. Safe to re-run in full any time (idempotent) --
-- Run in the Supabase SQL Editor (Project -> SQL Editor -> New query -> paste -> Run).

-- ---------- Phase 1: accounts/profiles ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  elo_rating integer not null default 1200,
  games_played integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  ties integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Profiles are publicly readable" on public.profiles;
create policy "Profiles are publicly readable"
  on public.profiles for select
  using (true);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Auto-create a profile row whenever a new auth user signs up.
-- Reads the "username" passed in via supabase.auth.signUp(... options: { data: { username } })
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data->>'username');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Phase 2: game recording ----------

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('casual', 'ranked', 'private', 'bot')),
  player1_id uuid references public.profiles(id),
  player2_id uuid references public.profiles(id), -- null for bot games
  score1 integer not null,
  score2 integer not null,
  winner smallint,               -- 1, 2, or null (tie)
  elo_delta_p1 integer,          -- populated later, only for mode = 'ranked'
  elo_delta_p2 integer,
  initial_hand jsonb,            -- populated once replays land (phase 3)
  move_log jsonb,                -- populated once replays land (phase 3)
  board_size integer not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz not null default now()
);

alter table public.games enable row level security;

drop policy if exists "Games are publicly readable" on public.games;
create policy "Games are publicly readable"
  on public.games for select
  using (true);

drop policy if exists "Participants can insert their own games" on public.games;
create policy "Participants can insert their own games"
  on public.games for insert
  with check (auth.uid() = player1_id or auth.uid() = player2_id);

-- Keep each profile's career W/L/T counters in sync whenever a game is recorded.
-- (ELO itself is handled separately once ranked queues exist - this only touches
-- games_played/wins/losses/ties, for every mode.)
create or replace function public.handle_game_recorded()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.player1_id is not null then
    update public.profiles
    set games_played = games_played + 1,
        wins = wins + case when new.winner = 1 then 1 else 0 end,
        losses = losses + case when new.winner = 2 then 1 else 0 end,
        ties = ties + case when new.winner is null then 1 else 0 end
    where id = new.player1_id;
  end if;

  if new.player2_id is not null then
    update public.profiles
    set games_played = games_played + 1,
        wins = wins + case when new.winner = 2 then 1 else 0 end,
        losses = losses + case when new.winner = 1 then 1 else 0 end,
        ties = ties + case when new.winner is null then 1 else 0 end
    where id = new.player2_id;
  end if;

  return new;
end;
$$;

drop trigger if exists on_game_recorded on public.games;
create trigger on_game_recorded
  after insert on public.games
  for each row execute function public.handle_game_recorded();

-- ---------- Phase 5: ranked ELO ----------

-- Standard ELO update (K=32), applied only to mode = 'ranked' games between
-- two real accounts. Runs as a separate trigger from the W/L/T counter one
-- above so ELO logic stays isolated and easy to reason about on its own.
create or replace function public.handle_ranked_game()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  p1_elo integer;
  p2_elo integer;
  expected_p1 numeric;
  actual_p1 numeric;
  k constant integer := 32;
  delta_p1 integer;
  delta_p2 integer;
begin
  if new.mode <> 'ranked' or new.player1_id is null or new.player2_id is null then
    return new;
  end if;

  select elo_rating into p1_elo from public.profiles where id = new.player1_id;
  select elo_rating into p2_elo from public.profiles where id = new.player2_id;

  expected_p1 := 1.0 / (1.0 + power(10, (p2_elo - p1_elo) / 400.0));
  actual_p1 := case when new.winner = 1 then 1 when new.winner = 2 then 0 else 0.5 end;

  delta_p1 := round(k * (actual_p1 - expected_p1));
  delta_p2 := -delta_p1;

  update public.profiles set elo_rating = elo_rating + delta_p1 where id = new.player1_id;
  update public.profiles set elo_rating = elo_rating + delta_p2 where id = new.player2_id;
  update public.games set elo_delta_p1 = delta_p1, elo_delta_p2 = delta_p2 where id = new.id;

  return new;
end;
$$;

drop trigger if exists on_ranked_game_recorded on public.games;
create trigger on_ranked_game_recorded
  after insert on public.games
  for each row execute function public.handle_ranked_game();
