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

-- ---------- Phase 13: title colors, item notices, always-owned defaults ----------

alter table public.shop_items add column if not exists color text;   -- titles only, e.g. '#d4af37'
alter table public.shop_items add column if not exists notice text;  -- optional banner shown on the item's shop card

-- The "?" avatar and "Freshy" title every account already gets by default
-- (previously just a null avatar_id/title_id special case) are now real,
-- permanently free shop_items rows that everyone owns - this lets the shop
-- offer them as normal Equip options alongside anything actually bought,
-- instead of needing a separate "revert to default" button.
insert into public.shop_items (id, type, name, price, image_path, title_text, color, notice) values
  ('avatar_default', 'avatar', 'Default', 0, null, null, null, null),
  ('title_freshy', 'title', 'Freshy', 0, null, 'Freshy', '#e0a75c', null)
on conflict (id) do nothing;

-- Grant both to every existing account...
insert into public.user_inventory (user_id, item_id)
select id, 'avatar_default' from public.profiles
on conflict (user_id, item_id) do nothing;

insert into public.user_inventory (user_id, item_id)
select id, 'title_freshy' from public.profiles
on conflict (user_id, item_id) do nothing;

-- ...and to every new signup from now on.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data->>'username');
  insert into public.user_inventory (user_id, item_id) values (new.id, 'avatar_default');
  insert into public.user_inventory (user_id, item_id) values (new.id, 'title_freshy');
  return new;
end;
$$;

-- ---------- Phase 14: hidden/restricted shop items (e.g. admin-only titles) ----------

-- A hidden item never appears in the shop for anyone to browse or buy -
-- ownership is only ever granted directly (see shop_items_seed.sql's
-- "Restricted items" section), never purchased. purchase_item() is updated
-- to refuse buying a hidden item even via a direct RPC call - hiding it
-- from the shop UI alone wouldn't stop that.
alter table public.shop_items add column if not exists hidden boolean not null default false;

create or replace function public.purchase_item(p_item_id text)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  item_price integer;
  item_hidden boolean;
  current_coins integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select price, hidden into item_price, item_hidden from public.shop_items where id = p_item_id;
  if item_price is null then
    raise exception 'Item not found';
  end if;
  if item_hidden then
    raise exception 'Item not available for purchase';
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

-- ---------- Phase 15: dedupe game recording so a mid-match session drop on one side doesn't lose the result ----------

-- Previously only one side (the host, or the joiner if the host wasn't
-- logged in AT CONNECT TIME) ever attempted to record a finished online
-- match. If that preferred side's session became invalid mid-match (e.g. a
-- browser clearing cookies/storage), neither side ended up recording it -
-- the side that lost its session correctly skipped (no longer logged in),
-- but the other side's "is the host still logged in" check was based on a
-- stale snapshot from when the match started, so it skipped too. Now both
-- sides independently attempt to record if THEY are currently logged in;
-- this unique constraint on the shared per-match id (Net.matchId, the same
-- id the signaling server already uses to pair the two clients) makes a
-- double-insert harmless in the normal case where both are still logged
-- in - whichever arrives first wins, the other is simply rejected.
alter table public.games add column if not exists client_match_id text;

create unique index if not exists games_client_match_id_key
  on public.games (client_match_id)
  where client_match_id is not null;

-- ---------- Phase 16: garden - plant and grow "Minos" from human games ----------

alter table public.profiles add column if not exists garden_pot_count integer not null default 3;
-- Distinct from shop_items.hidden - e.g. the Admin title is hidden but not
-- mino_giftable, since it's granted to one specific account, not a random
-- gift pool everyone can eventually receive.
alter table public.shop_items add column if not exists mino_giftable boolean not null default false;

create table if not exists public.minos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  color text not null,
  rarity text not null check (rarity in ('common', 'uncommon', 'rare', 'epic', 'legendary')),
  modifier text,                               -- null ~80% of the time - purely cosmetic flavor
  stage text not null default 'seed' check (stage in ('seed', 'sapling', 'adolescent', 'adult')),
  growth_progress integer not null default 0,  -- human (casual/ranked) games played since the last stage-up
  planted boolean not null default false,
  name text,
  seen boolean not null default true,          -- false only for a game-reward seed, until acknowledged client-side
  last_gift_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.minos enable row level security;

drop policy if exists "Minos are publicly readable" on public.minos;
create policy "Minos are publicly readable"
  on public.minos for select
  using (true);

-- No insert/update/delete policy - every mutation goes through the
-- security definer functions below, same as coins/shop/inventory.

create or replace function public.random_mino_color()
returns text
language sql
as $$
  select (array['Crimson','Amber','Gold','Verdant','Teal','Azure','Violet','Magenta','Umber','Slate'])
    [floor(random() * 10 + 1)];
$$;

create or replace function public.random_mino_rarity()
returns text
language sql
as $$
  select case
    when r < 0.50 then 'common'
    when r < 0.77 then 'uncommon'
    when r < 0.92 then 'rare'
    when r < 0.98 then 'epic'
    else 'legendary'
  end
  from (select random() as r) rolled;
$$;

create or replace function public.random_mino_modifier()
returns text
language sql
as $$
  select case when random() < 0.2
    then (array['Spotted','Striped','Glowing','Sparkly','Fuzzy','Iridescent','Shadowy','Radiant','Freckled','Metallic'])
      [floor(random() * 10 + 1)]
    else null
  end;
$$;

