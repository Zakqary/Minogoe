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

-- ---------- Phase 29: mino evolution takes 10 human games per stage instead of 5 ----------

-- growth_progress is reset to 0 in the same statement that stages a mino up
-- (the "growth_progress >= 5" update below always zeroes it in the same
-- run it fires in), so no currently-planted mino can have a stored
-- growth_progress >= 5 - every existing value is already a valid, smaller
-- amount of progress toward the new, higher bar. Raising the threshold is
-- therefore a pure behavior change going forward: nobody's progress is
-- lost, skipped, or double-counted, it just takes longer to fill from here.
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
    where user_id = p_id and planted and stage <> 'adult' and growth_progress >= 10;

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

-- ---------- Phase 30: halve ranked ELO movement on a 3rd+ consecutive same-opponent, same-result game (anti win-trading) ----------

-- A pair repeatedly playing only each other, with the exact same player
-- winning every time, is the classic win-trading pattern - one account
-- farms ELO off the other over and over with no real competitive risk.
-- This doesn't (and can't, from inside a single trigger) stop a determined
-- pair from doing it, but it cuts the rate at which it inflates/deflates
-- rating: once the SAME winner has taken the previous two ranked games
-- between exactly these two accounts, uninterrupted by either player
-- facing anyone else in between, and this new game continues that same
-- result, both players' ELO movement is halved.
alter table public.games add column if not exists elo_halved boolean not null default false;

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
  this_winner_id uuid;
  p1_recent_opps uuid[];
  p1_recent_winners uuid[];
  p2_recent_opps uuid[];
  is_halved boolean := false;
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

  this_winner_id := case when new.winner = 1 then new.player1_id when new.winner = 2 then new.player2_id else new.player1_id end;

  -- player1's (resp. player2's) last 2 ranked games, ANY opponent,
  -- excluding this one - used to confirm neither player faced anyone else
  -- in between, not just that the pair has 2 prior games between them
  -- somewhere in their history.
  select array_agg(opp_id order by ended_at desc), array_agg(winner_id order by ended_at desc)
  into p1_recent_opps, p1_recent_winners
  from (
    select
      case when player1_id = new.player1_id then player2_id else player1_id end as opp_id,
      case when winner = 1 then player1_id when winner = 2 then player2_id else player1_id end as winner_id,
      ended_at
    from public.games
    where mode = 'ranked' and id <> new.id
      and (player1_id = new.player1_id or player2_id = new.player1_id)
    order by ended_at desc
    limit 2
  ) sub;

  select array_agg(opp_id order by ended_at desc)
  into p2_recent_opps
  from (
    select
      case when player1_id = new.player2_id then player2_id else player1_id end as opp_id,
      ended_at
    from public.games
    where mode = 'ranked' and id <> new.id
      and (player1_id = new.player2_id or player2_id = new.player2_id)
    order by ended_at desc
    limit 2
  ) sub;

  if array_length(p1_recent_opps, 1) = 2 and array_length(p2_recent_opps, 1) = 2
     and p1_recent_opps[1] = new.player2_id and p1_recent_opps[2] = new.player2_id
     and p2_recent_opps[1] = new.player1_id and p2_recent_opps[2] = new.player1_id
     and p1_recent_winners[1] = this_winner_id and p1_recent_winners[2] = this_winner_id then
    is_halved := true;
    delta_p1 := round(delta_p1 / 2.0);
  end if;

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

  update public.games set elo_delta_p1 = delta_p1, elo_delta_p2 = delta_p2, elo_halved = is_halved where id = new.id;

  return new;
end;
$$;

-- ---------- Phase 31: server-side username validation on signup ----------

-- The signup form's minlength=3/maxlength=20 (auth-ui.js) was previously
-- the ONLY check on a new username - trivially bypassed by calling
-- supabaseClient.auth.signUp() directly from DevTools, which would let
-- anyone register a blank, thousands-of-characters-long, or emoji/control-
-- character username (usernames are shown all over the site: leaderboard,
-- profile, replays, in-game). Deliberately NOT a table CHECK constraint on
-- profiles.username - adding one retroactively could fail outright on this
-- very re-run if any already-registered account's existing username
-- doesn't fit the new rule, which isn't knowable from here. Validating
-- inside the trigger instead only ever applies to signups from this point
-- forward - existing accounts are completely untouched, and a rejected
-- signup just rolls back the auth.users insert cleanly (surfaced to the
-- client as a normal signUp() error).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  uname text := new.raw_user_meta_data->>'username';
begin
  if uname is null
     or char_length(uname) < 3
     or char_length(uname) > 20
     or uname !~ '^[A-Za-z0-9_\- ]+$' then
    raise exception 'Username must be 3-20 characters, using only letters, numbers, spaces, underscores, and hyphens.';
  end if;

  insert into public.profiles (id, username) values (new.id, uname);
  insert into public.user_inventory (user_id, item_id) values (new.id, 'avatar_default');
  insert into public.user_inventory (user_id, item_id) values (new.id, 'title_freshy');
  return new;
end;
$$;

-- ---------- Phase 32: profile scoring stats (points for/against, pvp only) ----------

