// Thin wrapper around Supabase Auth + the profiles table. Other scripts
// (auth-ui.js, and later game.js for recording results) talk to this module
// instead of the Supabase client directly.
const SUPABASE_URL = 'https://kokygjmttluthboxckct.supabase.co';
const SUPABASE_KEY = 'sb_publishable_aH7g-hhPpt-1or4nBP6UvA_bZkS13Td';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const Auth = (() => {
  let currentUser = null;
  let currentProfile = null;
  let initialized = false;
  let onChangeCallback = null;

  async function refreshProfile() {
    if (!currentUser) {
      currentProfile = null;
      return;
    }
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', currentUser.id)
      .single();
    currentProfile = error ? null : data;
  }

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user ?? null;
    await refreshProfile();
    initialized = true;
    onChangeCallback && onChangeCallback();
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
    onChangeCallback = cb;
    if (initialized) cb();
  }

  return {
    signUp,
    signIn,
    signOut,
    onAuthChange,
    getUser: () => currentUser,
    getProfile: () => currentProfile,
  };
})();
