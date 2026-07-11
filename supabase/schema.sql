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

-- ---------- Phase 7: presence ("players online" count) ----------

alter table public.profiles add column if not exists last_seen timestamptz not null default now();

-- No new RLS policy needed: "Users can update their own profile" already
-- covers updating last_seen, and "Profiles are publicly readable" already
-- covers counting how many rows are recently active.

-- ---------- Phase 8: allow deleting accounts ----------

-- games.player1_id/player2_id originally had no ON DELETE rule, which
-- defaults to blocking the delete entirely - so removing a user (which
-- cascades to delete their profile) would fail with "Database error
-- deleting user" the moment they'd played any recorded game. Switch to
-- SET NULL so match history survives (the deleted account just shows up
-- the same way a guest opponent already does).
alter table public.games drop constraint if exists games_player1_id_fkey;
alter table public.games add constraint games_player1_id_fkey
  foreign key (player1_id) references public.profiles(id) on delete set null;

alter table public.games drop constraint if exists games_player2_id_fkey;
alter table public.games add constraint games_player2_id_fkey
  foreign key (player2_id) references public.profiles(id) on delete set null;

-- ---------- Phase 9: singleplayer speedrun leaderboard ----------

-- One row per user - only their personal-best time is kept (the client
-- checks the existing time before inserting/updating; see saveScoreIfBest()
-- in singleplayer.js). Unlike games, there's no second player's row to keep
-- in sync, so on delete cascade is fine here.
create table if not exists public.singleplayer_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  time_ms integer not null,
  completed_at timestamptz not null default now()
);

alter table public.singleplayer_runs enable row level security;

drop policy if exists "Singleplayer runs are publicly readable" on public.singleplayer_runs;
create policy "Singleplayer runs are publicly readable"
  on public.singleplayer_runs for select
  using (true);

drop policy if exists "Users can insert their own singleplayer run" on public.singleplayer_runs;
create policy "Users can insert their own singleplayer run"
  on public.singleplayer_runs for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own singleplayer run" on public.singleplayer_runs;
create policy "Users can update their own singleplayer run"
  on public.singleplayer_runs for update
  using (auth.uid() = user_id);

-- ---------- Phase 10: ranked-only W/L/T counters (leaderboard "ranked matches only" filter) ----------

-- games_played/wins/losses/ties on profiles mix every mode together, so the
-- leaderboard's ranked-only view needs its own set of counters that only
-- ever move for mode = 'ranked' games.
alter table public.profiles add column if not exists ranked_games_played integer not null default 0;
alter table public.profiles add column if not exists ranked_wins integer not null default 0;
alter table public.profiles add column if not exists ranked_losses integer not null default 0;
alter table public.profiles add column if not exists ranked_ties integer not null default 0;

-- Extends the existing ranked-ELO trigger (already fires only for
-- mode = 'ranked') to also maintain these counters, instead of adding a
-- separate trigger that would duplicate the same "is this a ranked game
-- between two real accounts" guard.
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

  update public.profiles
  set elo_rating = elo_rating + delta_p1,
      ranked_games_played = ranked_games_played + 1,
      ranked_wins = ranked_wins + case when new.winner = 1 then 1 else 0 end,
      ranked_losses = ranked_losses + case when new.winner = 2 then 1 else 0 end,
      ranked_ties = ranked_ties + case when new.winner is null then 1 else 0 end
  where id = new.player1_id;

  update public.profiles
  set elo_rating = elo_rating + delta_p2,
      ranked_games_played = ranked_games_played + 1,
      ranked_wins = ranked_wins + case when new.winner = 2 then 1 else 0 end,
      ranked_losses = ranked_losses + case when new.winner = 1 then 1 else 0 end,
      ranked_ties = ranked_ties + case when new.winner is null then 1 else 0 end
  where id = new.player2_id;

  update public.games set elo_delta_p1 = delta_p1, elo_delta_p2 = delta_p2 where id = new.id;

  return new;
end;
$$;

-- Backfill from existing games so anyone with ranked history before this
-- migration doesn't show zeros - safe to re-run, it always recomputes from
-- source rather than incrementing.
update public.profiles p
set ranked_games_played = coalesce(rs.games_played, 0),
    ranked_wins = coalesce(rs.wins, 0),
    ranked_losses = coalesce(rs.losses, 0),
    ranked_ties = coalesce(rs.ties, 0)
from (
  select player_id,
         count(*) as games_played,
         sum(case when winner = player_num then 1 else 0 end) as wins,
         sum(case when winner is not null and winner <> player_num then 1 else 0 end) as losses,
         sum(case when winner is null then 1 else 0 end) as ties
  from (
    select player1_id as player_id, 1 as player_num, winner from public.games where mode = 'ranked' and player1_id is not null
    union all
    select player2_id as player_id, 2 as player_num, winner from public.games where mode = 'ranked' and player2_id is not null
  ) per_player
  group by player_id
) rs
where p.id = rs.player_id;

-- ---------- Phase 11: distinguish forfeit/timeout wins from territory wins ----------

-- score1/score2 on a forfeited game are just whatever the board happened to
-- look like at the moment someone ran out of time or quit - not what
-- actually decided the outcome. Replays/profile/recent-games history use
-- this flag to show "W - FF" instead of that (potentially misleading, e.g.
-- the "loser" having more board territory than the forfeit winner) tally.
alter table public.games add column if not exists forfeit boolean not null default false;

-- ---------- Phase 12: coins, daily check-in, shop (profile pictures/titles) ----------