-- score1/score2 are numeric (Phase 26's 0.5 handicap), so these accumulate
-- fractional totals too - fine, the client only ever shows them rounded to
-- 1 decimal place. Only pvp games count (player2_id is not null), same
-- gating as pvp_wins/pvp_losses - a vs-bot practice game's score shouldn't
-- pad or drag down a player's real scoring stats.
alter table public.profiles add column if not exists pvp_points_for numeric not null default 0;
alter table public.profiles add column if not exists pvp_points_against numeric not null default 0;

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
        pvp_points_for = pvp_points_for + case when new.player2_id is not null then new.score1 else 0 end,
        pvp_points_against = pvp_points_against + case when new.player2_id is not null then new.score2 else 0 end,
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
        pvp_losses = pvp_losses + case when new.winner = 1 or new.winner is null then 1 else 0 end,
        pvp_points_for = pvp_points_for + new.score2,
        pvp_points_against = pvp_points_against + new.score1
    where id = new.player2_id;
  end if;

  return new;
end;
$$;

-- Backfill from existing games - safe to re-run, always recomputes from
-- source rather than incrementing (same style as Phase 10/23/28).
update public.profiles p
set pvp_points_for = coalesce(pf.points_for, 0),
    pvp_points_against = coalesce(pf.points_against, 0)
from (
  select player_id,
         sum(my_score) as points_for,
         sum(opp_score) as points_against
  from (
    select player1_id as player_id, score1 as my_score, score2 as opp_score
    from public.games where player1_id is not null and player2_id is not null
    union all
    select player2_id as player_id, score2 as my_score, score1 as opp_score
    from public.games where player2_id is not null
  ) per_player
  group by player_id
) pf
where p.id = pf.player_id;

-- ---------- Phase 33: singleplayer "Eogonim" mode (minimize captured territory) ----------

-- singleplayer_runs previously held exactly one row per user (one global
-- best time, Speedrun-only). Adding a second mode means a user can now have
-- one best PER mode - mode defaults to 'speedrun' so every pre-existing row
-- is correctly tagged without a separate backfill. time_ms is only
-- meaningful for speedrun and score only for eogonim (lower is better in
-- both, just different units - milliseconds vs. captured squares), so each
-- is nullable and the check constraint below keeps exactly one of the two
-- set per row rather than trusting every future insert to get that right.
--
-- The allowed-values check is deliberately its own separate drop+add step
-- below, NOT an inline "check (...)" on this add column - this table
-- already went through one rename (the mode used to be called 'golf'), and
-- "add column if not exists" is a no-op once the column already exists, so
-- an inline check clause here would have silently kept enforcing the OLD
-- 'golf' value forever on any database that had already run an earlier
-- version of this phase - exactly what happened. Same bug class as
-- get_p1_p2_win_rates()/buy_seed_pack() earlier in this file, just for a
-- constraint instead of a function.
alter table public.singleplayer_runs add column if not exists mode text not null default 'speedrun';
alter table public.singleplayer_runs alter column time_ms drop not null;
alter table public.singleplayer_runs add column if not exists score integer;

-- Drop first, before the data migration below - if anyone managed to save
-- a run under the old 'golf' label before this rename, renaming that row
-- to 'eogonim' would itself violate the very constraint being replaced if
-- it were still in place.
alter table public.singleplayer_runs drop constraint if exists singleplayer_runs_mode_check;
update public.singleplayer_runs set mode = 'eogonim' where mode = 'golf';

-- Deliberately NOT re-adding singleplayer_runs_mode_check here (it used to
-- be re-added as check (mode in ('speedrun', 'eogonim')) at this exact
-- spot) - Phase 36 below adds a third mode ('ascension') to this same
-- constraint, and since this whole file re-runs top-to-bottom every time,
-- re-asserting THIS phase's narrower 2-value version on every re-run would
-- permanently reject any real 'ascension' row a player has since saved,
-- failing here before Phase 36's wider version ever got a chance to run -
-- exactly what happened. Same recurring bug class as
-- get_p1_p2_win_rates()/buy_seed_pack() earlier in this file, just for a
-- constraint that itself got widened a second time. The constraint is now
-- owned entirely by whichever phase last touches the mode column's allowed
-- values (Phase 36 today) - do not add a narrower version of it here again.

alter table public.singleplayer_runs drop constraint if exists singleplayer_runs_user_id_key;
alter table public.singleplayer_runs drop constraint if exists singleplayer_runs_user_id_mode_key;
alter table public.singleplayer_runs add constraint singleplayer_runs_user_id_mode_key unique (user_id, mode);

-- Deliberately NOT re-adding singleplayer_runs_mode_fields_check here either,
-- for the exact same reason as singleplayer_runs_mode_check just above (it
-- hit the identical failure - "check constraint ... is violated by some
-- row" - since this narrower 2-branch version was re-added on every re-run,
-- rejecting any real 'ascension' row before Phase 36's 3-branch version
-- below ever got a chance to run). Phase 36 owns this constraint now too -
-- do not add a narrower version of it here again.
alter table public.singleplayer_runs drop constraint if exists singleplayer_runs_mode_fields_check;

-- Re-scoped to mode = 'speedrun' explicitly now that a user can also have an
-- eogonim row - previously "where user_id = uid" alone was unambiguous
-- since speedrun was the only mode that existed.
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

  select time_ms into existing_time from public.singleplayer_runs where user_id = uid and mode = 'speedrun' for update;

  if existing_time is null then
    insert into public.singleplayer_runs (user_id, mode, time_ms) values (uid, 'speedrun', p_time_ms);
    return p_time_ms;
  elsif p_time_ms < existing_time then
    update public.singleplayer_runs set time_ms = p_time_ms, completed_at = now() where user_id = uid and mode = 'speedrun';
    return p_time_ms;
  else
    return existing_time;
  end if;
end;
$$;

-- Same "server decides if it's actually an improvement" discipline as
-- submit_singleplayer_time() - an eogonim score is a captured-square count
-- (lower is better, 0 is a perfect run), entirely client-computed from a
-- client-only board simulation, so this can't verify the number is
-- "correct" the way a server-authoritative game could - only that it's
-- non-negative and that it doesn't silently overwrite a genuinely better
-- existing best with a worse one.
create or replace function public.submit_singleplayer_score(p_score integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_score integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_score is null or p_score < 0 then
    raise exception 'Invalid score';
  end if;

  select score into existing_score from public.singleplayer_runs where user_id = uid and mode = 'eogonim' for update;

  if existing_score is null then
    insert into public.singleplayer_runs (user_id, mode, score) values (uid, 'eogonim', p_score);
    return p_score;
  elsif p_score < existing_score then
    update public.singleplayer_runs set score = p_score, completed_at = now() where user_id = uid and mode = 'eogonim';
    return p_score;
  else
    return existing_score;
  end if;
end;
$$;

-- ---------- Phase 34: rarer/announced Mino gifts, per-mino coin drop rate ----------

-- Every coin/item gift a Mino has ever given, so the client can toast about
-- it the next time any page loads - previously handle_human_game_played()
-- granted these completely silently (no client-visible signal at all), so a
-- player could easily rack up titles/coins from their garden and never
-- notice. Same acknowledge-on-dismiss pattern as pending_pack_notifications,
-- just with real per-gift detail (which mino, what it gave) instead of a
-- bare counter, since "you got a title" needs to say which one.
create table if not exists public.mino_gifts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  mino_id uuid references public.minos(id) on delete set null,
  gift_type text not null check (gift_type in ('coins', 'item')),
  coins_amount integer,  -- set only for gift_type = 'coins'
  item_id text references public.shop_items(id) on delete set null,  -- set only for gift_type = 'item'
  acknowledged boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.mino_gifts enable row level security;

drop policy if exists "Users can view their own mino gifts" on public.mino_gifts;
create policy "Users can view their own mino gifts"
  on public.mino_gifts for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy - only handle_human_game_played() (grants)
-- and acknowledge_mino_gifts() (marks read) below ever write here.

-- Rolled once, at seed-grant time, from the mino's rarity band - NOT
-- reachable by the player's own actions afterward (dig_up_mino() resets
-- stage/growth_progress back to seed form, but deliberately never touches
-- this column - see its own definition further up this file). Ranges
-- ascend with rarity: common 0.1-1%, uncommon 1-2%, rare 2-3%, epic 3-4%,
-- legendary 4-5% - legendary is the only tier that can ever roll above 4%.
create or replace function public.random_mino_coin_rate(p_rarity text)
returns numeric
language sql
as $$
  select round((
    case p_rarity
      when 'common' then 0.1 + random() * 0.9
      when 'uncommon' then 1.0 + random() * 1.0
      when 'rare' then 2.0 + random() * 1.0
      when 'epic' then 3.0 + random() * 1.0
      when 'legendary' then 4.0 + random() * 1.0
      else 0.1
    end
  )::numeric, 2);
$$;

-- Nullable initially (not "not null default ..."), specifically so the
-- backfill below only ever rolls a rate for a row that doesn't already
-- have one - on every re-run after the first, every row already has a
-- value (either from that first backfill, or from grant_random_seed()
-- always supplying one at insert time going forward), so this becomes a
-- true no-op instead of re-rolling everyone's rate on every schema re-run.
alter table public.minos add column if not exists coin_drop_rate numeric;
update public.minos set coin_drop_rate = public.random_mino_coin_rate(rarity) where coin_drop_rate is null;
alter table public.minos alter column coin_drop_rate set not null;

-- Rolls coin_drop_rate from the SAME rarity this seed is being granted, so
-- the two are always consistent (never a legendary mino stuck with a
-- common-tier rate or vice versa).
create or replace function public.grant_random_seed(p_user_id uuid, p_seen boolean)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  new_id uuid;
  rolled_rarity text := public.random_mino_rarity();
begin
  insert into public.minos (user_id, color, rarity, modifier, seen, coin_drop_rate)
  values (p_user_id, public.random_mino_color(), rolled_rarity, public.random_mino_modifier(), p_seen, public.random_mino_coin_rate(rolled_rarity))
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.acknowledge_mino_gifts()
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
  update public.mino_gifts set acknowledged = true where user_id = uid and not acknowledged;
end;
$$;

-- Reworked gift logic for every planted adult Mino, each human game:
--   - Coins: rolled INDEPENDENTLY every eligible game, at that specific
--     mino's own coin_drop_rate (0.1-5%, per the comment on that column) -
--     no cooldown, since the rate itself is now the only rarity lever this
--     needs (a legendary mino at ~4.5% already only pays out roughly once
--     every 20-odd games on average).
--   - Items (avatars/titles): a flat, much rarer 2% roll, but only once
--     last_gift_at's existing 7-day cooldown has elapsed - items keep that
--     extra throttle on top of their low odds specifically to stay a rare
--     event even for someone playing constantly. Of an item hit, only 1 in
--     4 tries for a title first (falling back to an avatar if none are
--     available to give) - titles end up roughly 4x rarer than avatars,
--     addressing that titles specifically felt too common before.
-- Both kinds are logged to mino_gifts for the client to toast about.
create or replace function public.handle_human_game_played()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  p_id uuid;
  m record;
  gift_item record;
  coins_granted integer;
  wants_title boolean;
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
    where user_id = p_id and planted and stage <> 'adult' and growth_progress >= 10;

    if random() < 0.1 then
      update public.profiles
      set unopened_seed_packs = unopened_seed_packs + 1,
          pending_pack_notifications = pending_pack_notifications + 1
      where id = p_id;
    end if;

    for m in
      select * from public.minos
      where user_id = p_id and planted and stage = 'adult'
    loop
      if (m.last_gift_at is null or now() - m.last_gift_at >= interval '7 days') and random() < 0.02 then
        wants_title := random() < 0.25;
        select * into gift_item from public.shop_items
        where mino_giftable and type = case when wants_title then 'title' else 'avatar' end
          and id not in (select item_id from public.user_inventory where user_id = p_id)
        order by random()
        limit 1;

        if gift_item.id is null then
          -- Preferred type had nothing left to give - fall back to
          -- whichever giftable type actually has an unowned item.
          select * into gift_item from public.shop_items
          where mino_giftable
            and id not in (select item_id from public.user_inventory where user_id = p_id)
          order by random()
          limit 1;
        end if;

        if gift_item.id is not null then
          insert into public.user_inventory (user_id, item_id) values (p_id, gift_item.id);
          insert into public.mino_gifts (user_id, mino_id, gift_type, item_id) values (p_id, m.id, 'item', gift_item.id);
          update public.minos set last_gift_at = now() where id = m.id;
        end if;
      end if;

      if random() < m.coin_drop_rate / 100.0 then
        coins_granted := 5 + floor(random() * 11)::integer;
        update public.profiles set coins = coins + coins_granted where id = p_id;
        insert into public.mino_gifts (user_id, mino_id, gift_type, coins_amount) values (p_id, m.id, 'coins', coins_granted);
      end if;
    end loop;
  end loop;

  return new;
end;
$$;

-- ---------- Phase 35: extra garden pots 10 coins -> 50 coins ----------

-- A pot is permanent and lets you keep an entire extra Mino growing (and
-- gifting coins/items) forever - underpriced at the same 10 coins as a
-- single-use seed pack given how much more utility it has.
create or replace function public.buy_pot()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  current_coins integer;
  pot_price constant integer := 50;
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

-- ---------- Phase 36: singleplayer "Ascension" mode (roguelike escalating rounds) ----------

-- Deliberately NOT adding/re-adding singleplayer_runs_mode_check or
-- singleplayer_runs_mode_fields_check here - this phase used to re-add both
-- with a 3-value mode list (missing 'blindeogonim' and 'exactmatch', added
-- by later phases), which on a full re-run of this file re-narrowed both
-- constraints right back down, rejecting any real 'blindeogonim'/
-- 'exactmatch' row a player had already saved before this phase even
-- finished running - failing here, before Phase 40/41 below's wider
-- versions ever got a chance to run. Same recurring bug class as
-- get_p1_p2_win_rates()/buy_seed_pack()/Phase 33's singleplayer_runs_mode_
-- check earlier in this file (and the identical mistake Phase 40 itself
-- made until it was fixed too) - whichever phase touches this constraint
-- LAST owns it (Phase 41 today); do not add a narrower version of either
-- constraint here again, in ANY earlier phase.
--
-- Ascension reuses the existing "score" column (an integer number of
-- rounds cleared) rather than adding a new column - same shape as eogonim's
-- score, just a different unit and a different "better" direction (higher,
-- not lower - handled client-side by refreshLeaderboard()'s sort order and
-- server-side by submit_ascension_score() below).

-- Same "server decides if it's actually an improvement" discipline as
-- submit_singleplayer_score(), but inverted: an ascension score is a round
-- count (higher is better), not a captured-square count (lower is better).
create or replace function public.submit_ascension_score(p_round integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_round integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_round is null or p_round < 0 then
    raise exception 'Invalid round';
  end if;

  select score into existing_round from public.singleplayer_runs where user_id = uid and mode = 'ascension' for update;

  if existing_round is null then
    insert into public.singleplayer_runs (user_id, mode, score) values (uid, 'ascension', p_round);
    return p_round;
  elsif p_round > existing_round then
    update public.singleplayer_runs set score = p_round, completed_at = now() where user_id = uid and mode = 'ascension';
    return p_round;
  else
    return existing_round;
  end if;
end;
$$;

-- ---------- Phase 37: profile "Highest ELO" and "Highest Ranked Win Streak" stats ----------

alter table public.profiles add column if not exists highest_elo integer not null default 1200;
alter table public.profiles add column if not exists ranked_win_streak integer not null default 0;
alter table public.profiles add column if not exists highest_ranked_win_streak integer not null default 0;

-- Reconstructs each player's true historical peak ELO from their full
-- elo_delta_p1/elo_delta_p2 history in chronological order, rather than
-- just backfilling "current rating" (which would understate anyone who's
-- ever been higher than they are now). Every account starts at 1200 (the
-- column default, never changed except by this trigger), so a running sum
-- of deltas in game order reconstructs the exact rating after each game;
-- the greatest(1200, ...) floor covers a player whose peak was actually
-- their untouched starting rating (e.g. someone who has only ever lost).
-- Safe to re-run - always recomputed from source, same as every other
-- backfill in this file.
with p_deltas as (
  select player1_id as player_id, elo_delta_p1 as delta, ended_at
  from public.games
  where mode = 'ranked' and player1_id is not null and elo_delta_p1 is not null
  union all
  select player2_id as player_id, elo_delta_p2 as delta, ended_at
  from public.games
  where mode = 'ranked' and player2_id is not null and elo_delta_p2 is not null
),
running as (
  select player_id,
         1200 + sum(delta) over (
           partition by player_id order by ended_at
           rows between unbounded preceding and current row
         ) as running_elo
  from p_deltas
),
peaks as (
  select player_id, max(running_elo) as peak_elo from running group by player_id
)
update public.profiles p
set highest_elo = greatest(1200, pk.peak_elo)
from peaks pk
where p.id = pk.player_id;

-- Same idea for win streaks - a classic "gaps and islands" grouping: two
-- consecutive ranked games for the same player land in the same group iff
-- neither their overall position nor their same-result position changed
-- between them, i.e. every game in between was also a win. The longest
-- "won" group is the historical peak; the group (if any) containing that
-- player's most recent ranked game is their CURRENT streak (0 if their
-- last ranked game was a loss, via the coalesce below).
with per_player_games as (
  select player1_id as player_id, (winner = 1 or winner is null) as won, ended_at
  from public.games where mode = 'ranked' and player1_id is not null
  union all
  select player2_id as player_id, (winner = 2) as won, ended_at
  from public.games where mode = 'ranked' and player2_id is not null
),
numbered as (
  select player_id, won, ended_at,
         row_number() over (partition by player_id order by ended_at) as overall_rn,
         row_number() over (partition by player_id, won order by ended_at) as same_result_rn
  from per_player_games
),
grouped as (
  select player_id, won, ended_at, (overall_rn - same_result_rn) as grp
  from numbered
),
win_streaks as (
  select player_id, grp, count(*) as streak_len, max(ended_at) as last_at
  from grouped
  where won
  group by player_id, grp
),
peak_streaks as (
  select player_id, max(streak_len) as peak_streak
  from win_streaks
  group by player_id
),
last_game_per_player as (
  select player_id, max(ended_at) as last_ended_at
  from per_player_games
  group by player_id
),
current_streaks as (
  select ws.player_id, ws.streak_len as current_streak
  from win_streaks ws
  join last_game_per_player lgp
    on lgp.player_id = ws.player_id and lgp.last_ended_at = ws.last_at
)
update public.profiles p
set highest_ranked_win_streak = ps.peak_streak,
    ranked_win_streak = coalesce(cs.current_streak, 0)
from peak_streaks ps
left join current_streaks cs on cs.player_id = ps.player_id
where p.id = ps.player_id;

-- Redefines handle_ranked_game() one more time to maintain the two new
-- streak/peak columns going forward - the ENTIRE body is copied forward
-- from Phase 30 (anti-win-trading halving included), not just the new
-- bits, since create or replace wholesale replaces the function.
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
  this_winner_id uuid;
  p1_recent_opps uuid[];
  p1_recent_winners uuid[];
  p2_recent_opps uuid[];
  is_halved boolean := false;
  p1_won boolean;
  p2_won boolean;
begin
  if new.mode <> 'ranked' or new.player1_id is null or new.player2_id is null then
    return new;
  end if;

  select elo_rating into p1_elo from public.profiles where id = new.player1_id;
  select elo_rating into p2_elo from public.profiles where id = new.player2_id;

  expected_p1 := 1.0 / (1.0 + power(10, (p2_elo - p1_elo) / 400.0));
  actual_p1 := case when new.winner = 2 then 0 else 1 end;

  delta_p1 := round(k * (actual_p1 - expected_p1));

  this_winner_id := case when new.winner = 1 then new.player1_id when new.winner = 2 then new.player2_id else new.player1_id end;

  select array_agg(opp_id order by ended_at desc), array_agg(winner_id order by ended_at desc)
  into p1_recent_opps, p1_recent_winners
  from (
    select
      case when player1_id = new.player1_id then player2_id else player1_id end as opp_id,
      case when winner = 1 then player1_id when winner = 2 then player2_id else player1_id end as winner_id,
      ended_at
    from public.games
    where mode = 'ranked' and id <> new.id
      and (player1_id = new.player1_id or player2_id = new.player1_id)
    order by ended_at desc
    limit 2
  ) sub;

  select array_agg(opp_id order by ended_at desc)
  into p2_recent_opps
  from (
    select
      case when player1_id = new.player2_id then player2_id else player1_id end as opp_id,
      ended_at
    from public.games
    where mode = 'ranked' and id <> new.id
      and (player1_id = new.player2_id or player2_id = new.player2_id)
    order by ended_at desc
    limit 2
  ) sub;

  if array_length(p1_recent_opps, 1) = 2 and array_length(p2_recent_opps, 1) = 2
     and p1_recent_opps[1] = new.player2_id and p1_recent_opps[2] = new.player2_id
     and p2_recent_opps[1] = new.player1_id and p2_recent_opps[2] = new.player1_id
     and p1_recent_winners[1] = this_winner_id and p1_recent_winners[2] = this_winner_id then
    is_halved := true;
    delta_p1 := round(delta_p1 / 2.0);
  end if;

  delta_p2 := -delta_p1;

  p1_won := (new.winner = 1 or new.winner is null);
  p2_won := (new.winner = 2);

  update public.profiles
  set elo_rating = elo_rating + delta_p1,
      highest_elo = greatest(highest_elo, elo_rating + delta_p1),
      ranked_games_played = ranked_games_played + 1,
      ranked_wins = ranked_wins + case when p1_won then 1 else 0 end,
      ranked_losses = ranked_losses + case when p2_won then 1 else 0 end,
      ranked_win_streak = case when p1_won then ranked_win_streak + 1 else 0 end,
      highest_ranked_win_streak = case
        when p1_won then greatest(highest_ranked_win_streak, ranked_win_streak + 1)
        else highest_ranked_win_streak
      end
  where id = new.player1_id;

  update public.profiles
  set elo_rating = elo_rating + delta_p2,
      highest_elo = greatest(highest_elo, elo_rating + delta_p2),
      ranked_games_played = ranked_games_played + 1,
      ranked_wins = ranked_wins + case when p2_won then 1 else 0 end,
      ranked_losses = ranked_losses + case when p1_won then 1 else 0 end,
      ranked_win_streak = case when p2_won then ranked_win_streak + 1 else 0 end,
      highest_ranked_win_streak = case
        when p2_won then greatest(highest_ranked_win_streak, ranked_win_streak + 1)
        else highest_ranked_win_streak
      end
  where id = new.player2_id;

  update public.games set elo_delta_p1 = delta_p1, elo_delta_p2 = delta_p2, elo_halved = is_halved where id = new.id;

  return new;
end;
$$;

-- ---------- Phase 38: exclude forfeited games from pvp points for/against ----------

-- score1/score2 on a forfeited game were never the real deciding factor
-- (see the games_score_plausible_check/forfeit comments earlier in this
-- file, and profile.js's own "W - FF" display logic) - summing them into
-- pvp_points_for/against produced the "unrealistic numbers" players were
-- seeing, since a forfeit's score1/score2 is just whatever the board
-- happened to look like at the moment someone quit or timed out, not a
-- completed game's actual territory split. New pvp_scored_games tracks how
-- many pvp games actually contributed a real score, so profile.js can
-- average over the right denominator instead of diluting against every
-- pvp game including forfeits.
alter table public.profiles add column if not exists pvp_scored_games integer not null default 0;

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
        pvp_scored_games = pvp_scored_games + case when new.player2_id is not null and not new.forfeit then 1 else 0 end,
        pvp_points_for = pvp_points_for + case when new.player2_id is not null and not new.forfeit then new.score1 else 0 end,
        pvp_points_against = pvp_points_against + case when new.player2_id is not null and not new.forfeit then new.score2 else 0 end,
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
        pvp_losses = pvp_losses + case when new.winner = 1 or new.winner is null then 1 else 0 end,
        pvp_scored_games = pvp_scored_games + case when not new.forfeit then 1 else 0 end,
        pvp_points_for = pvp_points_for + case when not new.forfeit then new.score2 else 0 end,
        pvp_points_against = pvp_points_against + case when not new.forfeit then new.score1 else 0 end
    where id = new.player2_id;
  end if;

  return new;
end;
$$;

-- Backfill, safe to re-run: recomputes from source, excluding forfeits.
update public.profiles p
set pvp_points_for = coalesce(pf.points_for, 0),
    pvp_points_against = coalesce(pf.points_against, 0),
    pvp_scored_games = coalesce(pf.scored_games, 0)
from (
  select player_id,
         sum(my_score) as points_for,
         sum(opp_score) as points_against,
         count(*) as scored_games
  from (
    select player1_id as player_id, score1 as my_score, score2 as opp_score
    from public.games where player1_id is not null and player2_id is not null and not forfeit
    union all
    select player2_id as player_id, score2 as my_score, score1 as opp_score
    from public.games where player2_id is not null and not forfeit
  ) per_player
  group by player_id
) pf
where p.id = pf.player_id;

-- Anyone with ZERO non-forfeit pvp games (all their pvp history is
-- forfeits, or they have none) never appears in the subquery above, so the
-- update above never touches them - explicitly zero them out here instead
-- of leaving whatever stale pre-fix totals Phase 32 had already written.
update public.profiles
set pvp_points_for = 0, pvp_points_against = 0, pvp_scored_games = 0
where id not in (
  select player1_id from public.games where player1_id is not null and player2_id is not null and not forfeit
  union
  select player2_id from public.games where player2_id is not null and not forfeit
);

-- ---------- Phase 39: lifetime coins earned tracking + admin monitor page ----------

-- coins is a live balance that goes back down on every purchase, so it
-- can't answer "how many coins has this account ever taken in" on its own -
-- exactly the same problem highest_elo (Phase 37) solved for ELO. This is
-- the same idea applied to coins: a counter that only ever goes up,
-- incremented alongside every single coin GRANT (never on a spend). Only 3
-- call sites ever add to coins - claim_daily_checkin(), grant_coin_purchase(),
-- and the mino coin-gift branch of handle_human_game_played() - all three
-- are redefined below to keep this in lockstep. Backfilled to the current
-- coins balance as a floor: this necessarily undercounts anyone who has
-- ever spent coins before today (that spending history isn't logged
-- anywhere to reconstruct from, unlike ELO's per-game delta trail), but
-- every coin earned from this point forward is counted exactly.
alter table public.profiles add column if not exists lifetime_coins_earned integer not null default 0;
update public.profiles set lifetime_coins_earned = coins where lifetime_coins_earned < coins;

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
  set coins = coins + 1, lifetime_coins_earned = lifetime_coins_earned + 1, last_checkin_at = now()
  where id = uid
  returning coins into new_coins;

  return new_coins;
end;
$$;

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
    update public.profiles set coins = coins + p_coins, lifetime_coins_earned = lifetime_coins_earned + p_coins where id = p_user_id;
  end if;
end;
$$;

-- Full body carried forward from Phase 34 (the last redefinition), plus
-- lifetime_coins_earned tracking on the one branch that grants coins.
create or replace function public.handle_human_game_played()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  p_id uuid;
  m record;
  gift_item record;
  coins_granted integer;
  wants_title boolean;
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
    where user_id = p_id and planted and stage <> 'adult' and growth_progress >= 10;

    if random() < 0.1 then
      update public.profiles
      set unopened_seed_packs = unopened_seed_packs + 1,
          pending_pack_notifications = pending_pack_notifications + 1
      where id = p_id;
    end if;

    for m in
      select * from public.minos
      where user_id = p_id and planted and stage = 'adult'
    loop
      if (m.last_gift_at is null or now() - m.last_gift_at >= interval '7 days') and random() < 0.02 then
        wants_title := random() < 0.25;
        select * into gift_item from public.shop_items
        where mino_giftable and type = case when wants_title then 'title' else 'avatar' end
          and id not in (select item_id from public.user_inventory where user_id = p_id)
        order by random()
        limit 1;

        if gift_item.id is null then
          -- Preferred type had nothing left to give - fall back to
          -- whichever giftable type actually has an unowned item.
          select * into gift_item from public.shop_items
          where mino_giftable
            and id not in (select item_id from public.user_inventory where user_id = p_id)
          order by random()
          limit 1;
        end if;

        if gift_item.id is not null then
          insert into public.user_inventory (user_id, item_id) values (p_id, gift_item.id);
          insert into public.mino_gifts (user_id, mino_id, gift_type, item_id) values (p_id, m.id, 'item', gift_item.id);
          update public.minos set last_gift_at = now() where id = m.id;
        end if;
      end if;

      if random() < m.coin_drop_rate / 100.0 then
        coins_granted := 5 + floor(random() * 11)::integer;
        update public.profiles
        set coins = coins + coins_granted, lifetime_coins_earned = lifetime_coins_earned + coins_granted
        where id = p_id;
        insert into public.mino_gifts (user_id, mino_id, gift_type, coins_amount) values (p_id, m.id, 'coins', coins_granted);
      end if;
    end loop;
  end loop;

  return new;
end;
$$;

-- A single security-definer RPC, gated on the caller's own username being
-- 'AVNJ' (checked server-side, inside the function - never trust a hidden
-- nav link alone for this). Several of the tables joined here
-- (coin_purchases, mino_gifts) are deliberately NOT publicly readable
-- (their own RLS policies only allow auth.uid() = user_id), so this is the
-- only way - short of AVNJ's own account - to see these aggregates across
-- every account; a plain client-side query from any other account would be
-- rejected by RLS on those two tables even if it somehow reached this far.
create or replace function public.admin_get_monitor_data()
returns table (
  id uuid,
  username text,
  coins integer,
  lifetime_coins_earned integer,
  coins_purchased bigint,
  coins_from_minos bigint,
  items_owned bigint,
  minos_owned bigint,
  unopened_seed_packs integer,
  garden_pot_count integer,
  elo_rating integer,
  highest_elo integer,
  games_played integer,
  pvp_games_played integer,
  ranked_games_played integer,
  ranked_win_streak integer,
  highest_ranked_win_streak integer,
  created_at timestamptz,
  last_seen timestamptz
)
language plpgsql
security definer set search_path = public
as $$
declare
  caller_username text;
begin
  -- Must be qualified (p.username, not bare username) - this function's own
  -- `returns table (..., username text, ...)` implicitly declares a
  -- same-named OUT parameter in scope here, so a bare "username" is
  -- ambiguous between that and profiles.username.
  select p.username into caller_username from public.profiles p where p.id = auth.uid();
  if caller_username is distinct from 'AVNJ' then
    raise exception 'Not authorized';
  end if;

  return query
  select
    p.id,
    p.username,
    p.coins,
    p.lifetime_coins_earned,
    coalesce(cp.total, 0) as coins_purchased,
    coalesce(mg.total, 0) as coins_from_minos,
    coalesce(inv.cnt, 0) as items_owned,
    coalesce(mn.cnt, 0) as minos_owned,
    p.unopened_seed_packs,
    p.garden_pot_count,
    p.elo_rating,
    p.highest_elo,
    p.games_played,
    p.pvp_games_played,
    p.ranked_games_played,
    p.ranked_win_streak,
    p.highest_ranked_win_streak,
    p.created_at,
    p.last_seen
  from public.profiles p
  left join (
    select user_id, sum(coins_granted) as total from public.coin_purchases group by user_id
  ) cp on cp.user_id = p.id
  left join (
    select user_id, sum(coins_amount) as total from public.mino_gifts where gift_type = 'coins' group by user_id
  ) mg on mg.user_id = p.id
  left join (
    select user_id, count(*) as cnt from public.user_inventory group by user_id
  ) inv on inv.user_id = p.id
  left join (
    select user_id, count(*) as cnt from public.minos group by user_id
  ) mn on mn.user_id = p.id
  order by p.lifetime_coins_earned desc;
end;
$$;

-- ---------- Phase 40: singleplayer "Blind Eogonim" mode (memory variant of Eogonim) ----------

-- Deliberately NOT adding/re-adding singleplayer_runs_mode_check or
-- singleplayer_runs_mode_fields_check here - this phase used to re-add both
-- with a 4-value mode list (missing 'exactmatch'), which on a full re-run
-- of this file re-narrowed both constraints right back down, rejecting any
-- real 'exactmatch' row a player had already saved before Phase 41 below's
-- wider version ever got a chance to run. Same recurring bug class as
-- get_p1_p2_win_rates()/buy_seed_pack()/Phase 33's singleplayer_runs_mode_
-- check earlier in this file - whichever phase touches this constraint
-- LAST owns it (Phase 41 today); do not add a narrower version of either
-- constraint here again.
--
-- Blind Eogonim reuses the existing "score" column exactly like Eogonim
-- does (a captured-square count, lower is better) - it's the same scoring
-- rule, just played with pieces hidden after placement, so no new column
-- is needed, only a new allowed mode value (added by Phase 41 below).

-- A separate RPC rather than reusing submit_singleplayer_score() - that one
-- is hardcoded to mode = 'eogonim', and Blind Eogonim keeps its own
-- leaderboard row per user (singleplayer_runs_user_id_mode_key is a unique
-- constraint on (user_id, mode), so a second mode value for the same user
-- is a separate row, not a conflict). Same "server decides if it's actually
-- an improvement" discipline as every other submit_*() function here.
create or replace function public.submit_blindeogonim_score(p_score integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_score integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_score is null or p_score < 0 then
    raise exception 'Invalid score';
  end if;

  select score into existing_score from public.singleplayer_runs where user_id = uid and mode = 'blindeogonim' for update;

  if existing_score is null then
    insert into public.singleplayer_runs (user_id, mode, score) values (uid, 'blindeogonim', p_score);
    return p_score;
  elsif p_score < existing_score then
    update public.singleplayer_runs set score = p_score, completed_at = now() where user_id = uid and mode = 'blindeogonim';
    return p_score;
  else
    return existing_score;
  end if;
end;
$$;

-- ---------- Phase 41: singleplayer "Exact Match" mode (precision variant of Eogonim) ----------

-- This phase originally also dropped-then-re-added both constraints here,
-- widened to include 'exactmatch' (on top of the 4 values that existed at
-- the time). That's the same landmine pattern later found and fixed in
-- Phase 42's comment: since this whole file re-runs top-to-bottom on every
-- "safe to re-run in full" execution, and later phases (48, 49) keep
-- widening this same constraint further as new modes ship, a re-run
-- against a live database that already has real 'blight'/'godbot'/'curse'
-- rows would hit THIS 5-value version first (it runs earlier in the file
-- than any of those) and fail outright - exactly the error this was
-- rewritten to stop causing. Exact Match itself was removed two phases
-- later (Phase 42) anyway, so re-adding it to the constraint here only to
-- have Phase 42 immediately narrow it back out was already pointless work;
-- the constraint is correctly left owned by whichever phase touches it
-- LAST (Phase 49 today).

-- Same "server decides if it's actually an improvement" discipline as
-- submit_ascension_score(), and the same higher-is-better comparison
-- direction (rounds cleared) - kept as its own RPC/leaderboard row rather
-- than reusing submit_ascension_score(), same reasoning as every other
-- mode-specific submit_*() function in this file.
create or replace function public.submit_exactmatch_score(p_round integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_round integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_round is null or p_round < 0 then
    raise exception 'Invalid round';
  end if;

  select score into existing_round from public.singleplayer_runs where user_id = uid and mode = 'exactmatch' for update;

  if existing_round is null then
    insert into public.singleplayer_runs (user_id, mode, score) values (uid, 'exactmatch', p_round);
    return p_round;
  elsif p_round > existing_round then
    update public.singleplayer_runs set score = p_round, completed_at = now() where user_id = uid and mode = 'exactmatch';
    return p_round;
  else
    return existing_round;
  end if;
end;
$$;

-- ---------- Phase 42: remove singleplayer "Exact Match" mode ----------

-- Exact Match didn't hold up as a gamemode in practice and is being pulled
-- entirely, client and server both. Any saved Exact Match leaderboard rows
-- are deleted here (there's nothing else meaningful to do with them - the
-- client no longer has any UI to display or submit to that mode), and
-- submit_exactmatch_score() is dropped since nothing calls it anymore.
delete from public.singleplayer_runs where mode = 'exactmatch';
drop function if exists public.submit_exactmatch_score(integer);

-- Originally this phase also dropped-then-re-added both constraints here,
-- narrowed back down to exclude 'exactmatch'. That was safe on the day it
-- was written (nothing later in the file had added a mode past
-- 'ascension' yet), but it silently became a landmine the moment Phase 48
-- appended 'blight' further down this same file: since the WHOLE script
-- re-runs top-to-bottom every time (this file's whole "safe to re-run in
-- full" premise), a second run against a database that already has real
-- 'blight' rows would hit THIS narrow 4-value constraint first - before
-- ever reaching Phase 48/49's wider ones further down - and fail outright
-- ("check constraint ... is violated by some row"), exactly the
-- get_p1_p2_win_rates()/buy_seed_pack() bug class this file's other
-- comments warn about, just realized here for real. The delete above
-- already fully accomplishes this phase's actual goal (no 'exactmatch'
-- row can ever exist again); the constraint itself is correctly left
-- owned by whichever phase touches it LAST (Phase 49 today) rather than
-- being redefined here too.

-- ---------- Phase 43: fold Q_Z/Q_J into Q_S/Q_L on the Stats page's "Win Rate by First Piece" chart ----------

-- Q_Z is Q_S mirrored, and Q_J is Q_L mirrored - the exact same physical
-- tetromino under a second name, not a distinct piece (see the matching
-- TETROMINO_NAMES comment in game.js/singleplayer.js: since a piece can
-- already be flipped in play, dealing both names separately just doubled
-- one physical tetromino's odds - TETROMINO_NAMES has excluded Q_Z/Q_J
-- from hand-dealing for a while now). Any move_log row from before that
-- exclusion existed can still have 'Q_Z' or 'Q_J' recorded as its
-- shapeName, which get_first_piece_win_rates() was grouping as their own
-- separate bars on the Stats page - splitting one physical piece's win
-- rate across two rows instead of combining it into one. Folds both into
-- their canonical name before grouping - this only changes how that chart
-- reports historical results, the underlying games rows/move_log are
-- untouched.
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
      case elem.value->>'shapeName'
        when 'Q_Z' then 'Q_S'
        when 'Q_J' then 'Q_L'
        else elem.value->>'shapeName'
      end as shape_name,
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

-- ---------- Phase 44: Stats page graphs - average score over time, time held rank 1 ----------

-- Same population/filter as get_score_averages() (decided pvp games only),
-- just bucketed to one row per calendar day instead of one overall
-- average - one data point per day that actually had a decided pvp game,
-- not a flat calendar (a day with zero games just doesn't appear, rather
-- than showing up as a zero/gap).
create or replace function public.get_score_averages_by_day()
returns table (
  day date,
  avg_winner_score numeric,
  avg_loser_score numeric,
  sample_size bigint
)
language sql
stable
as $$
  select
    date_trunc('day', ended_at)::date as day,
    round(avg(case when winner = 1 then score1 else score2 end), 2) as avg_winner_score,
    round(avg(case when winner = 1 then score2 else score1 end), 2) as avg_loser_score,
    count(*) as sample_size
  from public.games
  where player2_id is not null and winner is not null
  group by date_trunc('day', ended_at)
  order by day;
$$;

-- Reconstructs how long each player has actually HELD the #1 ELO spot
-- across the site's whole ranked history, in real elapsed time - not just
-- who's #1 right now. Only players who've played at least one ranked game
-- are considered (everyone else sits at the untouched 1200 default, which
-- isn't a meaningful "rank" to compete over). Approach:
--   1. elo_after_game: same running-sum reconstruction as highest_elo's
--      Phase 37 backfill, but keeping every intermediate value (not just
--      the peak) - this player's ELO immediately after each of their
--      ranked games.
--   2. current_elo_at_event: at every timestamp where ANY ranked game
--      finished, look up each player's most recently known ELO at or
--      before that moment (last observation carried forward) via a
--      LATERAL "asof" lookup - this is the classic way to emulate an
--      as-of join in Postgres, which has no native one.
--   3. leader_at_event: whoever has the highest current_elo at each event
--      timestamp is the #1 player starting from that instant, until the
--      next event (or now(), for the most recent one).
--   4. Sum each player's total elapsed time across every period they held
--      that spot.
-- Step 2 is an O(events x players) cross join - completely fine at this
-- site's current scale (at most a few thousand ranked games), but would
-- need a smarter incremental approach or a periodically-refreshed
-- materialized view if the player base grows substantially.
create or replace function public.get_rank1_time_leaders()
returns table (
  player_id uuid,
  username text,
  hours_as_rank1 numeric
)
language sql
stable
as $$
  with p_deltas as (
    select player1_id as player_id, elo_delta_p1 as delta, ended_at, id as game_id
    from public.games
    where mode = 'ranked' and player1_id is not null and elo_delta_p1 is not null
    union all
    select player2_id as player_id, elo_delta_p2 as delta, ended_at, id as game_id
    from public.games
    where mode = 'ranked' and player2_id is not null and elo_delta_p2 is not null
  ),
  elo_after_game as (
    select
      player_id,
      game_id,
      ended_at,
      1200 + sum(delta) over (
        partition by player_id order by ended_at, game_id
        rows between unbounded preceding and current row
      ) as elo_after
    from p_deltas
  ),
  event_times as (
    select distinct ended_at from elo_after_game
  ),
  distinct_players as (
    select distinct player_id from elo_after_game
  ),
  current_elo_at_event as (
    select et.ended_at, dp.player_id, asof.elo_after
    from event_times et
    cross join distinct_players dp
    left join lateral (
      select eag.elo_after
      from elo_after_game eag
      where eag.player_id = dp.player_id and eag.ended_at <= et.ended_at
      order by eag.ended_at desc, eag.game_id desc
      limit 1
    ) asof on true
    where asof.elo_after is not null
  ),
  leader_at_event as (
    select
      ended_at,
      player_id,
      row_number() over (partition by ended_at order by elo_after desc, player_id) as rn
    from current_elo_at_event
  ),
  leader_periods as (
    select
      player_id,
      ended_at as period_start,
      coalesce(lead(ended_at) over (order by ended_at), now()) as period_end
    from leader_at_event
    where rn = 1
  )
  select
    lp.player_id,
    p.username,
    round(sum(extract(epoch from (lp.period_end - lp.period_start))) / 3600.0, 1) as hours_as_rank1
  from leader_periods lp
  join public.profiles p on p.id = lp.player_id
  group by lp.player_id, p.username
  order by hours_as_rank1 desc
  limit 10;
$$;

-- ---------- Phase 45: Stats page graphs - ELO distribution histogram, singleplayer record progression ----------

-- Buckets every ranked-active player's CURRENT elo_rating into ~100-point
-- bands (1000, 1100, 1200, ...). Only players with at least one ranked
-- game count - everyone else sits at the untouched 1200 default, which
-- would otherwise dominate the 1200 bucket with players who've never
-- actually competed, making the "distribution" mostly meaningless.
create or replace function public.get_elo_distribution()
returns table (
  bucket_start integer,
  player_count bigint
)
language sql
stable
as $$
  select
    (floor(elo_rating / 100.0) * 100)::integer as bucket_start,
    count(*) as player_count
  from public.profiles
  where ranked_games_played > 0
  group by bucket_start
  order by bucket_start;
$$;

-- Reconstructs the singleplayer world-record progression for every mode
-- (lowest time/score for Speedrun/Eogonim/Blind Eogonim, highest round
-- count for Ascension) from the CURRENT rows in singleplayer_runs.
--
-- IMPORTANT caveat, documented here since there's no way to fully solve
-- it with the data actually available: singleplayer_runs only ever keeps
-- each player's latest personal best (submit_*_score()/submit_singleplayer
-- _time() overwrite the row in place, per-mode) - it was never designed
-- as an append-only history log, so a player's OWN earlier, later-beaten
-- score is gone the moment they improve on it. This reconstruction takes
-- every player's current best per mode, orders by completed_at, and walks
-- a running min (or running max for Ascension) to find genuine "this beat
-- everything before it" moments - that's still an honest, monotonic
-- record timeline, it just may UNDER-count some historical record changes
-- (never overstate one) if a player broke the record more than once
-- themselves, since only their final value survives in the table.
create or replace function public.get_record_progression()
returns table (
  mode text,
  achieved_at timestamptz,
  value numeric
)
language sql
stable
as $$
  with runs as (
    select
      mode,
      completed_at,
      case when mode = 'speedrun' then time_ms::numeric else score::numeric end as raw_value
    from public.singleplayer_runs
  ),
  running as (
    select
      mode,
      completed_at,
      case
        when mode = 'ascension' then max(raw_value) over (partition by mode order by completed_at rows between unbounded preceding and current row)
        else min(raw_value) over (partition by mode order by completed_at rows between unbounded preceding and current row)
      end as running_best
    from runs
  ),
  with_prev as (
    select mode, completed_at, running_best,
      lag(running_best) over (partition by mode order by completed_at) as prev_best
    from running
  )
  -- Only keep the moments the running best actually changed - most rows
  -- would just repeat the same value as an uninformative flat segment.
  select mode, completed_at as achieved_at, running_best as value
  from with_prev
  where prev_best is distinct from running_best
  order by mode, achieved_at;
$$;

-- ---------- Phase 46: case-insensitive unique usernames ----------

-- profiles.username's original "unique not null" (Phase 1) only ever
-- enforced case-SENSITIVE uniqueness, the default for a plain text column
-- - "AVNJ" and "avnj" were never actually the same value as far as the
-- constraint was concerned, so both could be registered as separate
-- accounts. That's a real impersonation risk (usernames are shown
-- everywhere - leaderboard, profiles, replays, in-game - and the admin
-- page's own access check, schema.sql's admin_get_monitor_data(), is
-- itself just an exact-string username comparison), not just a cosmetic
-- annoyance. Drops the old case-sensitive constraint and replaces it with
-- a unique index on lower(username) instead - this enforces case-
-- insensitive uniqueness (a second signup as "avnj" is rejected once
-- "AVNJ" exists) while leaving every existing account's stored username
-- exactly as-cased as it already is; nothing here forces usernames to
-- lowercase or renames anyone.
--
-- If this fails on some already-registered database, it means two
-- existing accounts already differ only by case (e.g. a real "avnj" and a
-- real "AVNJ" both already exist) - that's a genuine naming collision this
-- migration can't safely resolve on its own (which one keeps the name is
-- a judgment call), so it intentionally surfaces as a clear duplicate-key
-- error here instead of silently picking a winner. Rename one of the
-- conflicting accounts' usernames by hand, then re-run this file.
alter table public.profiles drop constraint if exists profiles_username_key;
create unique index if not exists profiles_username_lower_key on public.profiles (lower(username));

-- Redefines handle_new_user() one more time (full body copied forward
-- from Phase 31, same as every other redefinition in this file) to add a
-- friendly rejection message for a case-insensitive duplicate BEFORE
-- hitting the unique index's raw "duplicate key value violates unique
-- constraint" error. This check-then-insert has a narrow race-condition
-- window (two simultaneous signups for the same name could both pass this
-- check before either commits) - the unique index above is what actually
-- guarantees correctness either way, this is purely for a nicer error
-- message in the overwhelmingly common non-race case.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  uname text := new.raw_user_meta_data->>'username';
begin
  if uname is null
     or char_length(uname) < 3
     or char_length(uname) > 20
     or uname !~ '^[A-Za-z0-9_\- ]+$' then
    raise exception 'Username must be 3-20 characters, using only letters, numbers, spaces, underscores, and hyphens.';
  end if;

  if exists (select 1 from public.profiles where lower(username) = lower(uname)) then
    raise exception 'That username is already taken (usernames are not case-sensitive).';
  end if;

  insert into public.profiles (id, username) values (new.id, uname);
  insert into public.user_inventory (user_id, item_id) values (new.id, 'avatar_default');
  insert into public.user_inventory (user_id, item_id) values (new.id, 'title_freshy');
  return new;
end;
$$;

-- ---------- Phase 47: 48-hour rotating "most ranked matches played" leaderboard ----------

-- Singleton row tracking when the CURRENT period started. Nothing else
-- about a finished period needs to survive its rollover - who won and how
-- much they got is captured permanently in coin_award_notifications below.
create table if not exists public.ranked_leaderboard_period (
  id integer primary key default 1,
  started_at timestamptz not null default now(),
  constraint ranked_leaderboard_period_singleton check (id = 1)
);
insert into public.ranked_leaderboard_period (id, started_at)
values (1, now())
on conflict (id) do nothing;

alter table public.ranked_leaderboard_period enable row level security;
drop policy if exists "Ranked leaderboard period is publicly readable" on public.ranked_leaderboard_period;
create policy "Ranked leaderboard period is publicly readable"
  on public.ranked_leaderboard_period for select
  using (true);
-- No insert/update/delete policy - only rollover_ranked_period_if_needed()
-- below (security definer) ever writes here.

-- Each player's count of ranked matches played within the CURRENT period
-- only - wiped (not decremented) on every rollover, so this always reads
-- as "since the period started," never a running lifetime total (that's
-- what profiles.ranked_games_played already is).
create table if not exists public.ranked_period_counts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  games_count integer not null default 0
);

alter table public.ranked_period_counts enable row level security;
drop policy if exists "Ranked period counts are publicly readable" on public.ranked_period_counts;
create policy "Ranked period counts are publicly readable"
  on public.ranked_period_counts for select
  using (true);
-- No insert/update/delete policy - only handle_ranked_game() (increments,
-- redefined below) and rollover_ranked_period_if_needed() (clears) ever
-- write here.

-- Generic "you were awarded coins for X" notification log, same
-- acknowledge-on-dismiss pattern as pending_pack_notifications/mino_gifts.
-- Deliberately not folded into mino_gifts itself - these awards have
-- nothing to do with a specific planted Mino (mino_id would just be null
-- on every row here), and a free-text reason reads oddly crammed into that
-- table's shape.
create table if not exists public.coin_award_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  coins_amount integer not null,
  reason text not null,
  acknowledged boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.coin_award_notifications enable row level security;
drop policy if exists "Users can view their own coin award notifications" on public.coin_award_notifications;
create policy "Users can view their own coin award notifications"
  on public.coin_award_notifications for select
  using (auth.uid() = user_id);
-- No insert/update/delete policy - only rollover_ranked_period_if_needed()
-- (grants) and acknowledge_coin_award_notifications() (marks read) below
-- ever write here.

-- Checks whether the current 48-hour period has elapsed and, if so, awards
-- coins to its top players and starts a fresh period immediately. Ties are
-- handled the same way the tie-aware leaderboard ranking (leaderboard.js/
-- singleplayer.js) treats them: everyone tied for the most matches played
-- gets 2 coins each, and everyone tied for the next-highest DISTINCT count
-- gets 1 coin each (if literally everyone who played is tied for first,
-- there's no "2nd place" tier at all this period - that's fine).
--
-- There's no real cron job available to this schema, so this is called
-- opportunistically from two places instead: handle_ranked_game() (every
-- ranked game finished) and get_ranked_period_leaderboard() (every time
-- anyone views the leaderboard panel on the main page). Between those two,
-- a rollover fires within moments of the 48-hour mark passing on any site
-- with regular traffic. The `for update` row lock on the singleton period
-- row is what keeps two simultaneous callers from double-awarding the same
-- outgoing period.
create or replace function public.rollover_ranked_period_if_needed()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  period_started_at timestamptz;
  top_count integer;
  second_count integer;
begin
  select started_at into period_started_at from public.ranked_leaderboard_period where id = 1 for update;

  if period_started_at is null or now() - period_started_at < interval '48 hours' then
    return;
  end if;

  select max(games_count) into top_count from public.ranked_period_counts where games_count > 0;

  if top_count is not null then
    update public.profiles
    set coins = coins + 2, lifetime_coins_earned = lifetime_coins_earned + 2
    where id in (select user_id from public.ranked_period_counts where games_count = top_count);

    insert into public.coin_award_notifications (user_id, coins_amount, reason)
    select user_id, 2, '48-hour ranked leaderboard'
    from public.ranked_period_counts where games_count = top_count;

    select max(games_count) into second_count
    from public.ranked_period_counts where games_count > 0 and games_count < top_count;

    if second_count is not null then
      update public.profiles
      set coins = coins + 1, lifetime_coins_earned = lifetime_coins_earned + 1
      where id in (select user_id from public.ranked_period_counts where games_count = second_count);

      insert into public.coin_award_notifications (user_id, coins_amount, reason)
      select user_id, 1, '48-hour ranked leaderboard'
      from public.ranked_period_counts where games_count = second_count;
    end if;
  end if;

  delete from public.ranked_period_counts;
  update public.ranked_leaderboard_period set started_at = now() where id = 1;
end;
$$;

-- Redefines handle_ranked_game() one more time (full body copied forward
-- from Phase 37) to also maintain ranked_period_counts: rolls over the
-- period FIRST (so a stale outgoing period never absorbs this game), then
-- credits this just-finished game to both players' current-period counts.
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
  this_winner_id uuid;
  p1_recent_opps uuid[];
  p1_recent_winners uuid[];
  p2_recent_opps uuid[];
  is_halved boolean := false;
  p1_won boolean;
  p2_won boolean;
begin
  if new.mode <> 'ranked' or new.player1_id is null or new.player2_id is null then
    return new;
  end if;

  perform public.rollover_ranked_period_if_needed();

  insert into public.ranked_period_counts (user_id, games_count) values (new.player1_id, 1)
    on conflict (user_id) do update set games_count = public.ranked_period_counts.games_count + 1;
  insert into public.ranked_period_counts (user_id, games_count) values (new.player2_id, 1)
    on conflict (user_id) do update set games_count = public.ranked_period_counts.games_count + 1;

  select elo_rating into p1_elo from public.profiles where id = new.player1_id;
  select elo_rating into p2_elo from public.profiles where id = new.player2_id;

  expected_p1 := 1.0 / (1.0 + power(10, (p2_elo - p1_elo) / 400.0));
  actual_p1 := case when new.winner = 2 then 0 else 1 end;

  delta_p1 := round(k * (actual_p1 - expected_p1));

  this_winner_id := case when new.winner = 1 then new.player1_id when new.winner = 2 then new.player2_id else new.player1_id end;

  select array_agg(opp_id order by ended_at desc), array_agg(winner_id order by ended_at desc)
  into p1_recent_opps, p1_recent_winners
  from (
    select
      case when player1_id = new.player1_id then player2_id else player1_id end as opp_id,
      case when winner = 1 then player1_id when winner = 2 then player2_id else player1_id end as winner_id,
      ended_at
    from public.games
    where mode = 'ranked' and id <> new.id
      and (player1_id = new.player1_id or player2_id = new.player1_id)
    order by ended_at desc
    limit 2
  ) sub;

  select array_agg(opp_id order by ended_at desc)
  into p2_recent_opps
  from (
    select
      case when player1_id = new.player2_id then player2_id else player1_id end as opp_id,
      ended_at
    from public.games
    where mode = 'ranked' and id <> new.id
      and (player1_id = new.player2_id or player2_id = new.player2_id)
    order by ended_at desc
    limit 2
  ) sub;

  if array_length(p1_recent_opps, 1) = 2 and array_length(p2_recent_opps, 1) = 2
     and p1_recent_opps[1] = new.player2_id and p1_recent_opps[2] = new.player2_id
     and p2_recent_opps[1] = new.player1_id and p2_recent_opps[2] = new.player1_id
     and p1_recent_winners[1] = this_winner_id and p1_recent_winners[2] = this_winner_id then
    is_halved := true;
    delta_p1 := round(delta_p1 / 2.0);
  end if;

  delta_p2 := -delta_p1;

  p1_won := (new.winner = 1 or new.winner is null);
  p2_won := (new.winner = 2);

  update public.profiles
  set elo_rating = elo_rating + delta_p1,
      highest_elo = greatest(highest_elo, elo_rating + delta_p1),
      ranked_games_played = ranked_games_played + 1,
      ranked_wins = ranked_wins + case when p1_won then 1 else 0 end,
      ranked_losses = ranked_losses + case when p2_won then 1 else 0 end,
      ranked_win_streak = case when p1_won then ranked_win_streak + 1 else 0 end,
      highest_ranked_win_streak = case
        when p1_won then greatest(highest_ranked_win_streak, ranked_win_streak + 1)
        else highest_ranked_win_streak
      end
  where id = new.player1_id;

  update public.profiles
  set elo_rating = elo_rating + delta_p2,
      highest_elo = greatest(highest_elo, elo_rating + delta_p2),
      ranked_games_played = ranked_games_played + 1,
      ranked_wins = ranked_wins + case when p2_won then 1 else 0 end,
      ranked_losses = ranked_losses + case when p1_won then 1 else 0 end,
      ranked_win_streak = case when p2_won then ranked_win_streak + 1 else 0 end,
      highest_ranked_win_streak = case
        when p2_won then greatest(highest_ranked_win_streak, ranked_win_streak + 1)
        else highest_ranked_win_streak
      end
  where id = new.player2_id;

  update public.games set elo_delta_p1 = delta_p1, elo_delta_p2 = delta_p2, elo_halved = is_halved where id = new.id;

  return new;
end;
$$;

-- Publicly callable: returns the current period's standings (top 3 by
-- matches played - this is a small "at a glance" panel, not a full
-- leaderboard), joined with the display info the client needs to render
-- each row. Rolls over first, so simply viewing this leaderboard is enough
-- to trigger a timely reset even on a day nobody plays ranked.
create or replace function public.get_ranked_period_leaderboard()
returns table (
  user_id uuid,
  username text,
  avatar_id text,
  title_id text,
  games_count integer
)
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.rollover_ranked_period_if_needed();

  return query
    select p.id, p.username, p.avatar_id, p.title_id, c.games_count
    from public.ranked_period_counts c
    join public.profiles p on p.id = c.user_id
    where c.games_count > 0
    order by c.games_count desc
    limit 3;
end;
$$;

create or replace function public.acknowledge_coin_award_notifications()
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
  update public.coin_award_notifications set acknowledged = true where user_id = uid and not acknowledged;
end;
$$;

-- ---------- Phase 48: singleplayer "Blight" mode (encroaching dead squares) ----------

-- This phase originally also dropped-then-re-added both constraints here,
-- widened to include 'blight' (on top of the 4 values that existed at the
-- time). Exactly the landmine pattern described in Phase 41/42's
-- comments, just not caught here until it actually fired: Phase 49 below
-- widens this same constraint again to add 'godbot'/'curse', and since
-- this whole file re-runs top-to-bottom on every "safe to re-run in full"
-- execution, a re-run against a database that already has real
-- 'godbot'/'curse' rows hit THIS 5-value version first (it runs earlier
-- in the file than Phase 49) and failed outright - the exact error this
-- was rewritten to stop causing. The constraint is correctly left owned
-- by whichever phase touches it LAST (Phase 49 today).

-- Blight reuses the existing "score" column exactly like Ascension does (an
-- integer, higher is better) - it's a captured-territory count instead of a
-- round count, but the same shape.

-- Same "server decides if it's actually an improvement" discipline as
-- submit_ascension_score(), and the same higher-is-better comparison
-- direction (more captured territory is better here, the opposite of
-- submit_singleplayer_score()'s Eogonim).
create or replace function public.submit_blight_score(p_score integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_score integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_score is null or p_score < 0 then
    raise exception 'Invalid score';
  end if;

  select score into existing_score from public.singleplayer_runs where user_id = uid and mode = 'blight' for update;

  if existing_score is null then
    insert into public.singleplayer_runs (user_id, mode, score) values (uid, 'blight', p_score);
    return p_score;
  elsif p_score > existing_score then
    update public.singleplayer_runs set score = p_score, completed_at = now() where user_id = uid and mode = 'blight';
    return p_score;
  else
    return existing_score;
  end if;
end;
$$;

-- Redefines get_record_progression() (Phase 45) one more time - blight is
-- the second mode (after ascension) where a higher score is the record,
-- not a lower one; the body is otherwise identical.
create or replace function public.get_record_progression()
returns table (
  mode text,
  achieved_at timestamptz,
  value numeric
)
language sql
stable
as $$
  with runs as (
    select
      mode,
      completed_at,
      case when mode = 'speedrun' then time_ms::numeric else score::numeric end as raw_value
    from public.singleplayer_runs
  ),
  running as (
    select
      mode,
      completed_at,
      case
        when mode in ('ascension', 'blight') then max(raw_value) over (partition by mode order by completed_at rows between unbounded preceding and current row)
        else min(raw_value) over (partition by mode order by completed_at rows between unbounded preceding and current row)
      end as running_best
    from runs
  ),
  with_prev as (
    select mode, completed_at, running_best,
      lag(running_best) over (partition by mode order by completed_at) as prev_best
    from running
  )
  select mode, completed_at as achieved_at, running_best as value
  from with_prev
  where prev_best is distinct from running_best
  order by mode, achieved_at;
$$;

-- ---------- Phase 49: singleplayer "GodBot" and "Curse" modes ----------

-- Same explicit drop-then-add pattern as every earlier mode phase (see
-- Phase 42's comment for why nothing earlier should ever be edited in place
-- to re-add a narrower version instead of just adding a new phase).
alter table public.singleplayer_runs drop constraint if exists singleplayer_runs_mode_check;
alter table public.singleplayer_runs add constraint singleplayer_runs_mode_check check (mode in ('speedrun', 'eogonim', 'blindeogonim', 'ascension', 'blight', 'godbot', 'curse'));

-- Both new modes reuse the existing "score" column exactly like every mode
-- after Speedrun - godbot's is a real-match territory differential (can be
-- negative), curse's is a count of leftover empty squares.
alter table public.singleplayer_runs drop constraint if exists singleplayer_runs_mode_fields_check;
alter table public.singleplayer_runs add constraint singleplayer_runs_mode_fields_check
  check (
    (mode = 'speedrun' and time_ms is not null and score is null)
    or (mode = 'eogonim' and score is not null and time_ms is null)
    or (mode = 'blindeogonim' and score is not null and time_ms is null)
    or (mode = 'ascension' and score is not null and time_ms is null)
    or (mode = 'blight' and score is not null and time_ms is null)
    or (mode = 'godbot' and score is not null and time_ms is null)
    or (mode = 'curse' and score is not null and time_ms is null)
  );

-- Same "server decides if it's actually an improvement" discipline as
-- submit_blight_score(), and the same higher-is-better comparison
-- direction - but this is the one mode where the score is expected to be
-- negative most of the time (the bot cheats), so the usual "p_score < 0 is
-- invalid" guard every other RPC uses would reject the common case here.
-- Bounded to a generous +/-200 instead - comfortably outside the real
-- 12x12=144-cell range in either direction, just enough to catch an
-- obviously fabricated value.
create or replace function public.submit_godbot_score(p_score integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_score integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_score is null or p_score < -200 or p_score > 200 then
    raise exception 'Invalid score';
  end if;

  select score into existing_score from public.singleplayer_runs where user_id = uid and mode = 'godbot' for update;

  if existing_score is null then
    insert into public.singleplayer_runs (user_id, mode, score) values (uid, 'godbot', p_score);
    return p_score;
  elsif p_score > existing_score then
    update public.singleplayer_runs set score = p_score, completed_at = now() where user_id = uid and mode = 'godbot';
    return p_score;
  else
    return existing_score;
  end if;
end;
$$;

-- Same discipline again, via submit_curse_score() - lower is better, same
-- direction as submit_singleplayer_score()'s Eogonim, bounded 0..100 (a
-- 10x10 board's cell count).
create or replace function public.submit_curse_score(p_score integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_score integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_score is null or p_score < 0 or p_score > 100 then
    raise exception 'Invalid score';
  end if;

  select score into existing_score from public.singleplayer_runs where user_id = uid and mode = 'curse' for update;

  if existing_score is null then
    insert into public.singleplayer_runs (user_id, mode, score) values (uid, 'curse', p_score);
    return p_score;
  elsif p_score < existing_score then
    update public.singleplayer_runs set score = p_score, completed_at = now() where user_id = uid and mode = 'curse';
    return p_score;
  else
    return existing_score;
  end if;
end;
$$;

-- Redefines get_record_progression() (Phase 45, last redefined Phase 48)
-- one more time - godbot joins ascension/blight in the higher-is-better
-- branch; curse falls into the existing lower-is-better default, no change
-- needed there.
create or replace function public.get_record_progression()
returns table (
  mode text,
  achieved_at timestamptz,
  value numeric
)
language sql
stable
as $$
  with runs as (
    select
      mode,
      completed_at,
      case when mode = 'speedrun' then time_ms::numeric else score::numeric end as raw_value
    from public.singleplayer_runs
  ),
  running as (
    select
      mode,
      completed_at,
      case
        when mode in ('ascension', 'blight', 'godbot') then max(raw_value) over (partition by mode order by completed_at rows between unbounded preceding and current row)
        else min(raw_value) over (partition by mode order by completed_at rows between unbounded preceding and current row)
      end as running_best
    from runs
  ),
  with_prev as (
    select mode, completed_at, running_best,
      lag(running_best) over (partition by mode order by completed_at) as prev_best
    from running
  )
  select mode, completed_at as achieved_at, running_best as value
  from with_prev
  where prev_best is distinct from running_best
  order by mode, achieved_at;
$$;

-- ---------- Phase 50: mino coin gifts are exactly 1 coin, not 5-15 ----------

-- A planted adult mino's coin gift was always meant to be a flat 1 coin
-- per successful roll (the coin_drop_rate percentage - 0.1-5% depending on
-- rarity - is the only randomness that's supposed to exist here); the
-- "coins_granted := 5 + floor(random() * 11)::integer" line below was a
-- bug, not a design choice - every successful roll since Phase 16 has been
-- silently handing out 5-15 coins instead of 1. Full body carried forward
-- from Phase 39 (the last redefinition), with just that one line fixed.
create or replace function public.handle_human_game_played()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  p_id uuid;
  m record;
  gift_item record;
  coins_granted integer;
  wants_title boolean;
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
    where user_id = p_id and planted and stage <> 'adult' and growth_progress >= 10;

    if random() < 0.1 then
      update public.profiles
      set unopened_seed_packs = unopened_seed_packs + 1,
          pending_pack_notifications = pending_pack_notifications + 1
      where id = p_id;
    end if;

    for m in
      select * from public.minos
      where user_id = p_id and planted and stage = 'adult'
    loop
      if (m.last_gift_at is null or now() - m.last_gift_at >= interval '7 days') and random() < 0.02 then
        wants_title := random() < 0.25;
        select * into gift_item from public.shop_items
        where mino_giftable and type = case when wants_title then 'title' else 'avatar' end
          and id not in (select item_id from public.user_inventory where user_id = p_id)
        order by random()
        limit 1;

        if gift_item.id is null then
          -- Preferred type had nothing left to give - fall back to
          -- whichever giftable type actually has an unowned item.
          select * into gift_item from public.shop_items
          where mino_giftable
            and id not in (select item_id from public.user_inventory where user_id = p_id)
          order by random()
          limit 1;
        end if;

        if gift_item.id is not null then
          insert into public.user_inventory (user_id, item_id) values (p_id, gift_item.id);
          insert into public.mino_gifts (user_id, mino_id, gift_type, item_id) values (p_id, m.id, 'item', gift_item.id);
          update public.minos set last_gift_at = now() where id = m.id;
        end if;
      end if;

      if random() < m.coin_drop_rate / 100.0 then
        coins_granted := 1;
        update public.profiles
        set coins = coins + coins_granted, lifetime_coins_earned = lifetime_coins_earned + coins_granted
        where id = p_id;
        insert into public.mino_gifts (user_id, mino_id, gift_type, coins_amount) values (p_id, m.id, 'coins', coins_granted);
      end if;
    end loop;
  end loop;

  return new;
end;
$$;

-- ---------- Phase 51: close a real dedup gap that let some games get recorded twice ----------

-- check_game_rate_limit() (Phase 18) exempted an existing row from the
-- 30-second rate limit whenever its client_match_id was "distinct from"
-- the new row's - the idea being that the SAME client_match_id means
-- "both clients independently recording the same real match," which the
-- unique index on client_match_id (Phase 15, "where client_match_id is
-- not null") already handles definitively (whichever insert lands first
-- wins, the other is rejected outright), so the rate limiter didn't need
-- to duplicate that check.
--
-- The gap: recordGameResult() in game.js builds client_match_id as
-- `Net.matchId ? ... : null` - if Net.matchId is ever unset at the exact
-- moment either side records (an edge case, not yet root-caused with
-- certainty, but real and reachable), client_match_id is null instead.
-- A null client_match_id gets ZERO protection from either layer: the
-- unique index explicitly excludes null rows, and "is distinct from"
-- treats two nulls as NOT distinct - so a null-vs-null pair was exempted
-- from the rate limiter too. Two independent recordings of the same
-- match, both landing with a null client_match_id, had no dedup
-- whatsoever - which matches the reported symptom exactly (same match,
-- recorded twice, only the per-move turn timestamps differing since each
-- side's own moveLog was submitted independently).
--
-- Tightens the exemption so it only ever applies to the one case it's
-- actually meant to cover: both values genuinely present AND equal. Any
-- other combination (including null on either side) now falls under the
-- normal rate limit instead of getting a free pass - closing the gap
-- regardless of why Net.matchId went missing, without weakening the
-- legitimate "both sides raced to record the same real game" case at all
-- (that one still resolves via the unique index exactly as before).
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

  p1 := least(new.player1_id, new.player2_id);
  p2 := greatest(new.player1_id, new.player2_id);

  select count(*) into recent_count
  from public.games
  where least(player1_id, player2_id) = p1
    and greatest(player1_id, player2_id) = p2
    and mode in ('casual', 'ranked')
    and ended_at > now() - interval '30 seconds'
    and not (
      client_match_id is not null
      and new.client_match_id is not null
      and client_match_id = new.client_match_id
    );

  if recent_count > 0 then
    raise exception 'Recording games between the same two players too quickly';
  end if;

  return new;
end;
$$;

-- ---------- Phase 52: fix "DELETE requires a WHERE clause" breaking the 48-hour leaderboard rollover ----------

-- Phase 47's rollover_ranked_period_if_needed() had a bare
-- `delete from public.ranked_period_counts;` with no WHERE clause -
-- perfectly valid plain Postgres, but this project's database has the
-- safeupdate extension (or equivalent) enabled, which rejects ANY
-- UPDATE/DELETE without a WHERE clause, even from inside a
-- security definer function. Every single other UPDATE/DELETE in this
-- entire file already has one (checked programmatically) - this was the
-- one exception, and it broke the leaderboard panel for everyone the
-- moment the first 48-hour period actually rolled over, since
-- get_ranked_period_leaderboard() calls this function opportunistically
-- on every view. Full body copied forward from Phase 47, only the one
-- line changed - `where true` is the standard way to tell safeupdate
-- "yes, I really do mean every row" without changing what actually gets
-- deleted.
create or replace function public.rollover_ranked_period_if_needed()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  period_started_at timestamptz;
  top_count integer;
  second_count integer;
begin
  select started_at into period_started_at from public.ranked_leaderboard_period where id = 1 for update;

  if period_started_at is null or now() - period_started_at < interval '48 hours' then
    return;
  end if;

  select max(games_count) into top_count from public.ranked_period_counts where games_count > 0;

  if top_count is not null then
    update public.profiles
    set coins = coins + 2, lifetime_coins_earned = lifetime_coins_earned + 2
    where id in (select user_id from public.ranked_period_counts where games_count = top_count);

    insert into public.coin_award_notifications (user_id, coins_amount, reason)
    select user_id, 2, '48-hour ranked leaderboard'
    from public.ranked_period_counts where games_count = top_count;

    select max(games_count) into second_count
    from public.ranked_period_counts where games_count > 0 and games_count < top_count;

    if second_count is not null then
      update public.profiles
      set coins = coins + 1, lifetime_coins_earned = lifetime_coins_earned + 1
      where id in (select user_id from public.ranked_period_counts where games_count = second_count);

      insert into public.coin_award_notifications (user_id, coins_amount, reason)
      select user_id, 1, '48-hour ranked leaderboard'
      from public.ranked_period_counts where games_count = second_count;
    end if;
  end if;

  delete from public.ranked_period_counts where true;
  update public.ranked_leaderboard_period set started_at = now() where id = 1;
end;
$$;

-- ---------- Phase 53: admin feed of recent minigame personal bests ----------

-- singleplayer_runs only ever stores each (user, mode)'s CURRENT best - a
-- single row, continuously overwritten in place (see every submit_*_score/
-- submit_singleplayer_time() function). There was never a record of WHEN
-- each individual player's own past PBs happened, only what today's best
-- currently is - get_record_progression() (Phase 45/48) LOOKS similar but
-- computes something different (the GLOBAL best across every player
-- combined, for the Stats page's record-over-time chart), not "this one
-- player just improved their own score." This table is a plain append-only
-- log of exactly that, for the admin page's own "who's actively grinding
-- minigames right now" feed - never trimmed/updated, only ever inserted
-- into by the submit_* functions below.
create table if not exists public.personal_best_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null,
  value numeric not null,
  achieved_at timestamptz not null default now()
);

-- RLS enabled with NO policies at all - same "not publicly readable"
-- treatment as coin_purchases/mino_gifts (see admin_get_monitor_data()'s
-- own comment). Every insert below runs from inside a security definer
-- function (bypasses RLS for its own writes), and the only read path is
-- admin_get_recent_personal_bests() further down, also security definer
-- and gated on the caller's own username.
alter table public.personal_best_events enable row level security;

-- Full bodies copied forward from wherever each was last defined
-- (Phase 33/34/36/40/48/49 respectively) - only the one new insert (right
-- alongside the existing "this is actually an improvement" branches, never
-- the "no improvement" else branch) is new in each.

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

  select time_ms into existing_time from public.singleplayer_runs where user_id = uid and mode = 'speedrun' for update;

  if existing_time is null then
    insert into public.singleplayer_runs (user_id, mode, time_ms) values (uid, 'speedrun', p_time_ms);
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'speedrun', p_time_ms);
    return p_time_ms;
  elsif p_time_ms < existing_time then
    update public.singleplayer_runs set time_ms = p_time_ms, completed_at = now() where user_id = uid and mode = 'speedrun';
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'speedrun', p_time_ms);
    return p_time_ms;
  else
    return existing_time;
  end if;
end;
$$;

create or replace function public.submit_singleplayer_score(p_score integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_score integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_score is null or p_score < 0 then
    raise exception 'Invalid score';
  end if;

  select score into existing_score from public.singleplayer_runs where user_id = uid and mode = 'eogonim' for update;

  if existing_score is null then
    insert into public.singleplayer_runs (user_id, mode, score) values (uid, 'eogonim', p_score);
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'eogonim', p_score);
    return p_score;
  elsif p_score < existing_score then
    update public.singleplayer_runs set score = p_score, completed_at = now() where user_id = uid and mode = 'eogonim';
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'eogonim', p_score);
    return p_score;
  else
    return existing_score;
  end if;
end;
$$;

create or replace function public.submit_blindeogonim_score(p_score integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_score integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_score is null or p_score < 0 then
    raise exception 'Invalid score';
  end if;

  select score into existing_score from public.singleplayer_runs where user_id = uid and mode = 'blindeogonim' for update;

  if existing_score is null then
    insert into public.singleplayer_runs (user_id, mode, score) values (uid, 'blindeogonim', p_score);
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'blindeogonim', p_score);
    return p_score;
  elsif p_score < existing_score then
    update public.singleplayer_runs set score = p_score, completed_at = now() where user_id = uid and mode = 'blindeogonim';
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'blindeogonim', p_score);
    return p_score;
  else
    return existing_score;
  end if;
end;
$$;

create or replace function public.submit_ascension_score(p_round integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_round integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_round is null or p_round < 0 then
    raise exception 'Invalid round';
  end if;

  select score into existing_round from public.singleplayer_runs where user_id = uid and mode = 'ascension' for update;

  if existing_round is null then
    insert into public.singleplayer_runs (user_id, mode, score) values (uid, 'ascension', p_round);
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'ascension', p_round);
    return p_round;
  elsif p_round > existing_round then
    update public.singleplayer_runs set score = p_round, completed_at = now() where user_id = uid and mode = 'ascension';
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'ascension', p_round);
    return p_round;
  else
    return existing_round;
  end if;
end;
$$;

create or replace function public.submit_blight_score(p_score integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_score integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_score is null or p_score < 0 then
    raise exception 'Invalid score';
  end if;

  select score into existing_score from public.singleplayer_runs where user_id = uid and mode = 'blight' for update;

  if existing_score is null then
    insert into public.singleplayer_runs (user_id, mode, score) values (uid, 'blight', p_score);
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'blight', p_score);
    return p_score;
  elsif p_score > existing_score then
    update public.singleplayer_runs set score = p_score, completed_at = now() where user_id = uid and mode = 'blight';
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'blight', p_score);
    return p_score;
  else
    return existing_score;
  end if;
