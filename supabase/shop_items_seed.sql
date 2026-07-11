-- Minogoe shop catalog. Edit this file to add, change, or remove items,
-- then paste the whole thing into the Supabase SQL editor and run it.
-- Safe to re-run any time - it upserts by id, so tweaking a price or name
-- and re-running just updates the existing row.
--
-- Requires schema.sql's Phase 12 (shop_items table) to have been run first.
--
-- Avatars: drop the image file into assets/avatars/ (see the README there
-- for size/format), then set image_path to "assets/avatars/<filename>".
-- Titles: no image needed, just set title_text to the words shown in-game.
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

insert into public.shop_items (id, type, name, price, image_path, title_text) values
  ('title_champion', 'title', 'Champion', 15, null, 'Champion'),
  ('avatar_red', 'avatar', 'Red', 20, 'assets/avatars/red.png', null)
on conflict (id) do update set
  type = excluded.type,
  name = excluded.name,
  price = excluded.price,
  image_path = excluded.image_path,
  title_text = excluded.title_text;

-- Retired items - ids listed here (and removed from the insert above) are
-- actually removed from the shop. List is empty by default; add ids as you
-- retire things.
delete from public.shop_items where id in (
  'avatar_example'
);