-- Shared by buy_seed_pack() and the human-game trigger below, so the same
-- roll logic isn't duplicated in two places.
create or replace function public.grant_random_seed(p_user_id uuid, p_seen boolean)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  new_id uuid;
begin
  insert into public.minos (user_id, color, rarity, modifier, seen)
  values (p_user_id, public.random_mino_color(), public.random_mino_rarity(), public.random_mino_modifier(), p_seen)
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.plant_seed(p_mino_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  pot_count integer;
  planted_count integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1 from public.minos
    where id = p_mino_id and user_id = uid and not planted and stage = 'seed'
  ) then
    raise exception 'Seed not found';
  end if;

  select garden_pot_count into pot_count from public.profiles where id = uid;
  select count(*) into planted_count from public.minos where user_id = uid and planted;

  if planted_count >= pot_count then
    raise exception 'No free pots';
  end if;

  update public.minos set planted = true where id = p_mino_id;
end;
$$;

-- Digging up always resets a mino fully back to seed form (losing growth
-- progress) - it just frees the pot, it doesn't delete the mino, so its
-- color/rarity/modifier/name are preserved for replanting later.
create or replace function public.dig_up_mino(p_mino_id uuid)
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

  if not exists (select 1 from public.minos where id = p_mino_id and user_id = uid and planted) then
    raise exception 'Planted mino not found';
  end if;

  update public.minos
  set planted = false, stage = 'seed', growth_progress = 0
  where id = p_mino_id;
end;
$$;