alter table public.profiles add column if not exists coins integer not null default 0;
alter table public.profiles add column if not exists last_checkin_at timestamptz;
alter table public.profiles add column if not exists avatar_id text;
alter table public.profiles add column if not exists title_id text;

-- id is a human-chosen slug (e.g. 'avatar_star'), not a generated uuid, so it
-- can double as a stable, readable key in shop_items_seed.sql and in
-- image_path ('assets/avatars/<file>') without an extra lookup.
create table if not exists public.shop_items (
  id text primary key,
  type text not null check (type in ('avatar', 'title')),
  name text not null,
  price integer not null check (price >= 0),
  image_path text,  -- avatars only
  title_text text   -- titles only
);

alter table public.shop_items enable row level security;

drop policy if exists "Shop items are publicly readable" on public.shop_items;
create policy "Shop items are publicly readable"
  on public.shop_items for select
  using (true);

-- No insert/update/delete policy for shop_items - the catalog is only ever
-- edited by hand via shop_items_seed.sql in the Supabase SQL editor, never
-- by a client.

alter table public.profiles drop constraint if exists profiles_avatar_id_fkey;
alter table public.profiles add constraint profiles_avatar_id_fkey
  foreign key (avatar_id) references public.shop_items(id) on delete set null;

alter table public.profiles drop constraint if exists profiles_title_id_fkey;
alter table public.profiles add constraint profiles_title_id_fkey
  foreign key (title_id) references public.shop_items(id) on delete set null;

-- One row per (user, item) ever purchased - what the shop checks against to
-- show "Buy" vs "Equip" and what equip_avatar()/equip_title() below check
-- ownership against.
create table if not exists public.user_inventory (
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_id text not null references public.shop_items(id) on delete cascade,
  purchased_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

alter table public.user_inventory enable row level security;

drop policy if exists "Inventory is publicly readable" on public.user_inventory;
create policy "Inventory is publicly readable"
  on public.user_inventory for select
  using (true);

-- No insert/update/delete policy - rows are only ever created by
-- purchase_item() below (a security definer function, which runs as the
-- table owner and so isn't subject to this restriction).

-- Coins/avatar_id/title_id must never be settable by a raw client update() -
-- only through the security definer functions below. Supabase grants
-- authenticated broad column privileges on public-schema tables by default
-- (separate from, and in addition to, RLS's row-level "using"/"with check"
-- clauses, which only ever restricted *which rows*, never *which columns*).
-- Without this, a signed-in user could currently call
-- supabaseClient.from('profiles').update({ coins: 999999 }) directly and it
-- would succeed. Narrow it down to just the two columns that are
-- legitimately client-writable today: username, and last_seen (written by
-- presence.js's heartbeat).
revoke update on public.profiles from authenticated;
grant update (username, last_seen) on public.profiles to authenticated;

-- Awards exactly one coin, at most once per rolling 24-hour window. Returns
-- the new coin balance so the client doesn't need a separate refetch just to
-- show the updated count. "Miss a day, miss that coin" falls out naturally
-- from this being a rolling window with no banking - you can never have more
-- than one check-in "pending" at a time.
create or replace function public.claim_daily_checkin()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  last_claim timestamptz;
  new_coins integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select last_checkin_at into last_claim from public.profiles where id = uid for update;

  if last_claim is not null and now() - last_claim < interval '24 hours' then
    raise exception 'Already checked in today';
  end if;

  update public.profiles
  set coins = coins + 1, last_checkin_at = now()
  where id = uid
  returning coins into new_coins;

  return new_coins;
end;
$$;

-- Buys an item at shop_items' server-side price (never a client-supplied
-- price), records ownership in user_inventory, and returns the new coin
-- balance. Does not auto-equip - equip_avatar()/equip_title() below handle
-- that as a separate, free action.
create or replace function public.purchase_item(p_item_id text)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  item_price integer;
  current_coins integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select price into item_price from public.shop_items where id = p_item_id;
  if item_price is null then
    raise exception 'Item not found';
  end if;

  if exists (select 1 from public.user_inventory where user_id = uid and item_id = p_item_id) then
    raise exception 'Item already owned';
  end if;

  select coins into current_coins from public.profiles where id = uid for update;
  if current_coins < item_price then
    raise exception 'Not enough coins';
  end if;

  update public.profiles set coins = coins - item_price where id = uid;
  insert into public.user_inventory (user_id, item_id) values (uid, p_item_id);

  return current_coins - item_price;
end;
$$;

-- p_item_id may be null to unequip (revert to the default "?" avatar).
-- Otherwise errors unless the caller actually owns that item and it's an
-- avatar (not a title).
create or replace function public.equip_avatar(p_item_id text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_item_id is not null and not exists (
    select 1 from public.user_inventory ui
    join public.shop_items si on si.id = ui.item_id
    where ui.user_id = uid and ui.item_id = p_item_id and si.type = 'avatar'
  ) then
    raise exception 'Avatar not owned';
  end if;

  update public.profiles set avatar_id = p_item_id where id = uid;
end;
$$;

-- Same as equip_avatar() but for the title_id slot.
create or replace function public.equip_title(p_item_id text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_item_id is not null and not exists (
    select 1 from public.user_inventory ui
    join public.shop_items si on si.id = ui.item_id
    where ui.user_id = uid and ui.item_id = p_item_id and si.type = 'title'
  ) then
    raise exception 'Title not owned';
  end if;

  update public.profiles set title_id = p_item_id where id = uid;
end;
$$;