end;
$$;

create or replace function public.submit_godbot_score(p_score integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_score integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_score is null or p_score < -200 or p_score > 200 then
    raise exception 'Invalid score';
  end if;

  select score into existing_score from public.singleplayer_runs where user_id = uid and mode = 'godbot' for update;

  if existing_score is null then
    insert into public.singleplayer_runs (user_id, mode, score) values (uid, 'godbot', p_score);
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'godbot', p_score);
    return p_score;
  elsif p_score > existing_score then
    update public.singleplayer_runs set score = p_score, completed_at = now() where user_id = uid and mode = 'godbot';
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'godbot', p_score);
    return p_score;
  else
    return existing_score;
  end if;
end;
$$;

create or replace function public.submit_curse_score(p_score integer)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  existing_score integer;
begin
  if uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_score is null or p_score < 0 or p_score > 100 then
    raise exception 'Invalid score';
  end if;

  select score into existing_score from public.singleplayer_runs where user_id = uid and mode = 'curse' for update;

  if existing_score is null then
    insert into public.singleplayer_runs (user_id, mode, score) values (uid, 'curse', p_score);
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'curse', p_score);
    return p_score;
  elsif p_score < existing_score then
    update public.singleplayer_runs set score = p_score, completed_at = now() where user_id = uid and mode = 'curse';
    insert into public.personal_best_events (user_id, mode, value) values (uid, 'curse', p_score);
    return p_score;
  else
    return existing_score;
  end if;
