-- Minogoe shop catalog. Edit this file to add, change, or remove items,
-- then paste the whole thing into the Supabase SQL editor and run it.
-- Safe to re-run any time - it upserts by id, so tweaking a price or name
-- and re-running just updates the existing row.
--
-- Requires schema.sql's Phase 12 (shop_items table), Phase 13 (color/
-- notice columns), and Phase 14 (hidden column) to have been run first.
--
-- Avatars: drop the image file into assets/avatars/ (see the README there
-- for size/format), then set image_path to "assets/avatars/<filename>".
-- Titles: no image needed, just set title_text to the words shown in-game,
-- and color to any CSS color (e.g. '#d4af37') - each title can be its own
-- color. Leave color null to fall back to the site's default accent color.
-- notice is optional on any item (avatar or title) - a short banner shown
-- on that item's shop card, e.g. for a limited-time item.
--
-- To retire an item so it's no longer sold: remove its row below AND add
-- its id to the "delete" list at the bottom of this file, then run the
-- whole file. Just deleting the row up here is NOT enough - insert/upsert
-- only ever adds or updates rows it's told about, it never removes rows an
-- older run of this file already inserted. Anyone who already owns a
-- retired item keeps it in their inventory, but if they have it equipped,
-- profiles.avatar_id/title_id automatically reverts to null (default look)
-- since the column has an ON DELETE SET NULL foreign key back to this
-- table.

insert into public.shop_items (id, type, name, price, image_path, title_text, color, notice) values
  ('title_GOAT', 'title', 'GOAT', 20, null, 'GOAT', '#d4af37', null),
  ('title_GirlInAisle10', 'title', 'Girl in Aisle 10', 15, null, 'Girl in Aisle 10', '#e07bb5', null),
  ('title_OG', 'title', 'OG', 1, null, 'OG', '#ffffff', 'No longer sold after 8/1/26!'),
  ('title_Strategist', 'title', 'Strategist', 5, null, 'Strategist', '#5b8fd9', null),
  ('title_Minnow', 'title', 'Minnow', 5, null, 'Minnow', '#5b8fd9', null),
  ('title_Springtail', 'title', 'Springtail', 5, null, 'Springtail', '#5b8fd9', null),
  ('title_Leech', 'title', 'Leech', 5, null, 'Leech', '#5b8fd9', null),
  ('title_Genius', 'title', 'Genius', 15, null, 'Genius', '#9b7fd9', null),
  ('title_Gamer', 'title', 'Gamer', 5, null, 'Gamer', '#6fbf73', null),
  ('title_Loaded', 'title', 'Loaded', 30, null, 'Loaded', '#e6c14a', null),
  ('title_Sweaty', 'title', 'Sweaty', 3, null, 'Sweaty', '#4bc4c4', null),
  ('title_LoverAndAFighter', 'title', 'Lover AND a Fighter', 25, null, 'Lover AND a Fighter', '#d95b6a', null),
  ('avatar_red', 'avatar', 'Red', 2, 'assets/avatars/red.png', null, null, null),
  ('avatar_blue', 'avatar', 'Blue', 2, 'assets/avatars/blue.png', null, null, null),
  ('avatar_lilac', 'avatar', 'Lilac', 4, 'assets/avatars/lilac.png', null, null, null),
  ('avatar_lime', 'avatar', 'Lime', 4, 'assets/avatars/lime.png', null, null, null),
  ('avatar_monarch', 'avatar', 'Monarch', 20, 'assets/avatars/monarch.png', null, null, null),
  ('avatar_hot', 'avatar', 'Hot', 20, 'assets/avatars/hot.png', null, null, null),
  ('avatar_positive', 'avatar', 'Positive', 15, 'assets/avatars/positive.png', null, null, null),
  ('avatar_territory', 'avatar', 'Territory', 15, 'assets/avatars/territory.png', null, null, null),
  ('avatar_leech', 'avatar', 'Leech', 15, 'assets/avatars/leech.png', null, null, null),
  ('avatar_minnow', 'avatar', 'Minnow', 15, 'assets/avatars/minnow.png', null, null, null),
  ('avatar_springtail', 'avatar', 'Springtail', 15, 'assets/avatars/springtail.png', null, null, null)
on conflict (id) do update set
  type = excluded.type,
  name = excluded.name,
  price = excluded.price,
  image_path = excluded.image_path,
  title_text = excluded.title_text,
  color = excluded.color,
  notice = excluded.notice;

-- Retired items - ids listed here (and removed from the insert above) are
-- actually removed from the shop. Add ids as you retire things.
delete from public.shop_items where id in (
  'avatar_example',
  'title_champion'
);

-- Restricted items - hidden = true keeps an item out of everyone's shop
-- grid (and, per schema.sql Phase 14, out of purchase_item() too - it
-- can't be bought even via a direct API call). Ownership is instead
-- granted directly below, by username. The recipient still equips it
-- normally from their own shop page - it just won't show up for anyone
-- else, and no one else can buy it.
insert into public.shop_items (id, type, name, price, title_text, color, hidden) values
  ('title_admin', 'title', 'Admin', 0, 'Admin', '#e04545', true)
on conflict (id) do update set
  name = excluded.name,
  title_text = excluded.title_text,
  color = excluded.color,
  hidden = excluded.hidden;

insert into public.user_inventory (user_id, item_id)
select id, 'title_admin' from public.profiles where username = 'AVNJ'
on conflict (user_id, item_id) do nothing;