create or replace function public.rename_mino(p_mino_id uuid, p_name text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  trimmed text := nullif(trim(p_name), '');
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if trimmed is not null and length(trimmed) > 24 then
    raise exception 'Name is too long';
  end if;

  if not exists (select 1 from public.minos where id = p_mino_id and user_id = uid) then
    raise exception 'Mino not found';
  end if;

  update public.minos set name = trimmed where id = p_mino_id;
end;
$$;

-- Flips a game-reward seed's "seen" flag once the new-seed toast has shown
-- it - kept as its own tiny RPC rather than a raw client update, same
-- no-direct-writes discipline as everything else on minos.
create or replace function public.mark_mino_seen(p_mino_id uuid)
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
  update public.minos set seen = true where id = p_mino_id and user_id = uid;
end;
$$;

create or replace function public.buy_pot()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  current_coins integer;
  pot_price constant integer := 10;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select coins into current_coins from public.profiles where id = uid for update;
  if current_coins < pot_price then
    raise exception 'Not enough coins';
  end if;

  update public.profiles
  set coins = coins - pot_price, garden_pot_count = garden_pot_count + 1
  where id = uid;

  return current_coins - pot_price;
end;
$$;

-- buy_seed_pack() originally lived here, returning uuid (granting a random
-- seed immediately on purchase). Phase 17 replaced it entirely with an
-- integer-returning version (granting a sealed pack to open later instead) -
-- see Phase 17 below for the current definition. Not left here even as a
-- duplicate no-op: since this whole file re-runs top-to-bottom every time,
-- a lingering "returns uuid" redefinition would re-break the function on
-- every single re-run after the first successful migration, erroring out
-- before Phase 17's fix further down the file ever got a chance to execute.

-- Growth, seed-drops, and adult gifts are all driven from here rather than
-- from the client - a games row only ever gets inserted once per match
-- (client_match_id's unique constraint, Phase 15) regardless of which of
-- the two clients' recordGameResult() call wins that race, and regardless
-- of whether a client learned the match ended via its own endGame() or via
-- a resync (which bypasses endGame() entirely). Hooking this to the client
-- would need to solve both of those problems again; hooking it here means
-- it just always fires exactly once per player per human game.
create or replace function public.handle_human_game_played()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  p_id uuid;
  m record;
  gift_item record;
begin
  foreach p_id in array array[new.player1_id, new.player2_id] loop
    if p_id is null then
      continue;
    end if;

    update public.minos
    set growth_progress = growth_progress + 1
    where user_id = p_id and planted and stage <> 'adult';

    update public.minos
    set stage = case stage
          when 'seed' then 'sapling'
          when 'sapling' then 'adolescent'
          when 'adolescent' then 'adult'
          else stage
        end,
        growth_progress = 0
    where user_id = p_id and planted and stage <> 'adult' and growth_progress >= 5;

    if random() < 0.1 then
      perform public.grant_random_seed(p_id, false);
    end if;

    -- Only advances last_gift_at on an actual hit (not every eligible
    -- game) - that's what keeps this "rare" instead of a flat weekly
    -- guarantee, while still averaging out to roughly once a week for a
    -- normally-active player.
    for m in
      select * from public.minos
      where user_id = p_id and planted and stage = 'adult'
        and (last_gift_at is null or now() - last_gift_at >= interval '7 days')
    loop
      if random() < 0.25 then
        select * into gift_item from public.shop_items
        where mino_giftable
          and id not in (select item_id from public.user_inventory where user_id = p_id)
        order by random()
        limit 1;

        if gift_item.id is not null and random() < 0.8 then
          insert into public.user_inventory (user_id, item_id) values (p_id, gift_item.id);
        else
          update public.profiles set coins = coins + (5 + floor(random() * 11)::integer) where id = p_id;
        end if;

        update public.minos set last_gift_at = now() where id = m.id;
      end if;
    end loop;
  end loop;

  return new;
end;
$$;

drop trigger if exists on_human_game_played on public.games;
create trigger on_human_game_played
  after insert on public.games
  for each row
  when (new.mode in ('casual', 'ranked'))
  execute function public.handle_human_game_played();

-- ---------- Phase 17: seed pack inventory (open-on-demand), companion Minos ----------

alter table public.profiles add column if not exists unopened_seed_packs integer not null default 0;
alter table public.profiles add column if not exists companion_mino_id uuid references public.minos(id) on delete set null;

-- Buying a pack no longer grants a seed immediately - it just adds a sealed
-- pack to inventory, so the client can show an "open when you're ready"
-- animation instead of an instant reveal. See open_seed_pack() below for the
-- actual grant. Postgres won't let create-or-replace change a function's
-- return type (this one used to return uuid), so the old definition has to
-- be dropped first.
drop function if exists public.buy_seed_pack();
create or replace function public.buy_seed_pack()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  current_coins integer;
  pack_price constant integer := 10;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select coins into current_coins from public.profiles where id = uid for update;
  if current_coins < pack_price then
    raise exception 'Not enough coins';
  end if;

  update public.profiles
  set coins = coins - pack_price, unopened_seed_packs = unopened_seed_packs + 1
  where id = uid;

  return current_coins - pack_price;
end;
$$;

create or replace function public.open_seed_pack()
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  pack_count integer;
  new_id uuid;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;

  select unopened_seed_packs into pack_count from public.profiles where id = uid for update;
  if pack_count is null or pack_count < 1 then
    raise exception 'No seed packs to open';
  end if;

  update public.profiles set unopened_seed_packs = unopened_seed_packs - 1 where id = uid;
  new_id := public.grant_random_seed(uid, true);
  return new_id;
end;
$$;

-- A companion must be a fully-grown adult - it's meant to show off a Mino
-- you've actually raised, not a freshly-planted seed. p_mino_id = null clears it.
create or replace function public.set_companion(p_mino_id uuid)
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

  if p_mino_id is not null and not exists (
    select 1 from public.minos where id = p_mino_id and user_id = uid and stage = 'adult'
  ) then
    raise exception 'Mino not found';
  end if;

  update public.profiles set companion_mino_id = p_mino_id where id = uid;
end;
$$;

-- Digging up resets a mino to seed form, which would break the "companion is
-- always an adult" invariant - clear the companion pointer too whenever the
-- mino being dug up happens to be the caller's current companion.
create or replace function public.dig_up_mino(p_mino_id uuid)
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

  if not exists (select 1 from public.minos where id = p_mino_id and user_id = uid and planted) then
    raise exception 'Planted mino not found';
  end if;

  update public.minos
  set planted = false, stage = 'seed', growth_progress = 0
  where id = p_mino_id;

  update public.profiles set companion_mino_id = null
  where id = uid and companion_mino_id = p_mino_id;
end;
$$;

-- ---------- Phase 18: harden games/singleplayer_runs against fabricated results ----------

-- A client-submitted games row was previously trusted completely as long as
-- the inserting user's own id appeared as player1_id or player2_id -
-- nothing stopped naming an uninvolved account as the "opponent" (no
-- consent required) or looping this to grind ELO/W-L/garden rewards
-- arbitrarily via DevTools. These two constraints close the cheapest,
-- no-downside gaps. A determined attacker controlling both named accounts
-- can still do real damage - the actual fix for that (requiring both named
-- players' clients to independently agree on a result before it's
-- finalized) is a bigger redesign, tracked separately from this pass.
alter table public.games drop constraint if exists games_distinct_players_check;
alter table public.games add constraint games_distinct_players_check
  check (player1_id is null or player2_id is null or player1_id <> player2_id);

-- +1 headroom: game.js bakes a 1-point "moved second" handicap directly
-- into score1/score2 (HANDICAP_POINTS), so a fully-enclosed board can
-- legitimately total board_size^2 + 1, not just board_size^2.
alter table public.games drop constraint if exists games_score_plausible_check;
alter table public.games add constraint games_score_plausible_check
  check (score1 >= 0 and score2 >= 0 and score1 + score2 <= board_size * board_size + 1);

-- Rate-limits how often the same pair of accounts can record a ranked/casual
-- result. This doesn't stop a determined attacker outright - every field on
-- the row is still client-supplied - but it turns "spam thousands of fake
-- wins instantly" into "grind slowly for days," a very different risk
-- profile, especially combined with the self-match check above. Scoped to
-- casual/ranked only (what actually feeds ELO and garden rewards) -
-- private/bot games aren't rate-limited.
create or replace function public.check_game_rate_limit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  p1 uuid;
  p2 uuid;
  recent_count integer;
begin
  if new.mode not in ('casual', 'ranked') or new.player1_id is null or new.player2_id is null then
    return new;
  end if;

  -- Order-independent pair lookup, since which account ends up as
  -- player1 vs player2 depends on who's the WebRTC "host" for that match,
  -- not on which two accounts are actually playing.
  p1 := least(new.player1_id, new.player2_id);
  p2 := greatest(new.player1_id, new.player2_id);

  select count(*) into recent_count
  from public.games
  where least(player1_id, player2_id) = p1
    and greatest(player1_id, player2_id) = p2
    and mode in ('casual', 'ranked')
    and ended_at > now() - interval '30 seconds'
    -- Excludes the legitimate case where both clients in the SAME match
    -- independently attempt to record it (client_match_id's unique index,
    -- Phase 15, is what's supposed to reject that one as a harmless
    -- duplicate) - only a genuinely different match should count here.
    and client_match_id is distinct from new.client_match_id;

  if recent_count > 0 then
    raise exception 'Recording games between the same two players too quickly';
  end if;

  return new;
end;
$$;

drop trigger if exists on_game_rate_limit on public.games;
create trigger on_game_rate_limit
  before insert on public.games
  for each row
  execute function public.check_game_rate_limit();

-- Previously the client itself decided "is this better than my existing
-- best" before inserting/updating singleplayer_runs directly - RLS only
-- checked row ownership, not plausibility, so a user could set their own
-- time_ms to anything (e.g. 1) via DevTools and top the speedrun
-- leaderboard. Moves the "is this actually an improvement" comparison
-- server-side, where it can't be skipped, and returns the resulting best
-- time so the client can still show an accurate message.
drop policy if exists "Users can insert their own singleplayer run" on public.singleplayer_runs;
drop policy if exists "Users can update their own singleplayer run" on public.singleplayer_runs;

create or replace function public.submit_singleplayer_time(p_time_ms integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_time integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_time_ms is null or p_time_ms <= 0 then
    raise exception 'Invalid time';
  end if;

  select time_ms into existing_time from public.singleplayer_runs where user_id = uid for update;

  if existing_time is null then
    insert into public.singleplayer_runs (user_id, time_ms) values (uid, p_time_ms);
    return p_time_ms;
  elsif p_time_ms < existing_time then
    update public.singleplayer_runs set time_ms = p_time_ms, completed_at = now() where user_id = uid;
    return p_time_ms;
  else
    return existing_time;
  end if;
end;
$$;

-- ---------- Phase 19: seed drop rate 1-in-10 -> 1-in-8 human games ----------

create or replace function public.handle_human_game_played()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  p_id uuid;
  m record;
  gift_item record;
begin
  foreach p_id in array array[new.player1_id, new.player2_id] loop
    if p_id is null then
      continue;
    end if;

    update public.minos
    set growth_progress = growth_progress + 1
    where user_id = p_id and planted and stage <> 'adult';

    update public.minos
    set stage = case stage
          when 'seed' then 'sapling'
          when 'sapling' then 'adolescent'
          when 'adolescent' then 'adult'
          else stage
        end,
        growth_progress = 0
    where user_id = p_id and planted and stage <> 'adult' and growth_progress >= 5;

    if random() < 0.125 then
      perform public.grant_random_seed(p_id, false);
    end if;

    -- Only advances last_gift_at on an actual hit (not every eligible
    -- game) - that's what keeps this "rare" instead of a flat weekly
    -- guarantee, while still averaging out to roughly once a week for a
    -- normally-active player.
    for m in
      select * from public.minos
      where user_id = p_id and planted and stage = 'adult'
        and (last_gift_at is null or now() - last_gift_at >= interval '7 days')
    loop
      if random() < 0.25 then
        select * into gift_item from public.shop_items
        where mino_giftable
          and id not in (select item_id from public.user_inventory where user_id = p_id)
        order by random()
        limit 1;

        if gift_item.id is not null and random() < 0.8 then
          insert into public.user_inventory (user_id, item_id) values (p_id, gift_item.id);
        else
          update public.profiles set coins = coins + (5 + floor(random() * 11)::integer) where id = p_id;
        end if;

        update public.minos set last_gift_at = now() where id = m.id;
      end if;
    end loop;
  end loop;

  return new;
end;
$$;

-- ---------- Phase 20: buy coins with real money (Stripe Checkout) ----------

-- One row per successfully-processed Stripe Checkout session. The unique
-- constraint on stripe_session_id is what makes grant_coin_purchase() below
-- idempotent - Stripe redelivers webhook events on retry, and this makes a
-- redelivery a no-op instead of double-granting coins.
create table if not exists public.coin_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  stripe_session_id text not null unique,
  package_id text not null,
  coins_granted integer not null,
  amount_cents integer not null,
  created_at timestamptz not null default now()
);

alter table public.coin_purchases enable row level security;

drop policy if exists "Users can view their own purchases" on public.coin_purchases;
create policy "Users can view their own purchases"
  on public.coin_purchases for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy for authenticated - only the stripe-webhook
-- Edge Function ever writes here, via the service-role key (which bypasses
-- RLS entirely regardless of policy).

-- Called by the stripe-webhook Edge Function only, after it has already
-- verified the Stripe webhook signature - this function itself trusts its
-- caller completely (same as every other security definer function here,
-- it's the CALLER's job - the webhook - to have verified the request before
-- ever getting this far). Wraps the purchase record + coin grant in one
-- atomic operation so a Stripe webhook redelivery can never grant coins
-- twice: the insert either succeeds (first time seeing this session) or
-- conflicts and no-ops (redelivery), and the coin grant only happens when
-- the insert actually took effect.
create or replace function public.grant_coin_purchase(
  p_user_id uuid,
  p_stripe_session_id text,
  p_package_id text,
  p_coins integer,
  p_amount_cents integer
)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.coin_purchases (user_id, stripe_session_id, package_id, coins_granted, amount_cents)
  values (p_user_id, p_stripe_session_id, p_package_id, p_coins, p_amount_cents)
  on conflict (stripe_session_id) do nothing;

  if found then
    update public.profiles set coins = coins + p_coins where id = p_user_id;
  end if;
end;
$$;

-- ---------- Phase 21: public "Stats" page ----------

-- Every table read here (profiles, games) already has a public "select using
-- (true)" RLS policy, so these are plain read-only aggregate functions - no
-- security definer needed. Marked stable since they only read, which lets
-- Postgres cache the result within a single query/transaction.

-- A pvp game is one with a real human on both sides - player2_id is only
-- ever null for 'bot' mode games (see the games table's own comment), so
-- this one condition cleanly covers casual/ranked/private matches without
-- needing to enumerate every non-bot mode by name.
create or replace function public.get_platform_stats()
returns table (
  registered_users bigint,
  games_played bigint,
  pvp_games_played bigint,
  total_hours_played numeric
)
language sql
stable
as $$
  select
    (select count(*) from public.profiles),
    (select count(*) from public.games),
    (select count(*) from public.games where player2_id is not null),
    (
      select coalesce(round(sum(
        case
          -- started_at has been recorded since this table's very first
          -- phase, but a handful of rows (very old games, or ones where a
          -- client disconnected mid-game and the row was only finalized
          -- long after play actually stopped) end up with an implausible
          -- duration either way - fall back to a typical game's length
          -- instead of letting a few outliers skew the total.
          when extract(epoch from (ended_at - started_at)) between 10 and 1800
            then extract(epoch from (ended_at - started_at))
          else 300
        end
      ) / 3600.0, 1), 0)
      from public.games
    );
$$;

-- get_p1_p2_win_rates() originally lived here, returning
-- (p1_wins, p2_wins, ties, total_games). Phase 27 replaced it entirely
-- with a ties-free 3-column version (folding historical ties into
-- p1_wins) - see Phase 27 below for the current definition. Not left
-- here even as a duplicate no-op: since this whole file re-runs top-to-
-- bottom every time, a lingering 4-column redefinition would re-break
-- the function (via "cannot change return type of existing function") on
-- every single re-run after the first successful migration, erroring out
-- before Phase 27's fix further down the file ever got a chance to
-- execute - the exact same class of bug buy_seed_pack() hit back in
-- Phase 16/17.

-- For every pvp game with a recorded move log, finds each player's very
-- first placement (rn = 1 within that game+player) and groups win rate by
-- the shape they opened with. Ties count toward games_count but not
-- win_count, same as a normal win-rate definition.
create or replace function public.get_first_piece_win_rates()
returns table (
  shape_name text,
  games_count bigint,
  win_count bigint,
  win_rate numeric
)
language sql
stable
as $$
  with first_moves as (
    select
      g.winner,
      (elem.value->>'player')::int as player,
      elem.value->>'shapeName' as shape_name,
      row_number() over (
        partition by g.id, (elem.value->>'player')::int
        order by elem.ord
      ) as rn
    from public.games g,
         jsonb_array_elements(g.move_log) with ordinality as elem(value, ord)
    where g.move_log is not null
      and g.player2_id is not null
  )
  select
    shape_name,
    count(*) as games_count,
    count(*) filter (where winner = player) as win_count,
    round(100.0 * count(*) filter (where winner = player) / count(*), 1) as win_rate
  from first_moves
  where rn = 1
  group by shape_name
  order by win_rate desc;
$$;

-- Ties are excluded (winner is null) since there's no winner/loser to
-- average on either side of a tied game.
create or replace function public.get_score_averages()
returns table (
  avg_winner_score numeric,
  avg_loser_score numeric,
  sample_size bigint
)
language sql
stable
as $$
  select
    round(avg(case when winner = 1 then score1 else score2 end), 2),
    round(avg(case when winner = 1 then score2 else score1 end), 2),
    count(*)
  from public.games
  where player2_id is not null and winner is not null;
$$;

-- ---------- Phase 22: random game-reward seeds are granted as a sealed pack ----------

-- Opening a seed pack (see garden.js's openPackWithAnimation()) is a much
-- more satisfying reveal than the seed just silently already existing,
-- fully revealed, the next time the player loads any page - so the random
-- 1-in-8 drop from playing now grants a sealed pack instead of calling
-- grant_random_seed() directly (that function/its p_seen flag and the
-- minos.seen column are untouched - open_seed_pack() still uses
-- grant_random_seed(uid, true) exactly as before). A counter rather than a
-- boolean, since more than one could stack up between page loads - same
-- "haven't shown this yet" role minos.seen plays for an individual seed,
-- just for a fungible pack count instead.
alter table public.profiles add column if not exists pending_pack_notifications integer not null default 0;

create or replace function public.handle_human_game_played()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  p_id uuid;
  m record;
  gift_item record;
begin
  foreach p_id in array array[new.player1_id, new.player2_id] loop
    if p_id is null then
      continue;
    end if;

    update public.minos
    set growth_progress = growth_progress + 1
    where user_id = p_id and planted and stage <> 'adult';

    update public.minos
    set stage = case stage
          when 'seed' then 'sapling'
          when 'sapling' then 'adolescent'
          when 'adolescent' then 'adult'
          else stage
        end,
        growth_progress = 0
    where user_id = p_id and planted and stage <> 'adult' and growth_progress >= 5;

    if random() < 0.125 then
      update public.profiles
      set unopened_seed_packs = unopened_seed_packs + 1,
          pending_pack_notifications = pending_pack_notifications + 1
      where id = p_id;
    end if;

    -- Only advances last_gift_at on an actual hit (not every eligible
    -- game) - that's what keeps this "rare" instead of a flat weekly
    -- guarantee, while still averaging out to roughly once a week for a
    -- normally-active player.
    for m in
      select * from public.minos
      where user_id = p_id and planted and stage = 'adult'
        and (last_gift_at is null or now() - last_gift_at >= interval '7 days')
    loop
      if random() < 0.25 then
        select * into gift_item from public.shop_items
        where mino_giftable
          and id not in (select item_id from public.user_inventory where user_id = p_id)
        order by random()
        limit 1;

        if gift_item.id is not null and random() < 0.8 then
          insert into public.user_inventory (user_id, item_id) values (p_id, gift_item.id);
        else
          update public.profiles set coins = coins + (5 + floor(random() * 11)::integer) where id = p_id;
        end if;

        update public.minos set last_gift_at = now() where id = m.id;
      end if;
    end loop;
  end loop;

  return new;
end;
$$;

-- Clears the counter once the client has shown its toast for it - same
-- acknowledge-on-dismiss pattern as mark_mino_seen().
create or replace function public.acknowledge_pack_notifications()
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
  update public.profiles set pending_pack_notifications = 0 where id = uid;
end;
$$;

-- ---------- Phase 23: split pvp stats from vs-bot stats on profiles ----------

-- games_played/wins/losses/ties mix every mode together, including 'bot'
-- practice games against no real opponent - the profile page shows those
-- as a separate, clearly-labeled "vs Bot" line instead of silently
-- inflating "regular" stats. Additive only: games_played/wins/losses/ties
-- themselves are untouched, so the leaderboard and anything else already
-- reading them (all-modes combined) keeps working exactly as before.
alter table public.profiles add column if not exists pvp_games_played integer not null default 0;
alter table public.profiles add column if not exists pvp_wins integer not null default 0;
alter table public.profiles add column if not exists pvp_losses integer not null default 0;
alter table public.profiles add column if not exists pvp_ties integer not null default 0;

alter table public.profiles add column if not exists bot_games_played integer not null default 0;
alter table public.profiles add column if not exists bot_wins integer not null default 0;
alter table public.profiles add column if not exists bot_losses integer not null default 0;
alter table public.profiles add column if not exists bot_ties integer not null default 0;

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
        ties = ties + case when new.winner is null then 1 else 0 end,
        pvp_games_played = pvp_games_played + case when new.player2_id is not null then 1 else 0 end,
        pvp_wins = pvp_wins + case when new.player2_id is not null and new.winner = 1 then 1 else 0 end,
        pvp_losses = pvp_losses + case when new.player2_id is not null and new.winner = 2 then 1 else 0 end,
        pvp_ties = pvp_ties + case when new.player2_id is not null and new.winner is null then 1 else 0 end,
        bot_games_played = bot_games_played + case when new.mode = 'bot' then 1 else 0 end,
        bot_wins = bot_wins + case when new.mode = 'bot' and new.winner = 1 then 1 else 0 end,
        bot_losses = bot_losses + case when new.mode = 'bot' and new.winner = 2 then 1 else 0 end,
        bot_ties = bot_ties + case when new.mode = 'bot' and new.winner is null then 1 else 0 end
    where id = new.player1_id;
  end if;

  -- player2_id is only ever set for a real pvp opponent (never 'bot' mode,
  -- which always leaves it null) - no bot_* increments needed here.
  if new.player2_id is not null then
    update public.profiles
    set games_played = games_played + 1,
        wins = wins + case when new.winner = 2 then 1 else 0 end,
        losses = losses + case when new.winner = 1 then 1 else 0 end,
        ties = ties + case when new.winner is null then 1 else 0 end,
        pvp_games_played = pvp_games_played + 1,
        pvp_wins = pvp_wins + case when new.winner = 2 then 1 else 0 end,
        pvp_losses = pvp_losses + case when new.winner = 1 then 1 else 0 end,
        pvp_ties = pvp_ties + case when new.winner is null then 1 else 0 end
    where id = new.player2_id;
  end if;

  return new;
end;
$$;

-- Backfill from existing games so anyone with history before this
-- migration doesn't show zeros - safe to re-run, always recomputes from
-- source rather than incrementing (same style as Phase 10's ranked backfill).
update public.profiles p
set pvp_games_played = coalesce(pv.games, 0),
    pvp_wins = coalesce(pv.wins, 0),
    pvp_losses = coalesce(pv.losses, 0),
    pvp_ties = coalesce(pv.ties, 0)
from (
  select player_id,
         count(*) as games,
         sum(case when winner = player_num then 1 else 0 end) as wins,
         sum(case when winner is not null and winner <> player_num then 1 else 0 end) as losses,
         sum(case when winner is null then 1 else 0 end) as ties
  from (
    select player1_id as player_id, 1 as player_num, winner from public.games where player1_id is not null and player2_id is not null
    union all
    select player2_id as player_id, 2 as player_num, winner from public.games where player2_id is not null
  ) per_player
  group by player_id
) pv
where p.id = pv.player_id;

update public.profiles p
set bot_games_played = coalesce(bt.games, 0),
    bot_wins = coalesce(bt.wins, 0),
    bot_losses = coalesce(bt.losses, 0),
    bot_ties = coalesce(bt.ties, 0)
from (
  select player1_id as player_id,
         count(*) as games,
         sum(case when winner = 1 then 1 else 0 end) as wins,
         sum(case when winner = 2 then 1 else 0 end) as losses,
         sum(case when winner is null then 1 else 0 end) as ties
  from public.games
  where mode = 'bot' and player1_id is not null
  group by player1_id
) bt
where p.id = bt.player_id;

-- ---------- Phase 24: seed pack drop rate 1-in-8 -> 1-in-10 human games ----------

create or replace function public.handle_human_game_played()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  p_id uuid;
  m record;
  gift_item record;
begin
  foreach p_id in array array[new.player1_id, new.player2_id] loop
    if p_id is null then
      continue;
    end if;

    update public.minos
    set growth_progress = growth_progress + 1
    where user_id = p_id and planted and stage <> 'adult';

    update public.minos
    set stage = case stage
          when 'seed' then 'sapling'
          when 'sapling' then 'adolescent'
          when 'adolescent' then 'adult'
          else stage
        end,
        growth_progress = 0
    where user_id = p_id and planted and stage <> 'adult' and growth_progress >= 5;

    if random() < 0.1 then
      update public.profiles
      set unopened_seed_packs = unopened_seed_packs + 1,
          pending_pack_notifications = pending_pack_notifications + 1
      where id = p_id;
    end if;

    -- Only advances last_gift_at on an actual hit (not every eligible
    -- game) - that's what keeps this "rare" instead of a flat weekly
    -- guarantee, while still averaging out to roughly once a week for a
    -- normally-active player.
    for m in
      select * from public.minos
      where user_id = p_id and planted and stage = 'adult'
        and (last_gift_at is null or now() - last_gift_at >= interval '7 days')
    loop
      if random() < 0.25 then
        select * into gift_item from public.shop_items
        where mino_giftable
          and id not in (select item_id from public.user_inventory where user_id = p_id)
        order by random()
        limit 1;

        if gift_item.id is not null and random() < 0.8 then
          insert into public.user_inventory (user_id, item_id) values (p_id, gift_item.id);
        else
          update public.profiles set coins = coins + (5 + floor(random() * 11)::integer) where id = p_id;
        end if;

        update public.minos set last_gift_at = now() where id = m.id;
      end if;
    end loop;
  end loop;

  return new;
end;
$$;

-- ---------- Phase 25: allow anonymous/guest bot-mode games to be recorded ----------

-- A guest's practice game against the bot is still a real game of
-- Minogoe - recent.js/profile.js/replay.js already all render a null
-- player1_id as "Guest" (and player2_id is always null for bot mode
-- regardless of who's logged in), so the only thing stopping this was
-- RLS: the original policy required auth.uid() to match one of the
-- player id columns, which an anonymous request (auth.uid() is null) can
-- never satisfy even when both columns are also null. Carves out exactly
-- one narrow exception - a fully-anonymous mode='bot' row - rather than
-- loosening the check for any other case. No reward is at stake either
-- way (handle_game_recorded()/on_human_game_played already only touch a
-- profile when player1_id/player2_id is actually set), so there's
-- nothing meaningful to gain by spamming fake rows here.
drop policy if exists "Participants can insert their own games" on public.games;
create policy "Participants can insert their own games"
  on public.games for insert
  with check (
    auth.uid() = player1_id or auth.uid() = player2_id
    or (mode = 'bot' and player1_id is null and player2_id is null)
  );

-- ---------- Phase 26: lower player 2's handicap from a full point to half a point ----------

-- HANDICAP_POINTS in game.js dropped from 1 to 0.5, so a game's final
-- score can now legitimately be a half-point (e.g. 45.5) - score1/score2
-- need to accept that instead of erroring on every single ranked/casual
-- insert going forward (an integer column rejects a non-integer value
-- outright, it doesn't silently round it). Existing whole-number rows are
-- unaffected by widening the type.
alter table public.games alter column score1 type numeric using score1::numeric;
alter table public.games alter column score2 type numeric using score2::numeric;

-- Tightened headroom to match (was +1, sized for a full-point handicap -
-- see the games_score_plausible_check comment further up in Phase 18).
alter table public.games drop constraint if exists games_score_plausible_check;
alter table public.games add constraint games_score_plausible_check
  check (score1 >= 0 and score2 >= 0 and score1 + score2 <= board_size * board_size + 0.5);

-- ---------- Phase 27: fold ties into player 1's win rate on the Stats page ----------

-- A tie was only ever possible when player1's raw (pre-handicap)
-- territory exceeded player2's by exactly the handicap amount - the ONLY
-- pvp game state that used to land exactly even after player2's bonus was
-- added. Since Phase 26 dropped that bonus to 0.5 (never a whole-number
-- gap, since territory counts are always whole numbers), that exact
-- equality is no longer reachable - winner is never null for a pvp game
-- decided by territory anymore, going forward. For the historical rows
-- that still have winner is null from before that change, player1 is
-- retroactively credited the win here: with a smaller 0.5 bonus, those
-- exact-tie games would have stayed a player1 lead instead of being
-- pulled level. This only changes how get_p1_p2_win_rates() reports past
-- results on the Stats page - the underlying games rows, replays, and
-- every other stat are untouched.
drop function if exists public.get_p1_p2_win_rates();
create or replace function public.get_p1_p2_win_rates()
returns table (
  p1_wins bigint,
  p2_wins bigint,
  total_games bigint
)
language sql
stable
as $$
  select
    count(*) filter (where winner = 1 or winner is null),
    count(*) filter (where winner = 2),
    count(*)
  from public.games
  where player2_id is not null;
$$;

-- ---------- Phase 28: fold ties into wins everywhere, drop the ties columns entirely ----------

-- Extends Phase 27's "a historical tie would have been a player1 win
-- under the smaller 0.5 handicap" reclassification from just the Stats
-- page to every wins/losses counter site-wide - the leaderboard and
-- profile page both still had a ties column that could now only ever be
-- 0 for a brand new game, but still carried old historical counts. Does
-- NOT touch games.winner itself, any individual match's recorded result,
-- or any ELO rating/delta already on the books - only how the SUMMARY
-- counters tally historical results changes. (Retroactively recomputing
-- ELO history is a much bigger, path-dependent undertaking - deliberately
-- out of scope here, same as not touching games.winner.)

-- Redefine the triggers FIRST, before dropping the ties columns below -
-- otherwise there'd be a window where a live trigger still references a
-- column that no longer exists.
create or replace function public.handle_game_recorded()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.player1_id is not null then
    update public.profiles
    set games_played = games_played + 1,
        wins = wins + case when new.winner = 1 or new.winner is null then 1 else 0 end,
        losses = losses + case when new.winner = 2 then 1 else 0 end,
        pvp_games_played = pvp_games_played + case when new.player2_id is not null then 1 else 0 end,
        pvp_wins = pvp_wins + case when new.player2_id is not null and (new.winner = 1 or new.winner is null) then 1 else 0 end,
        pvp_losses = pvp_losses + case when new.player2_id is not null and new.winner = 2 then 1 else 0 end,
        bot_games_played = bot_games_played + case when new.mode = 'bot' then 1 else 0 end,
        bot_wins = bot_wins + case when new.mode = 'bot' and (new.winner = 1 or new.winner is null) then 1 else 0 end,
        bot_losses = bot_losses + case when new.mode = 'bot' and new.winner = 2 then 1 else 0 end
    where id = new.player1_id;
  end if;

  if new.player2_id is not null then
    update public.profiles
    set games_played = games_played + 1,
        wins = wins + case when new.winner = 2 then 1 else 0 end,
        losses = losses + case when new.winner = 1 or new.winner is null then 1 else 0 end,
        pvp_games_played = pvp_games_played + 1,
        pvp_wins = pvp_wins + case when new.winner = 2 then 1 else 0 end,
        pvp_losses = pvp_losses + case when new.winner = 1 or new.winner is null then 1 else 0 end
    where id = new.player2_id;
  end if;

  return new;
end;
$$;

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
  -- A tie (winner is null) is folded into a player1 win here too, same as
  -- everywhere else in this phase - kept only as a defensive fallback,
  -- since a null winner should no longer be possible for a real
  -- territory-decided ranked game (see Phase 26/27).
  actual_p1 := case when new.winner = 2 then 0 else 1 end;

  delta_p1 := round(k * (actual_p1 - expected_p1));
  delta_p2 := -delta_p1;

  update public.profiles
  set elo_rating = elo_rating + delta_p1,
      ranked_games_played = ranked_games_played + 1,
      ranked_wins = ranked_wins + case when new.winner = 1 or new.winner is null then 1 else 0 end,
      ranked_losses = ranked_losses + case when new.winner = 2 then 1 else 0 end
  where id = new.player1_id;

  update public.profiles
  set elo_rating = elo_rating + delta_p2,
      ranked_games_played = ranked_games_played + 1,
      ranked_wins = ranked_wins + case when new.winner = 2 then 1 else 0 end,
      ranked_losses = ranked_losses + case when new.winner = 1 or new.winner is null then 1 else 0 end
  where id = new.player2_id;

  update public.games set elo_delta_p1 = delta_p1, elo_delta_p2 = delta_p2 where id = new.id;

  return new;
end;
$$;

-- Recompute every wins/losses counter from source, folding winner is null
-- into a player1 win / player2 loss - same backfill style as Phase 10/23,
-- safe to re-run (always recomputes rather than incrementing). games_played
-- and its pvp_/ranked_/bot_ variants are untouched - a former tie still
-- counted as a game played either way, only the win/loss split changes.
update public.profiles p
set wins = coalesce(al.wins, 0),
    losses = coalesce(al.losses, 0)
from (
  select player_id,
         sum(case
               when winner = player_num then 1
               when winner is null and player_num = 1 then 1
               else 0
             end) as wins,
         sum(case
               when winner is not null and winner <> player_num then 1
               when winner is null and player_num = 2 then 1
               else 0
             end) as losses
  from (
    select player1_id as player_id, 1 as player_num, winner from public.games where player1_id is not null
    union all
    select player2_id as player_id, 2 as player_num, winner from public.games where player2_id is not null
  ) per_player
  group by player_id
) al
where p.id = al.player_id;

update public.profiles p
set pvp_wins = coalesce(pv.wins, 0),
    pvp_losses = coalesce(pv.losses, 0)
from (
  select player_id,
         sum(case
               when winner = player_num then 1
               when winner is null and player_num = 1 then 1
               else 0
             end) as wins,
         sum(case
               when winner is not null and winner <> player_num then 1
               when winner is null and player_num = 2 then 1
               else 0
             end) as losses
  from (
    select player1_id as player_id, 1 as player_num, winner from public.games where player1_id is not null and player2_id is not null
    union all
    select player2_id as player_id, 2 as player_num, winner from public.games where player2_id is not null
  ) per_player
  group by player_id
) pv
where p.id = pv.player_id;

update public.profiles p
set ranked_wins = coalesce(rk.wins, 0),
    ranked_losses = coalesce(rk.losses, 0)
from (
  select player_id,
         sum(case
               when winner = player_num then 1
               when winner is null and player_num = 1 then 1
               else 0
             end) as wins,
         sum(case
               when winner is not null and winner <> player_num then 1
               when winner is null and player_num = 2 then 1
               else 0
             end) as losses
  from (
    select player1_id as player_id, 1 as player_num, winner from public.games where mode = 'ranked' and player1_id is not null
    union all
    select player2_id as player_id, 2 as player_num, winner from public.games where mode = 'ranked' and player2_id is not null
  ) per_player
  group by player_id
) rk
where p.id = rk.player_id;

update public.profiles p
set bot_wins = coalesce(bt.wins, 0),
    bot_losses = coalesce(bt.losses, 0)
from (
  select player1_id as player_id,
         sum(case when winner = 1 or winner is null then 1 else 0 end) as wins,
         sum(case when winner = 2 then 1 else 0 end) as losses
  from public.games
  where mode = 'bot' and player1_id is not null
  group by player1_id
) bt
where p.id = bt.player_id;

-- Nothing reads or writes these anymore - drop them entirely.
alter table public.profiles drop column if exists ties;
alter table public.profiles drop column if exists pvp_ties;
alter table public.profiles drop column if exists ranked_ties;
alter table public.profiles drop column if exists bot_ties;