end;
$$;

-- Same "gated on the caller's own username, checked server-side inside
-- the function" pattern as admin_get_monitor_data() - see its own comment
-- for why this is never trusted to a hidden nav link alone.
create or replace function public.admin_get_recent_personal_bests()
returns table (
  user_id uuid,
  username text,
  avatar_id text,
  title_id text,
  mode text,
  value numeric,
  achieved_at timestamptz
)
language plpgsql
security definer set search_path = public
as $$
declare
  caller_username text;
begin
  select p.username into caller_username from public.profiles p where p.id = auth.uid();
  if caller_username is distinct from 'AVNJ' then
    raise exception 'Not authorized';
  end if;

  return query
  select p.id, p.username, p.avatar_id, p.title_id, e.mode, e.value, e.achieved_at
  from public.personal_best_events e
  join public.profiles p on p.id = e.user_id
  order by e.achieved_at desc
  limit 20;
end;
$$;

-- ---------- Phase 54: custom board shapes for private rooms ----------
-- Null (the default) means the normal square board - only ever a real
-- value ('plus' | 'x' | 'heart') for a private-room game where the host
-- picked one in the room settings overlay. Just the shape id, never the
-- raw void-cell mask - game.js/replay.js/spectate.js each regenerate the
-- identical mask from their own copy of BOARD_SHAPES given this id plus
-- board_size (already a column), so there's nothing else to store.
alter table public.games add column if not exists board_shape text;

