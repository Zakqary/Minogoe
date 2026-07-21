// Thin wrapper around Supabase Auth + the profiles table. Other scripts
// (auth-ui.js, and later game.js for recording results) talk to this module
// instead of the Supabase client directly.
const SUPABASE_URL = 'https://kokygjmttluthboxckct.supabase.co';
const SUPABASE_KEY = 'sb_publishable_aH7g-hhPpt-1or4nBP6UvA_bZkS13Td';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const Auth = (() => {
  let currentUser = null;
  let currentProfile = null;
  let currentSession = null;
  let initialized = false;
  let onChangeCallbacks = []; // multiple scripts (auth-ui, presence, profile, game) each subscribe

  async function refreshProfile() {
    if (!currentUser) {
      currentProfile = null;
      return;
    }
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*, companion:companion_mino_id(id, color, rarity, modifier, gradient, stage, name)')
      .eq('id', currentUser.id)
      .single();
    currentProfile = error ? null : data;
  }

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    currentSession = session;
    currentUser = session?.user ?? null;
    await refreshProfile();
    initialized = true;
    for (const cb of onChangeCallbacks) cb();
  });

  async function signUp(email, password, username) {
    return supabaseClient.auth.signUp({
      email,
      password,
      options: { data: { username } },
    });
  }

  async function signIn(email, password) {
    return supabaseClient.auth.signInWithPassword({ email, password });
  }

  async function signOut() {
    return supabaseClient.auth.signOut();
  }

  function onAuthChange(cb) {
    onChangeCallbacks.push(cb);
    if (initialized) cb();
  }

  return {
    signUp,
    signIn,
    signOut,
    onAuthChange,
    refreshProfile,
    getUser: () => currentUser,
    getProfile: () => currentProfile,
    getAccessToken: () => currentSession?.access_token ?? null,
    // Pages that render a "sign in" prompt or a "could not load your
    // profile" error based on getUser()/getProfile() need this to tell
    // "auth genuinely hasn't resolved yet" apart from "resolved, and you're
    // signed out" / "resolved, and something's actually wrong" - otherwise
    // they flash the wrong message for the brief window before the very
    // first onAuthStateChange event fires.
    get isInitialized() { return initialized; },
  };
})();
