// Fetches the shop_items table (avatars/titles catalog) once and caches it,
// so every page that displays a player's avatar/title can look it up
// synchronously instead of each re-querying Supabase. Loaded after auth.js
// (needs supabaseClient), same pattern as presence.js/search.js.
const Catalog = (() => {
  let items = {};
  let loaded = false;

  const readyPromise = (async () => {
    const { data, error } = await supabaseClient.from('shop_items').select('*');
    if (!error && data) {
      for (const row of data) items[row.id] = row;
    }
    loaded = true;
  })();

  function get(id) {
    if (!id) return null;
    return items[id] || null;
  }

  function all() {
    return Object.values(items);
  }

  return {
    ready: () => readyPromise,
    get,
    all,
    get isLoaded() { return loaded; },
  };
})();
