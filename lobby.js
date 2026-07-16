// Purely cosmetic/interaction glue for the pre-game lobby view (#lobbyView
// in index.html) - none of this touches game state. game.js owns the
// actual lobby<->game-view visibility switch (updateLobbyGameVisibility(),
// called from render()) since that has to react to state.gameStarted;
// everything here is self-contained UI that works the same regardless of
// what game.js is doing.

// ---------- Ambient rotating pentomino/tetromino/tromino background ----------
// Same shape coordinates as game.js/singleplayer.js's BASE_SHAPES (a
// representative subset, not all 19 - this is decorative, not exhaustive).
const LOBBY_SHAPES = {
  P_F: [[0,1],[0,2],[1,0],[1,1],[2,1]],
  P_T: [[0,0],[0,1],[0,2],[1,1],[2,1]],
  P_X: [[0,1],[1,0],[1,1],[1,2],[2,1]],
  P_Y: [[0,1],[1,0],[1,1],[2,1],[3,1]],
  P_W: [[0,0],[1,0],[1,1],[2,1],[2,2]],
  P_N: [[0,1],[1,1],[2,0],[2,1],[3,0]],
  Q_T: [[0,0],[0,1],[0,2],[1,1]],
  Q_S: [[0,1],[0,2],[1,0],[1,1]],
  Q_O: [[0,0],[0,1],[1,0],[1,1]],
  R_L: [[0,0],[1,0],[1,1]],
  R_I: [[0,0],[0,1],[0,2]],
};
const LOBBY_SHAPE_NAMES = Object.keys(LOBBY_SHAPES);
const LOBBY_PIECE_COLORS = ['#5b7fd9', '#d97a52', '#d1974a', '#74ae82'];

const lobbyReduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function initLobbyBackground() {
  const canvas = document.getElementById('pieceCanvas');
  const hero = document.getElementById('lobbyView');
  if (!canvas || !hero) return;
  const pctx = canvas.getContext('2d');
  let sprites = [];

  function sizeCanvas() {
    const w = hero.clientWidth, h = hero.clientHeight;
    canvas.width = Math.round(w * devicePixelRatio);
    canvas.height = Math.round(h * devicePixelRatio);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }

  function makeSprites() {
    const w = hero.clientWidth, h = hero.clientHeight;
    const count = w < 700 ? 8 : 14;
    sprites = [];
    for (let i = 0; i < count; i++) {
      sprites.push({
        shape: LOBBY_SHAPES[LOBBY_SHAPE_NAMES[Math.floor(Math.random() * LOBBY_SHAPE_NAMES.length)]],
        x: Math.random() * w,
        y: Math.random() * h,
        cell: 10 + Math.random() * 10,
        angle: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.15,
        bobPhase: Math.random() * Math.PI * 2,
        bobSpeed: 0.4 + Math.random() * 0.4,
        color: LOBBY_PIECE_COLORS[Math.floor(Math.random() * LOBBY_PIECE_COLORS.length)],
        alpha: 0.08 + Math.random() * 0.1,
      });
    }
  }

  function drawSprite(s, t) {
    const bob = Math.sin(t * s.bobSpeed + s.bobPhase) * 10;
    pctx.save();
    pctx.translate(s.x, s.y + bob);
    pctx.rotate(s.angle + (lobbyReduceMotion ? 0 : t * s.spin));
    pctx.globalAlpha = s.alpha;
    pctx.fillStyle = s.color;
    const cx = Math.max(...s.shape.map((p) => p[1])) / 2;
    const cy = Math.max(...s.shape.map((p) => p[0])) / 2;
    for (const [r, c] of s.shape) {
      pctx.fillRect((c - cx) * s.cell - s.cell / 2, (r - cy) * s.cell - s.cell / 2, s.cell - 1.5, s.cell - 1.5);
    }
    pctx.restore();
  }

  // Resets to the identity transform before clearing, then reapplies a
  // FRESH devicePixelRatio scale for drawing - always, every frame, rather
  // than setting the scale once in sizeCanvas() and assuming it stays
  // correct. Browser zoom (Ctrl -/+) changes devicePixelRatio without
  // necessarily changing canvas.width/height's already-scaled pixel
  // buffer or firing a layout resize - drawing under a now-stale scale
  // while clearing under an even-more-stale one is exactly what left
  // trails of every previous frame's shapes never actually erased, the
  // "continuous exposure" effect. Clearing at identity first guarantees
  // the FULL raw buffer is wiped regardless of whatever scale is active
  // this frame.
  function clearAndScale() {
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.clearRect(0, 0, canvas.width, canvas.height);
    pctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  function drawStatic() {
    clearAndScale();
    for (const s of sprites) drawSprite(s, 0);
  }

  function animate(t) {
    clearAndScale();
    for (const s of sprites) drawSprite(s, t / 1000);
    if (!lobbyReduceMotion) requestAnimationFrame(animate);
  }

  function reinit() {
    sizeCanvas();
    makeSprites();
    if (lobbyReduceMotion) drawStatic();
  }

  // Resizes the canvas buffer to match #lobbyView's current height WITHOUT
  // touching the sprites array - used for content-driven height changes
  // (switching the Play Online/Local Mode tabs, or the panel row's async
  // 48h leaderboard/live games content loading in) where the shapes should
  // just keep drifting from wherever they already were, not jump to a
  // freshly randomized layout. Full reinit() (which does randomize) is
  // reserved for an actual window resize, where a refreshed distribution
  // genuinely makes sense.
  function resizeBufferOnly() {
    sizeCanvas();
    if (lobbyReduceMotion) drawStatic();
  }

  reinit();
  if (!lobbyReduceMotion) requestAnimationFrame(animate);

  window.addEventListener('resize', reinit);
  if (window.ResizeObserver) {
    new ResizeObserver(resizeBufferOnly).observe(hero);
  }

  // Browser zoom changes devicePixelRatio but doesn't reliably fire a
  // window resize event on its own (page layout/clientWidth genuinely
  // doesn't change from a pure zoom, only the CSS-pixel-to-device-pixel
  // ratio does) - matchMedia's resolution query is the standard reliable
  // way to detect that specifically. Re-subscribes after every change,
  // since the query string itself embeds the ratio it's watching for.
  function watchDevicePixelRatio() {
    const mq = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    mq.addEventListener('change', () => { reinit(); watchDevicePixelRatio(); }, { once: true });
  }
  watchDevicePixelRatio();
}

// ---------- Play card tab switching (Play Online / Local Mode) ----------
function initLobbyTabs() {
  const tabs = document.querySelectorAll('.play-tab');
  if (tabs.length === 0) return;
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.play-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector(`.play-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
    });
  });
}

// ---------- In-game collapsed "Queues & Live Games" panel ----------
function initInGameQueuesToggle() {
  const toggleBtn = document.getElementById('inGameQueuesToggle');
  const panel = document.getElementById('inGameQueuesPanel');
  if (!toggleBtn || !panel) return;
  toggleBtn.addEventListener('click', () => panel.classList.toggle('open'));
}

initLobbyBackground();
initLobbyTabs();
initInGameQueuesToggle();
