# Avatar images

Drop profile picture files here, then reference them from
`supabase/shop_items_seed.sql` as `image_path = 'assets/avatars/<filename>'`.

Guidelines:
- Square images, ideally at least 128x128px (they're displayed small, around
  24-40px, but should still look sharp on high-DPI screens).
- PNG, JPG, or SVG all work fine.
- Keep file sizes small (a few KB to a few hundred KB) - these load on every
  page that shows a player's name.

There's no upload feature - avatars can only be added here by editing the
repo and the seed file, then bought in-game with coins. Players who haven't
bought (or aren't wearing) one see a default "?" placeholder instead, so a
missing or not-yet-added image just means nobody can buy that item yet, not
a broken page.