-- ---------- Phase 55: 4-player free-for-all (its own queue/tables, never
-- touches games/profiles.elo_rating/the ranked leaderboard) ----------
-- FFA is deliberately NOT stored as a variation of `games` - a pairwise
-- `winner smallint`/elo_delta_p1/elo_delta_p2 shape and the 1-vs-1 ELO
-- formula don't generalize to a 4-way ranked outcome, and this mode was
-- built to never affect ELO/ranked at all (casual-only, its own simple
-- stats). A join-table shape (one row per seat) rather than
-- player3_id/player4_id/score3/score4 columns, so a tie for 1st/2nd/etc
-- is just "two rows share a rank" instead of needing a whole new column
-- shape to represent.

create table if not exists public.ffa_games (
  id uuid primary key default gen_random_uuid(),
  board_size integer not null,
  initial_hand jsonb,
  move_log jsonb,
  started_at timestamptz not null default now(),
  ended_at timestamptz not null default now(),
  -- True when the host disconnected and never reconnected within its grace
  -- window (this project's chosen simplification over full host-migration
  -- - see net-ffa.js) - the match ends there for everyone. Kept as a real
  -- row (not just discarded) so it can still be viewed via replay, but
  -- ffa_game_players.rank is left null for an abandoned match (see below),
  -- so it never counts toward anyone's games_played/wins.
  abandoned boolean not null default false,
  -- The room code - same "whichever of up to 4 near-simultaneous insert
  -- attempts lands first wins, the rest are harmlessly rejected" dedup as
  -- games.client_match_id (Phase 15).
  client_match_id text unique
);

