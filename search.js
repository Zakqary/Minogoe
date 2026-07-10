// Player search box in the site nav - typeahead lookup by username, jumps
// straight to that player's profile. Loaded on every page (after
// auth-ui.js, for escapeHtml).
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_RESULT_LIMIT = 6;

(() => {
  const input = document.getElementById('playerSearchInput');
  const resultsEl = document.getElementById('playerSearchResults');
  if (!input || !resultsEl) return;

  let debounceId = null;
  let activeIndex = -1;
  let currentMatches = [];

  function hideResults() {
    resultsEl.classList.remove('visible');
    resultsEl.innerHTML = '';
    activeIndex = -1;
    currentMatches = [];
  }

  function goToProfile(userId) {
    window.location.href = `profile.html?user=${encodeURIComponent(userId)}`;
  }

  function updateActive(items) {
    items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
  }

  function renderResults(matches) {
    currentMatches = matches;
    activeIndex = -1;
    if (matches.length === 0) {
      resultsEl.innerHTML = '<div class="nav-search-empty">No players found</div>';
      resultsEl.classList.add('visible');
      return;
    }
    resultsEl.innerHTML = matches.map((m, i) =>
      `<div class="nav-search-result" data-index="${i}">${escapeHtml(m.username)}</div>`
    ).join('');
    resultsEl.classList.add('visible');
    for (const el of resultsEl.querySelectorAll('.nav-search-result')) {
      // mousedown (not click) fires before the input's blur handler hides
      // the dropdown, so a click on a result actually registers.
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        goToProfile(matches[Number(el.dataset.index)].id);
      });
    }
  }

  async function runSearch(query) {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('id, username')
      .ilike('username', `%${query}%`)
      .order('username', { ascending: true })
      .limit(SEARCH_RESULT_LIMIT);
    if (error || !data) { hideResults(); return; }
    renderResults(data);
  }

  input.addEventListener('input', () => {
    const query = input.value.trim();
    clearTimeout(debounceId);
    if (!query) { hideResults(); return; }
    debounceId = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideResults();
      input.blur();
      return;
    }

    if (!resultsEl.classList.contains('visible') || currentMatches.length === 0) {
      if (e.key === 'Enter') {
        e.preventDefault();
        const query = input.value.trim();
        if (!query) return;
        clearTimeout(debounceId);
        runSearch(query).then(() => {
          if (currentMatches.length === 1) goToProfile(currentMatches[0].id);
        });
      }
      return;
    }

    const items = resultsEl.querySelectorAll('.nav-search-result');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      updateActive(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      updateActive(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && currentMatches[activeIndex]) {
        goToProfile(currentMatches[activeIndex].id);
      } else if (currentMatches.length === 1) {
        goToProfile(currentMatches[0].id);
      }
    }
  });

  input.addEventListener('blur', () => {
    // Slight delay so a mousedown on a result still registers before the
    // dropdown gets torn down.
    setTimeout(hideResults, 150);
  });
})();