alter table public.ffa_games enable row level security;

drop policy if exists "FFA games are publicly readable" on public.ffa_games;
create policy "FFA games are publicly readable"
  on public.ffa_games for select
  using (true);

-- No client-facing insert policy - rows only ever get created through
-- submit_ffa_result() below (security definer, validates the caller was
-- actually one of the 4 seats itself), avoiding a 4-way "am I one of the
-- seats" RLS check reimplemented in SQL.

create table if not exists public.ffa_game_players (
  ffa_game_id uuid not null references public.ffa_games(id) on delete cascade,
  seat smallint not null check (seat between 0 and 3),
  player_id uuid not null references public.profiles(id),
  score numeric not null,
  -- Null only for an abandoned match (see ffa_games.abandoned) - standard
  -- competition ranking otherwise (a tie for 1st is rank 1 for both, the
  -- next distinct score is rank 3, not 2).
  rank smallint,
  primary key (ffa_game_id, seat)
);

alter table public.ffa_game_players enable row level security;

drop policy if exists "FFA game players are publicly readable" on public.ffa_game_players;
create policy "FFA game players are publicly readable"
  on public.ffa_game_players for select
  using (true);

alter table public.profiles add column if not exists ffa_games_played integer not null default 0;
-- rank = 1 counts as a win (ties for 1st included) - same "ties count as
-- wins" precedent as pvp_wins (Phase 28).
alter table public.profiles add column if not exists ffa_wins integer not null default 0;

-- Keeps profiles.ffa_games_played/ffa_wins in sync whenever a real (non-
-- abandoned) result is recorded - entirely separate from
-- handle_game_recorded()/the ranked ELO triggers on `games`, neither of
-- which this ever touches.
create or replace function public.handle_ffa_game_recorded()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.rank is null then
    return new; -- an abandoned match's seats don't count toward anything
  end if;
  update public.profiles
  set ffa_games_played = ffa_games_played + 1,
      ffa_wins = ffa_wins + case when new.rank = 1 then 1 else 0 end
  where id = new.player_id;
  return new;
end;
$$;

drop trigger if exists on_ffa_game_player_recorded on public.ffa_game_players;
create trigger on_ffa_game_player_recorded
  after insert on public.ffa_game_players
  for each row execute function public.handle_ffa_game_recorded();

-- Single RPC that inserts the ffa_games row plus all 4 ffa_game_players
-- rows in one transaction - avoids any partial-insert race between up to 4
-- clients each independently attempting to record the same finished match
-- at nearly the same moment (mirrors how recordGameResult() already lets
-- both sides of a 2-player game attempt the `games` insert today, Phase
-- 15). The client_match_id unique constraint makes every call after the
-- first a harmless no-op that just returns the already-recorded game's id.
create or replace function public.submit_ffa_result(
  p_client_match_id text,
  p_board_size integer,
  p_started_at timestamptz,
  p_abandoned boolean,
  p_seats jsonb, -- array of {seat, player_id, score, rank} - rank null for an abandoned match
  p_initial_hand jsonb default null,
  p_move_log jsonb default null
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_game_id uuid;
  v_seat jsonb;
  v_caller_is_seat boolean := false;
begin
  if p_seats is null or jsonb_array_length(p_seats) <> 4 then
    raise exception 'FFA results must include exactly 4 seats';
  end if;

  for v_seat in select * from jsonb_array_elements(p_seats) loop
    if (v_seat->>'player_id')::uuid = auth.uid() then
      v_caller_is_seat := true;
    end if;
  end loop;
  if not v_caller_is_seat then
    raise exception 'Not authorized: caller was not a participant in this match';
  end if;

  insert into public.ffa_games (board_size, initial_hand, move_log, started_at, abandoned, client_match_id)
  values (p_board_size, p_initial_hand, p_move_log, p_started_at, coalesce(p_abandoned, false), p_client_match_id)
  on conflict (client_match_id) do nothing
  returning id into v_game_id;

  if v_game_id is null then
    return (select id from public.ffa_games where client_match_id = p_client_match_id);
  end if;

  for v_seat in select * from jsonb_array_elements(p_seats) loop
    insert into public.ffa_game_players (ffa_game_id, seat, player_id, score, rank)
    values (
      v_game_id,
      (v_seat->>'seat')::smallint,
      (v_seat->>'player_id')::uuid,
      (v_seat->>'score')::numeric,
      (v_seat->>'rank')::smallint -- a JSON null here (abandoned match) casts straight through to SQL NULL
    );
  end loop;

  return v_game_id;
end;
$$;

-- ---------- Phase 56: rare "gradient" Mino color variation ----------
-- A 1-in-50 seed, rolled once at grant time alongside color/rarity/modifier
-- (same chokepoint, grant_random_seed()) and never reachable afterward -
-- dig_up_mino() resets stage/growth_progress only, same as coin_drop_rate
-- and modifier before it. Purely cosmetic (a gradient fill instead of a
-- flat color, see auth-ui.js's minoVisualHtml()) plus a flat +2 percentage
-- points on coin_drop_rate, baked into the stored rate at roll time rather
-- than re-derived on every read.
alter table public.minos add column if not exists gradient boolean not null default false;

create or replace function public.random_mino_gradient()
returns boolean
language sql
as $$
  select random() < 0.02;
$$;

create or replace function public.grant_random_seed(p_user_id uuid, p_seen boolean)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  new_id uuid;
  rolled_rarity text := public.random_mino_rarity();
  rolled_gradient boolean := public.random_mino_gradient();
  rolled_coin_rate numeric := public.random_mino_coin_rate(rolled_rarity);
begin
  if rolled_gradient then
    rolled_coin_rate := rolled_coin_rate + 2;
  end if;

  insert into public.minos (user_id, color, rarity, modifier, seen, coin_drop_rate, gradient)
  values (p_user_id, public.random_mino_color(), rolled_rarity, public.random_mino_modifier(), p_seen, rolled_coin_rate, rolled_gradient)
  returning id into new_id;
  return new_id;
end;
$$;

-- ---------- Phase 57: rare "Opal" Mino color (1/50, coin gifts worth 2) ----------
-- A second, independent 1-in-50 roll alongside gradient (Phase 56) - this
-- one overrides the normal uniform 10-color pick with a fixed rare color
-- instead of altering the existing color's look. The 10 normal colors stay
-- exactly uniform among themselves (each ~9.8% = 0.98/10), Opal takes the
-- remaining 2%. Its only mechanical effect is in handle_human_game_played()
-- below: a successful coin_drop_rate roll grants 2 coins instead of 1.
create or replace function public.grant_random_seed(p_user_id uuid, p_seen boolean)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  new_id uuid;
  rolled_rarity text := public.random_mino_rarity();
  rolled_gradient boolean := public.random_mino_gradient();
  rolled_coin_rate numeric := public.random_mino_coin_rate(rolled_rarity);
  rolled_color text := case when random() < 0.02 then 'Opal' else public.random_mino_color() end;
begin
  if rolled_gradient then
    rolled_coin_rate := rolled_coin_rate + 2;
  end if;

  insert into public.minos (user_id, color, rarity, modifier, seen, coin_drop_rate, gradient)
  values (p_user_id, rolled_color, rolled_rarity, public.random_mino_modifier(), p_seen, rolled_coin_rate, rolled_gradient)
  returning id into new_id;
  return new_id;
end;
$$;

-- Full body carried forward from Phase 50 (the last redefinition), with
-- only the coins_granted line changed to check the mino's color.
create or replace function public.handle_human_game_played()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  p_id uuid;
  m record;
  gift_item record;
  coins_granted integer;
  wants_title boolean;
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
    where user_id = p_id and planted and stage <> 'adult' and growth_progress >= 10;

    if random() < 0.1 then
      update public.profiles
      set unopened_seed_packs = unopened_seed_packs + 1,
          pending_pack_notifications = pending_pack_notifications + 1
      where id = p_id;
    end if;

    for m in
      select * from public.minos
      where user_id = p_id and planted and stage = 'adult'
    loop
      if (m.last_gift_at is null or now() - m.last_gift_at >= interval '7 days') and random() < 0.02 then
        wants_title := random() < 0.25;
        select * into gift_item from public.shop_items
        where mino_giftable and type = case when wants_title then 'title' else 'avatar' end
          and id not in (select item_id from public.user_inventory where user_id = p_id)
        order by random()
        limit 1;

        if gift_item.id is null then
          -- Preferred type had nothing left to give - fall back to
          -- whichever giftable type actually has an unowned item.
          select * into gift_item from public.shop_items
          where mino_giftable
            and id not in (select item_id from public.user_inventory where user_id = p_id)
          order by random()
          limit 1;
        end if;

        if gift_item.id is not null then
          insert into public.user_inventory (user_id, item_id) values (p_id, gift_item.id);
          insert into public.mino_gifts (user_id, mino_id, gift_type, item_id) values (p_id, m.id, 'item', gift_item.id);
          update public.minos set last_gift_at = now() where id = m.id;
        end if;
      end if;

      if random() < m.coin_drop_rate / 100.0 then
        coins_granted := case when m.color = 'Opal' then 2 else 1 end;
        update public.profiles
        set coins = coins + coins_granted, lifetime_coins_earned = lifetime_coins_earned + coins_granted
        where id = p_id;
        insert into public.mino_gifts (user_id, mino_id, gift_type, coins_amount) values (p_id, m.id, 'coins', coins_granted);
      end if;
    end loop;
  end loop;

  return new;
end;
$$;
