'use strict';
/*
 * DARKOUT-TPS — pseudo-3D TPS prototype.
 * Reuses DARK OUT (ACTION-GAME) character art; corridor/lighting/enemy
 * distance are procedural (no 3D models, no new AI-generated images).
 * Standalone project — does not read or write ACTION-GAME in any way.
 */

// ---------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------

const DPR_CAP = 2;

// Perspective projection: scale(z) = FOCAL / (FOCAL + z). Smaller FOCAL =
// stronger perspective (things shrink into the distance faster).
const FOCAL = 260;
const HORIZON_Y_RATIO = 0.40; // vanishing point height as a fraction of canvas height

// Corridor world extents (arbitrary world units, tuned by eye).
const CORRIDOR_HALF_WIDTH = 230;
const CORRIDOR_CEIL_Y = -190;
const CORRIDOR_FLOOR_Y = 170;

const Z_NEAR = 40;     // structures are recycled to the far end once they pass this
const Z_FAR = 1900;
const Z_RANGE = Z_FAR - Z_NEAR;

// Player forward/back world-scroll speeds (z units / second).
const WALK_FORWARD_SPEED = 150;
const WALK_BACK_SPEED = 120;
// FOLLOWUP FIX (dash felt like a teleport): both dash distances are now
// fixed TOTAL displacements covered over DASH_DURATION_MS, computed the
// same position-tracked way the strafe dash always was (see fwdDashCovered
// below) — not a velocity impulse multiplied by an arbitrary 3.2 burst
// factor, which is what let the old numbers balloon. ~260 world-z units is
// about one "gantry" structure-spacing — a short, readable hop, not a
// level-skip.
const DASH_FORWARD_DISTANCE_Z = 260;
const DASH_BACK_DISTANCE_Z = 200;
const DASH_DURATION_MS = 220;
const DASH_INVINCIBLE_MS = 260;

// Player screen-space lateral movement (WEST/EAST), in CSS px/sec.
const STRAFE_SPEED = 260;
// FOLLOWUP FIX: was 340px — bigger than STRAFE_MAX_OFFSET's own travel
// range on most phone-width canvases, so a single dash from center could
// already clamp straight to the screen edge (looked like a teleport).
// 100px is "a quick short sidestep", roughly matching a forward/back dash's
// felt distance, never enough on its own to cross the full clamp range.
const STRAFE_DASH_DISTANCE_PX = 100;
const STRAFE_MAX_OFFSET = 0.30; // fraction of canvas width from center

// Enemy virtual distance range (world z-like units).
const ENEMY_Z_MIN = 70;
const ENEMY_Z_MAX = 1500;
// Enemy sprite height expressed in the SAME world-unit space the corridor
// projection uses (see project()), so proj.scale converts it to pixels
// consistently with everything else on screen — NOT the source image's own
// pixel height, which would double up with proj.scale and blow up the size.
const ENEMY_WORLD_HEIGHT = 700;

// Flashlight / aim.
const FLASHLIGHT_BASE_RADIUS = 150;
const FLASHLIGHT_STICK_RANGE = 190; // px the light can be pushed from its anchor
const AIM_RANGE = 190; // px, pre-clamp — UNCHANGED: max reach at full stick
// deflection must stay close to what it already was (see AIM_CURVE_POWER
// below); only small/medium inputs get gentler.
const AIM_MARKER_PAD = 14; // keep the aim reticle a little inside the light edge

// FOLLOWUP FIX (AIM was too twitchy for fine target lock): deadzone is
// intentionally the SAME as MOVE/LIGHT's (never shrunk — a smaller deadzone
// invites stick drift, which the spec explicitly warns against). What
// changes is a response curve applied only to AIM's two axes: output =
// sign(x) * |x|^AIM_CURVE_POWER. At x=1 (full deflection) output is still
// 1 — max reach is preserved — but at x=0.5 output drops to ~0.5^2.2≈0.22,
// so small stick nudges move the reticle far less while big ones stay
// close to today's speed. MOVE and LIGHT are untouched (their own
// deadzone/curve below is the original linear one).
const AIM_DEADZONE = 0.16;
const AIM_CURVE_POWER = 2.2;

const FIRE_COOLDOWN_MS = 130;
const MAG_SIZE = 12;
const RESERVE_MAX = 48;
const RELOAD_MS = 950;
// FOLLOWUP FIX (PART 3): the player's own shot is a fast traveling bullet
// resolved on arrival, not an instant full-length line.
const BULLET_TRAVEL_MS = 55;

const PLAYER_MAX_HP = 100;

const GAMEPAD_AXIS_DEADZONE = 0.16;
const GAMEPAD_TRIGGER_THRESHOLD = 0.5;

// ---------------------------------------------------------------------
// STEALTH — matched to ACTION-GAME's actual DARK OUT implementation
// (game.js ~L21907-21970: drawPlayerStealthed()), not a guessed new look.
// That version explicitly does NOT recolor/glow/outline the player — it
// samples the canvas content already drawn behind the player into thin
// horizontal strips, offsets each strip sideways by a per-strip-phased
// sine wave (a cheap heat-haze/refraction look built from drawImage()
// only), masks the warped copy to the player's own silhouette
// (destination-in), paints that back over the player's position, then
// draws the plain sprite on top at reduced, perfectly neutral alpha.
// Constants below are copied 1:1 from ACTION-GAME's own values.
// ---------------------------------------------------------------------
const STEALTH_ALPHA_ACTIVE = 0.35; // ACTION-GAME: Math.max(0, 0.40 - 0.05)
const STEALTH_DISTORT_STRIPS = 14;
const STEALTH_DISTORT_AMPLITUDE_PX = 3.5;
const STEALTH_DISTORT_PERIOD_MS = 650;
const STEALTH_FADE_MS = 150; // enter/exit fade, same duration as ACTION-GAME

// ---------------------------------------------------------------------
// COVER (drum-can barrels) — PART 4/9. Kept as one explicit lookup so
// which attack kinds cover blocks is trivial to retune later, per spec.
// SNIPER is blocked by cover (duck behind the barrel to beat the lock).
// MISSILE is NOT blocked by cover (must reposition out of the target
// ellipse instead) and CLAW (GABRIEL melee) is NOT blocked (reach attack,
// a barrel doesn't stop it) — neither of those was asked to change.
// ---------------------------------------------------------------------
const COVER_BLOCKS_ATTACK = { sniper: true, missile: false, claw: false };
const COVER_BARREL_Z_MAX = 300; // barrel must be this close (world-z) to be usable as cover
const COVER_RADIUS_PX = 72; // screen-space radius at proj.scale===1, shrinks with distance
const BARREL_SPACING_Z = 420;
const BARREL_LANE_OFFSET = 130; // world X either side of center — never blocks the center path

// ---------------------------------------------------------------------
// ENEMY ATTACK PHASE TIMINGS (PART 6/7/8) — replaces the old single
// telegraph->impact->cooldown loop with kind-specific phase sequences.
// ---------------------------------------------------------------------
const SNIPER_LOCK_RED_MS = 900;
const SNIPER_LOCK_YELLOW_MS = 500;
const SNIPER_FIRE_TRAVEL_MS = 130;
const SNIPER_IMPACT_MS = 140;
const SNIPER_COOLDOWN_MS = 1400;
const SNIPER_DAMAGE = 16;

const MISSILE_LOCKON_MS = 650;
const MISSILE_TARGET_MS = 1500;
const MISSILE_IMPACT_MS = 220;
const MISSILE_COOLDOWN_MS = 1700;
const MISSILE_DAMAGE = 24;

const ENEMY_TURN_COOLDOWN_MS = 850; // "heavy mech" — can't re-flip facing more often than this
const ENEMY_TURN_HYSTERESIS_PX = 36; // player must cross this far past center before a flip is even considered

const THEMES = {
  lab: {
    label: 'LAB / EXPERIMENT AREA',
    fog: '#0a1210',
    wall: '#3c4a46',
    wallDark: '#222b28',
    accent: '#7fffd4',
    warn: '#ffcf5c',
    floor: '#1c2422',
  },
  armored: {
    label: 'ARMORED CORRIDOR',
    fog: '#05070a',
    wall: '#4a5058',
    wallDark: '#20242a',
    accent: '#9fc8ff',
    warn: '#ff8a3b',
    floor: '#14171b',
  },
  escape: {
    label: 'ESCAPE / OUTER TUNNEL',
    fog: '#0a0906',
    wall: '#4a4238',
    wallDark: '#241f18',
    accent: '#ffcf8a',
    warn: '#ff5c5c',
    floor: '#191510',
  },
};

// ---------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------

const canvas = document.getElementById('scene-canvas');
const ctx = canvas.getContext('2d');

const hpFillEl = document.getElementById('hp-bar-fill');
const ammoCountEl = document.getElementById('ammo-count');
const ammoReserveEl = document.getElementById('ammo-reserve');
const stealthReadoutEl = document.getElementById('stealth-readout');
const stealthStateEl = document.getElementById('stealth-state');
const centerWarningEl = document.getElementById('hud-center-warning');
const themeLabelEl = document.getElementById('theme-label');
const flashOverlayEl = document.getElementById('flash-overlay');

const dbgFpsEl = document.getElementById('dbg-fps');
const dbgFrameEl = document.getElementById('dbg-frametime');
const dbgDprEl = document.getElementById('dbg-dpr');
const dbgGamepadEl = document.getElementById('dbg-gamepad');
const dbgStateEl = document.getElementById('dbg-state');

// ---------------------------------------------------------------------
// ASSETS (real DARK OUT art, copied read-only from ACTION-GAME; falls
// back to a drawn placeholder if an image hasn't loaded yet or is
// missing, per the prototype's "never block on missing art" rule).
// ---------------------------------------------------------------------

function loadImg(src) {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  return img;
}

const ASSETS = {
  player: {
    fire: loadImg('assets/player/player_north_fire.png'),
    aim: loadImg('assets/player/player_north_aim.png'),
    walk: [
      loadImg('assets/player/player_north_walk_1.png'),
      loadImg('assets/player/player_north_walk_2.png'),
      loadImg('assets/player/player_north_walk_3.png'),
    ],
    // NORTH DASH and SOUTH BACKSTEP both use this same forward-facing
    // lunge pose (PART 1 fix): the protagonist never turns to face south
    // in this game, so dash_south.png (a genuine front-on pose, confirmed
    // by viewing the ACTION-GAME source art) is never used here anymore.
    dashN: loadImg('assets/player/player_dash_north.png'),
    // EAST/WEST DASH: real direction-specific ACTION-GAME art
    // (right_dash.png / left_dash.png), copied read-only — PART 1.
    dashE: loadImg('assets/player/player_dash_east.png'),
    dashW: loadImg('assets/player/player_dash_west.png'),
  },
  roid1: {
    idle: loadImg('assets/roid1/roid1_search.png'),
    fire: loadImg('assets/roid1/roid1_fire.png'),
  },
  roid2: {
    idle: loadImg('assets/roid2/roid2_search.png'),
    fire: loadImg('assets/roid2/roid2_fire.png'),
  },
  gabriel: {
    idle: loadImg('assets/gabriel/gabriel_idle.png'),
    windup: loadImg('assets/gabriel/gabriel_claw_windup.png'),
    release: loadImg('assets/gabriel/gabriel_claw_release.png'),
  },
  barrel: loadImg('assets/objects/barrel.png'),
};

function imgReady(img) {
  return !!img && img.complete && img.naturalWidth > 0;
}

// ---------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------

const state = {
  dpr: 1,
  cssW: window.innerWidth,
  cssH: window.innerHeight,
  theme: 'lab',
  timeSec: 0,

  player: {
    hp: PLAYER_MAX_HP,
    strafeOffset: 0,      // px from screen center, +east/-west
    scale: 1,              // depth pulse scale (north/south sync)
    scaleTarget: 1,
    facing: 'idle',        // 'idle' | 'walk' | 'fire' | 'aim'
    walkFrame: 0,
    walkTimer: 0,
    dashUntil: 0,          // ms timestamp; screen-space strafe dash pulse
    dashDir: 0,            // -1 west, +1 east
    dashStrafeStart: 0,
    fwdDashUntil: 0,       // north/south dash pulse window
    fwdDashSign: 0,        // +1 north(forward)/-1 south(back)
    fwdDashCoveredZ: 0,    // world-z already applied this dash (position-tracked, framerate independent)
    invincibleUntil: 0,
    stealth: false,
    stealthToggledAt: -Infinity, // for the enter/exit fade, see STEALTH_FADE_MS
    ammo: MAG_SIZE,
    reserve: RESERVE_MAX,
    reloading: false,
    reloadUntil: 0,
    fireCooldownUntil: 0,
    lastHpFillPct: -1,
    lastAmmoText: '',
    lastStealthText: '',
  },

  enemy: {
    type: 'roid1',
    z: 900,
    lane: 0,          // world X offset — slow drift only (PART 6), never a fast strafe
    laneTarget: 0,
    facing: 'east',   // 'east' | 'west' — which way the sprite mirrors to face the player
    lastTurnAt: -Infinity,
    attackState: 'idle', // per-kind phase name; see updateEnemy() for the full list
    attackUntil: 0,
    nextIdleCheckAt: 0,
    kind: 'sniper',   // 'sniper' | 'missile' | 'claw'
    hp: 100,
    hitFlashUntil: 0,
    // SNIPER (PART 8): red/yellow lock box tracks the player live during
    // both lock phases; fireFrom/fireTo freeze the bolt's endpoints the
    // instant FIRE starts, so the traveling-bolt render is deterministic.
    lockX: 0, lockY: 0,
    fireFromX: 0, fireFromY: 0, fireToX: 0, fireToY: 0,
    // MISSILE (PART 7): target ellipse position frozen at the START of
    // PHASE2 (TARGET AREA) — not re-tracked live — so the player can
    // actually dodge it by moving away before it lands, per spec.
    missileTargetX: 0, missileTargetY: 0,
  },

  input: {
    moveX: 0, moveY: 0,
    lightX: 0, lightY: 0,
    aimX: 0, aimY: 0,
    fireHeld: false,
  },

  // edge-triggered one-shot actions, consumed by update() each frame
  actions: {
    reload: false,
    stealth: false,
    flash: false,
    northDash: false,
    southDash: false,
    eastDash: false,
    westDash: false,
  },

  gamepadConnected: false,
  gamepadIndex: null,
  prevButtons: [],

  particles: [], // muzzle flash / tracer / hit spark, fixed pool

  debug: {
    frameTimes: [],
    lastReportAt: 0,
  },
};

// fixed-size particle pool (avoid per-shot allocation churn)
const PARTICLE_POOL_SIZE = 48;
for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
  state.particles.push({ active: false, type: '', x: 0, y: 0, x2: 0, y2: 0, r: 0, until: 0, born: 0 });
}
function spawnParticle(cfg) {
  for (let i = 0; i < state.particles.length; i++) {
    const p = state.particles[i];
    if (!p.active) {
      Object.assign(p, cfg, { active: true });
      return p;
    }
  }
  return null; // pool exhausted -> drop silently, never allocate mid-frame
}

// PART 3: the player's own shot — a fast traveling bullet, resolved
// (hit-test + spark) at ARRIVAL time, not at the instant the trigger is
// pulled. Small fixed pool, same no-allocation-mid-frame pattern as
// particles above.
state.bullets = [];
const BULLET_POOL_SIZE = 12;
for (let i = 0; i < BULLET_POOL_SIZE; i++) {
  state.bullets.push({ active: false, x1: 0, y1: 0, x2: 0, y2: 0, firedAt: 0, resolveAt: 0 });
}
function spawnBullet(cfg) {
  for (let i = 0; i < state.bullets.length; i++) {
    const b = state.bullets[i];
    if (!b.active) { Object.assign(b, cfg, { active: true }); return b; }
  }
  return null;
}

// ---------------------------------------------------------------------
// STRUCTURE POOL (procedural corridor — 8 kinds, per spec PART 5)
// ---------------------------------------------------------------------

const STRUCTURE_KINDS = [
  { kind: 'gantry', spacing: 260 },
  { kind: 'wallFrame', spacing: 130 },
  { kind: 'ceilingLight', spacing: 300 },
  { kind: 'floorSeam', spacing: 95 },
  { kind: 'grating', spacing: 210 },
  { kind: 'pipe', spacing: 150 },
  { kind: 'panel', spacing: 180 },
  { kind: 'warningLight', spacing: 260 },
];

const structures = [];
for (const def of STRUCTURE_KINDS) {
  for (let z = Z_NEAR + def.spacing * 0.5; z < Z_FAR; z += def.spacing) {
    structures.push({ kind: def.kind, z, phase: Math.random() * Math.PI * 2 });
  }
}

// ---------------------------------------------------------------------
// BARRELS (drum-can COVER ZONE objects — PART 4). Alternating left/right
// of center so the corridor is never fully blocked and only every other
// spacing gets one, so the stage isn't wall-to-wall safe zones (PART 4:
// "ステージ全体を安全地帯だらけにしないでください"). Recycled the exact
// same way structures are (see applyForwardDelta), so they keep appearing
// as the player advances instead of being a one-time, exhaustible set.
// ---------------------------------------------------------------------
const barrels = [];
{
  let side = -1;
  for (let z = Z_NEAR + BARREL_SPACING_Z * 0.5; z < Z_FAR; z += BARREL_SPACING_Z) {
    barrels.push({ z, lane: side * BARREL_LANE_OFFSET });
    side *= -1;
  }
}

// ---------------------------------------------------------------------
// PROJECTION
// ---------------------------------------------------------------------

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function project(worldX, worldY, z) {
  const scale = FOCAL / (FOCAL + Math.max(z, 1));
  return {
    x: state.centerX + worldX * scale,
    y: state.horizonY + worldY * scale,
    scale,
  };
}

// ---------------------------------------------------------------------
// RESIZE
// ---------------------------------------------------------------------

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  state.cssW = w;
  state.cssH = h;
  state.dpr = dpr;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.centerX = w / 2;
  state.horizonY = h * HORIZON_Y_RATIO;
  dbgDprEl.textContent = dpr.toFixed(2);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', resize);
resize();

// ---------------------------------------------------------------------
// GAMEPAD INPUT
// Lesson carried over from DARK OUT (ACTION-GAME): never assume a pad is
// present at load, never rely solely on the 'gamepadconnected' event
// (Safari can be late to expose it), poll every frame instead, and
// always reset edge-tracking state on disconnect so no button can get
// stuck "held" forever.
// ---------------------------------------------------------------------

window.addEventListener('gamepadconnected', () => { /* poll handles adoption; this is just a hint */ });
window.addEventListener('gamepaddisconnected', (e) => {
  if (e.gamepad && e.gamepad.index === state.gamepadIndex) {
    state.gamepadIndex = null;
    state.gamepadConnected = false;
    state.prevButtons = [];
  }
});

// PART 2: deadzone + rescale + power curve, AIM stick only. Rescaling after
// the deadzone cut avoids a "dead jump" right at the deadzone boundary;
// the power curve then compresses small/medium inputs while preserving
// output=1 at input=1 (full stick deflection still reaches full speed).
function applyAimCurve(raw) {
  const a = Math.abs(raw);
  if (a < AIM_DEADZONE) return 0;
  const rescaled = (a - AIM_DEADZONE) / (1 - AIM_DEADZONE);
  const curved = Math.pow(rescaled, AIM_CURVE_POWER);
  return raw < 0 ? -curved : curved;
}

function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null;
  if (state.gamepadIndex !== null) {
    gp = pads[state.gamepadIndex] || null;
    if (!gp || !gp.connected) { gp = null; state.gamepadIndex = null; }
  }
  if (!gp) {
    for (let i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) { gp = pads[i]; state.gamepadIndex = i; break; }
    }
  }

  state.gamepadConnected = !!gp;
  dbgGamepadEl.textContent = gp ? (gp.id ? gp.id.slice(0, 18) : 'CONNECTED') : 'NONE';

  const gpMove = { x: 0, y: 0 };
  const gpLight = { x: 0, y: 0 };
  const gpAim = { x: 0, y: 0 };
  let gpFire = false;

  if (gp) {
    const b = gp.buttons;
    const prev = state.prevButtons;
    const pressed = (i) => !!(b[i] && b[i].pressed);
    const edge = (i) => pressed(i) && !(prev[i] && prev[i]);

    // D-PAD -> normal move
    if (pressed(14)) gpMove.x -= 1; // left
    if (pressed(15)) gpMove.x += 1; // right
    if (pressed(12)) gpMove.y -= 1; // up = north/forward
    if (pressed(13)) gpMove.y += 1; // down = south/back

    // MOVE/LIGHT sticks — UNCHANGED linear deadzone (PART 2: don't touch
    // what already feels right, and don't shrink deadzone anywhere — a
    // smaller deadzone only invites drift).
    const ax = (v) => (Math.abs(v) < GAMEPAD_AXIS_DEADZONE ? 0 : v);
    gpLight.x = ax(gp.axes[0] || 0);
    gpLight.y = ax(gp.axes[1] || 0);
    // AIM stick only — deadzone (same size as above, not smaller) then a
    // response curve so small nudges move the reticle far less while full
    // deflection still reaches the same max speed as before (PART 2).
    gpAim.x = applyAimCurve(gp.axes[2] || 0);
    gpAim.y = applyAimCurve(gp.axes[3] || 0);

    gpFire = pressed(5); // RB
    if (edge(4)) state.actions.reload = true;      // LB
    if (edge(2)) state.actions.stealth = true;     // X
    if (edge(3)) state.actions.flash = true;       // Y
    if (edge(1)) state.actions.northDash = true;   // B
    if (edge(0)) state.actions.southDash = true;   // A
    if (edge(7)) state.actions.eastDash = true;    // RT
    if (edge(6)) state.actions.westDash = true;    // LT

    const nextPrev = new Array(b.length);
    for (let i = 0; i < b.length; i++) nextPrev[i] = pressed(i);
    state.prevButtons = nextPrev;
  } else {
    state.prevButtons = [];
  }

  return { move: gpMove, light: gpLight, aim: gpAim, fire: gpFire };
}

// ---------------------------------------------------------------------
// TOUCH / VIRTUAL STICK INPUT (fallback for testing without a pad)
// ---------------------------------------------------------------------

function makeVirtualStick(padEl, stickEl) {
  const st = { x: 0, y: 0, active: false, pointerId: null };
  function update(clientX, clientY) {
    const rect = padEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const radius = rect.width / 2;
    let dx = (clientX - cx) / radius;
    let dy = (clientY - cy) / radius;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) { dx /= mag; dy /= mag; }
    st.x = dx; st.y = dy;
    stickEl.style.transform = `translate(${dx * radius * 0.55}px, ${dy * radius * 0.55}px)`;
  }
  padEl.addEventListener('pointerdown', (e) => {
    st.active = true; st.pointerId = e.pointerId;
    padEl.setPointerCapture(e.pointerId);
    update(e.clientX, e.clientY);
  });
  padEl.addEventListener('pointermove', (e) => {
    if (!st.active || e.pointerId !== st.pointerId) return;
    update(e.clientX, e.clientY);
  });
  function release(e) {
    if (e.pointerId !== st.pointerId) return;
    st.active = false; st.pointerId = null; st.x = 0; st.y = 0;
    stickEl.style.transform = 'translate(0,0)';
  }
  padEl.addEventListener('pointerup', release);
  padEl.addEventListener('pointercancel', release);
  return st;
}

const touchMove = makeVirtualStick(document.getElementById('touch-move-pad'), document.querySelector('#touch-move-pad .touch-stick'));
const touchLight = makeVirtualStick(document.getElementById('touch-light-pad'), document.querySelector('#touch-light-pad .touch-stick'));
const touchAim = makeVirtualStick(document.getElementById('touch-aim-pad'), document.querySelector('#touch-aim-pad .touch-stick'));

let touchFireHeld = false;
function wireButton(id, onPress) {
  const el = document.getElementById(id);
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); onPress(); });
}
wireButton('touch-fire', () => {});
const fireBtnEl = document.getElementById('touch-fire');
fireBtnEl.addEventListener('pointerdown', () => { touchFireHeld = true; });
fireBtnEl.addEventListener('pointerup', () => { touchFireHeld = false; });
fireBtnEl.addEventListener('pointercancel', () => { touchFireHeld = false; });
wireButton('touch-reload', () => { state.actions.reload = true; });
wireButton('touch-stealth', () => { state.actions.stealth = true; });
wireButton('touch-flash', () => { state.actions.flash = true; });
wireButton('touch-dash-n', () => { state.actions.northDash = true; });
wireButton('touch-dash-s', () => { state.actions.southDash = true; });

document.querySelectorAll('.theme-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.theme-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.theme = btn.dataset.theme;
    themeLabelEl.textContent = THEMES[state.theme].label;
  });
});
document.querySelectorAll('.enemy-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.enemy-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.enemy.type = btn.dataset.enemy;
    state.enemy.kind = btn.dataset.enemy === 'gabriel' ? 'claw' : 'sniper';
    state.enemy.attackState = 'idle';
    state.enemy.nextIdleCheckAt = 0;
    state.enemy.z = 900;
    state.enemy.facing = 'east';
    state.enemy.lane = 0;
    state.enemy.laneTarget = 0;
  });
});

// ---------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------

function consumeActions() {
  const a = state.actions;
  const out = { ...a };
  a.reload = a.stealth = a.flash = a.northDash = a.southDash = a.eastDash = a.westDash = false;
  return out;
}

function updatePlayer(dt, now, moveX, moveY, actions) {
  const p = state.player;

  // WEST/EAST strafe (continuous, D-PAD/touch)
  p.strafeOffset += moveX * STRAFE_SPEED * dt;
  const maxOff = state.cssW * STRAFE_MAX_OFFSET;
  p.strafeOffset = Math.max(-maxOff, Math.min(maxOff, p.strafeOffset));

  // LT/RT strafe dash — PART 1 fix: fixed total pixel distance
  // (STRAFE_DASH_DISTANCE_PX), position-recomputed from a stored start
  // value each frame (same deterministic pattern as before, just a much
  // smaller total so it reads as a quick sidestep, never a screen-edge
  // teleport).
  if (actions.westDash) { p.dashDir = -1; p.dashUntil = now + DASH_DURATION_MS; p.dashStrafeStart = p.strafeOffset; p.invincibleUntil = now + DASH_INVINCIBLE_MS; }
  if (actions.eastDash) { p.dashDir = 1; p.dashUntil = now + DASH_DURATION_MS; p.dashStrafeStart = p.strafeOffset; p.invincibleUntil = now + DASH_INVINCIBLE_MS; }
  if (now < p.dashUntil) {
    const tNorm = 1 - (p.dashUntil - now) / DASH_DURATION_MS;
    const eased = 1 - Math.pow(1 - tNorm, 2);
    p.strafeOffset = Math.max(-maxOff, Math.min(maxOff, p.dashStrafeStart + p.dashDir * STRAFE_DASH_DISTANCE_PX * eased));
  }

  // NORTH/SOUTH world scroll + player scale sync
  let forwardDelta = 0;
  if (moveY < 0) { forwardDelta += WALK_FORWARD_SPEED * dt; p.scaleTarget = 0.94; }
  else if (moveY > 0) { forwardDelta -= WALK_BACK_SPEED * dt; p.scaleTarget = 1.06; }
  else { p.scaleTarget = 1.0; }

  // PART 1 fix: forward/back DASH now covers a fixed TOTAL world-z
  // distance over DASH_DURATION_MS, using the same "recompute absolute
  // progress each frame, apply only the incremental delta" pattern as the
  // strafe dash above (fwdDashCoveredZ tracks how much of the total has
  // already been applied) — framerate-independent, and no more coupled to
  // an arbitrary "*3.2" burst multiplier that let the old numbers balloon.
  if (actions.northDash) { p.fwdDashSign = 1; p.fwdDashUntil = now + DASH_DURATION_MS; p.fwdDashCoveredZ = 0; p.invincibleUntil = now + DASH_INVINCIBLE_MS; }
  if (actions.southDash) { p.fwdDashSign = -1; p.fwdDashUntil = now + DASH_DURATION_MS; p.fwdDashCoveredZ = 0; p.invincibleUntil = now + DASH_INVINCIBLE_MS; }
  if (now < p.fwdDashUntil) {
    const tNorm = 1 - (p.fwdDashUntil - now) / DASH_DURATION_MS;
    const eased = 1 - Math.pow(1 - tNorm, 2);
    const totalDist = p.fwdDashSign > 0 ? DASH_FORWARD_DISTANCE_Z : DASH_BACK_DISTANCE_Z;
    const coveredNow = totalDist * eased;
    forwardDelta += p.fwdDashSign * (coveredNow - p.fwdDashCoveredZ);
    p.fwdDashCoveredZ = coveredNow;
    p.scaleTarget = p.fwdDashSign > 0 ? 0.88 : 1.10;
  }

  p.scale += (p.scaleTarget - p.scale) * Math.min(1, dt * 10);

  // toggle STEALTH — stealthToggledAt drives the enter/exit fade (PART 5)
  if (actions.stealth) { p.stealth = !p.stealth; p.stealthToggledAt = now; }

  // FLASH — brief screen pulse (instant opacity via .firing, no transition)
  // then a plain setTimeout drops the class so the base rule's own
  // transition fades it back out. Plus: interrupts a nearby enemy's
  // telegraphed attack (reused as a stun, per DARK OUT's FLASH concept).
  if (actions.flash) {
    flashOverlayEl.classList.add('firing');
    clearTimeout(flashOverlayEl._flashTimer);
    flashOverlayEl._flashTimer = setTimeout(() => { flashOverlayEl.classList.remove('firing'); }, 90);
    if (INTERRUPTIBLE_PHASES.indexOf(state.enemy.attackState) !== -1) {
      state.enemy.attackState = 'cooldown';
      state.enemy.attackUntil = now + 900;
    }
  }

  // RELOAD
  if (actions.reload && !p.reloading && p.ammo < MAG_SIZE && p.reserve > 0) {
    p.reloading = true;
    p.reloadUntil = now + RELOAD_MS;
  }
  if (p.reloading && now >= p.reloadUntil) {
    const need = MAG_SIZE - p.ammo;
    const take = Math.min(need, p.reserve);
    p.ammo += take;
    p.reserve -= take;
    p.reloading = false;
  }

  // walk animation frame (only when strafing, purely cosmetic)
  if (Math.abs(moveX) > 0.05 || Math.abs(moveY) > 0.05) {
    p.walkTimer += dt;
    if (p.walkTimer > 0.14) { p.walkTimer = 0; p.walkFrame = (p.walkFrame + 1) % 3; }
    p.facing = 'walk';
  } else {
    p.facing = 'idle';
  }

  return forwardDelta;
}

function applyForwardDelta(forwardDelta) {
  for (const s of structures) {
    s.z -= forwardDelta;
    if (s.z < Z_NEAR) s.z += Z_RANGE;
    else if (s.z > Z_FAR) s.z -= Z_RANGE;
  }
  // PART 4: barrels recycle the exact same way structures do, so cover
  // keeps appearing as the player advances instead of running out.
  for (const b of barrels) {
    b.z -= forwardDelta;
    if (b.z < Z_NEAR) b.z += Z_RANGE;
    else if (b.z > Z_FAR) b.z -= Z_RANGE;
  }
  const e = state.enemy;
  e.z = Math.max(ENEMY_Z_MIN, Math.min(ENEMY_Z_MAX, e.z - forwardDelta));
}

// PART 4/9: is the player currently standing in ANY barrel's cover zone?
// Screen-space check: the barrel must be close enough (world-z) to be
// reachable, and the player's own screen X (their real strafe position)
// must fall within the barrel's projected cover radius — i.e. the player
// actually walked up next to it, not merely "somewhere in the corridor".
function isPlayerInCover() {
  const playerScreenX = state.centerX + state.player.strafeOffset;
  for (const b of barrels) {
    if (b.z > COVER_BARREL_Z_MAX) continue;
    const proj = project(b.lane, CORRIDOR_FLOOR_Y, b.z);
    const radius = COVER_RADIUS_PX * proj.scale;
    if (Math.abs(proj.x - playerScreenX) < radius) return true;
  }
  return false;
}

// Phases that FLASH (Y) can interrupt — anything before the attack is
// actually committed (fire/impact are too late to stun out of).
const INTERRUPTIBLE_PHASES = ['telegraph', 'lock_red', 'lock_yellow', 'lockon', 'target'];

function showCenterMsg(text, color) {
  centerWarningEl.textContent = text;
  centerWarningEl.hidden = false;
  centerWarningEl.style.color = color;
  clearTimeout(centerWarningEl._hideTimer);
  centerWarningEl._hideTimer = setTimeout(() => { centerWarningEl.hidden = true; }, 550);
}

function playerMarkerPos() {
  return { x: state.centerX + state.player.strafeOffset, y: state.cssH * 0.9 };
}

// PART 6: facing/turning — a slow, deliberate "heavy mech" turn, not an
// instant flip. desiredFacing only changes once the player has crossed
// ENEMY_TURN_HYSTERESIS_PX past center (no flicker at the midpoint), and
// even then the flip itself is rate-limited by ENEMY_TURN_COOLDOWN_MS.
// Lane drift is a slow bias toward the player's general side, never a
// fast strafe — the mech shifts weight, it doesn't sidestep.
function updateEnemyFacing(dt, now) {
  const e = state.enemy;
  const proj = project(e.lane, CORRIDOR_FLOOR_Y, e.z);
  const playerScreenX = state.centerX + state.player.strafeOffset;
  const diff = playerScreenX - proj.x;

  let desired = e.facing;
  if (diff > ENEMY_TURN_HYSTERESIS_PX) desired = 'east';
  else if (diff < -ENEMY_TURN_HYSTERESIS_PX) desired = 'west';
  if (desired !== e.facing && now - e.lastTurnAt > ENEMY_TURN_COOLDOWN_MS) {
    e.facing = desired;
    e.lastTurnAt = now;
  }

  e.laneTarget = clamp(diff * 0.12, -70, 70);
  e.lane += (e.laneTarget - e.lane) * Math.min(1, dt * 0.8);
}

function resolveSniperImpact(now) {
  const e = state.enemy;
  const p = state.player;
  const invincible = now < p.invincibleUntil;
  const blocked = COVER_BLOCKS_ATTACK.sniper && isPlayerInCover();
  spawnParticle({ type: 'explosionFlash', x: e.fireToX, y: e.fireToY, r: 16, born: now, until: now + 90 });
  spawnParticle({ type: 'spark', x: e.fireToX, y: e.fireToY, born: now, until: now + 170 });
  if (invincible) {
    showCenterMsg('AVOIDED', '#7fffb0');
  } else if (blocked) {
    showCenterMsg('BLOCKED', '#9fd8ff');
  } else {
    p.hp = Math.max(0, p.hp - SNIPER_DAMAGE);
    showCenterMsg('HIT!', '#ff4040');
  }
}

function resolveMissileImpact(now) {
  const e = state.enemy;
  const p = state.player;
  const invincible = now < p.invincibleUntil;
  const playerScreenX = state.centerX + p.strafeOffset;
  const playerScreenY = state.cssH * 0.9;
  const dist = Math.hypot(playerScreenX - e.missileTargetX, playerScreenY - e.missileTargetY);
  // PART 9: cover does NOT block missile splash — only actually having
  // moved out of the (frozen, visible-in-advance) target ellipse does.
  const inSplash = dist < 62;

  spawnParticle({ type: 'explosionFlash', x: e.missileTargetX, y: e.missileTargetY, r: 34, born: now, until: now + 130 });
  for (let i = 0; i < 3; i++) {
    spawnParticle({ type: 'spark', x: e.missileTargetX + (i - 1) * 10, y: e.missileTargetY, born: now, until: now + 200 + i * 30 });
  }
  spawnParticle({ type: 'smoke', x: e.missileTargetX, y: e.missileTargetY, r: 26, born: now, until: now + 420 });

  if (invincible) {
    showCenterMsg('AVOIDED', '#7fffb0');
  } else if (!inSplash) {
    showCenterMsg('DODGED', '#7fffb0');
  } else {
    p.hp = Math.max(0, p.hp - MISSILE_DAMAGE);
    showCenterMsg('HIT!', '#ff4040');
  }
}

function updateEnemy(dt, now) {
  const e = state.enemy;
  const p = state.player;

  updateEnemyFacing(dt, now);

  if (e.attackState === 'idle') {
    if (!e.nextIdleCheckAt) e.nextIdleCheckAt = now + 1500;
    if (now >= e.nextIdleCheckAt && e.z < 900) {
      const stealthMul = p.stealth ? 1.8 : 1.0;
      if (e.type === 'gabriel') {
        e.kind = 'claw';
        e.attackState = 'telegraph';
        e.attackUntil = now + 700 * stealthMul;
      } else {
        e.kind = Math.random() < 0.45 ? 'missile' : 'sniper';
        if (e.kind === 'sniper') {
          e.attackState = 'lock_red';
          e.attackUntil = now + SNIPER_LOCK_RED_MS * stealthMul;
        } else {
          e.attackState = 'lockon';
          e.attackUntil = now + MISSILE_LOCKON_MS * stealthMul;
        }
      }
    } else if (now >= e.nextIdleCheckAt) {
      e.nextIdleCheckAt = now + 400; // too far, re-check soon without attacking
    }
    return;
  }

  // --- GABRIEL claw (unchanged shape: telegraph -> impact -> cooldown) ---
  if (e.kind === 'claw') {
    if (e.attackState === 'telegraph') {
      if (now >= e.attackUntil) {
        e.attackState = 'impact';
        e.attackUntil = now + 140;
        const dodged = now < p.invincibleUntil;
        if (!dodged) { p.hp = Math.max(0, p.hp - 20); showCenterMsg('HIT!', '#ff4040'); }
        else showCenterMsg('AVOIDED', '#7fffb0');
      }
    } else if (e.attackState === 'impact') {
      if (now >= e.attackUntil) { e.attackState = 'cooldown'; e.attackUntil = now + 1200; }
    } else if (e.attackState === 'cooldown') {
      if (now >= e.attackUntil) { e.attackState = 'idle'; e.nextIdleCheckAt = now + 900 + Math.random() * 1400; }
    }
    return;
  }

  // --- SNIPER (PART 8): lock_red -> lock_yellow -> fire -> impact -> cooldown ---
  if (e.kind === 'sniper') {
    if (e.attackState === 'lock_red' || e.attackState === 'lock_yellow') {
      // the lock box tracks the player LIVE through both lock phases.
      const m = playerMarkerPos();
      e.lockX = m.x; e.lockY = m.y;
      if (now >= e.attackUntil) {
        if (e.attackState === 'lock_red') {
          e.attackState = 'lock_yellow';
          e.attackUntil = now + SNIPER_LOCK_YELLOW_MS;
        } else {
          // FIRE begins: freeze the bolt's endpoints right now.
          const proj = screenSpaceEnemyAnchor();
          e.fireFromX = proj.x; e.fireFromY = proj.y;
          e.fireToX = e.lockX; e.fireToY = e.lockY;
          e.attackState = 'fire';
          e.attackUntil = now + SNIPER_FIRE_TRAVEL_MS;
        }
      }
    } else if (e.attackState === 'fire') {
      if (now >= e.attackUntil) {
        e.attackState = 'impact';
        e.attackUntil = now + SNIPER_IMPACT_MS;
        resolveSniperImpact(now);
      }
    } else if (e.attackState === 'impact') {
      if (now >= e.attackUntil) { e.attackState = 'cooldown'; e.attackUntil = now + SNIPER_COOLDOWN_MS; }
    } else if (e.attackState === 'cooldown') {
      if (now >= e.attackUntil) { e.attackState = 'idle'; e.nextIdleCheckAt = now + 700 + Math.random() * 1200; }
    }
    return;
  }

  // --- MISSILE (PART 7): lockon -> target -> impact -> cooldown ---
  if (e.kind === 'missile') {
    if (e.attackState === 'lockon') {
      if (now >= e.attackUntil) {
        // TARGET AREA begins: freeze the impact ellipse's position now, so
        // the player can dodge by moving away from THIS fixed spot.
        const m = playerMarkerPos();
        e.missileTargetX = m.x; e.missileTargetY = m.y;
        e.attackState = 'target';
        e.attackUntil = now + MISSILE_TARGET_MS;
      }
    } else if (e.attackState === 'target') {
      if (now >= e.attackUntil) {
        e.attackState = 'impact';
        e.attackUntil = now + MISSILE_IMPACT_MS;
        resolveMissileImpact(now);
      }
    } else if (e.attackState === 'impact') {
      if (now >= e.attackUntil) { e.attackState = 'cooldown'; e.attackUntil = now + MISSILE_COOLDOWN_MS; }
    } else if (e.attackState === 'cooldown') {
      if (now >= e.attackUntil) { e.attackState = 'idle'; e.nextIdleCheckAt = now + 900 + Math.random() * 1400; }
    }
  }
}

function screenSpaceEnemyAnchor() {
  const proj = project(state.enemy.lane, CORRIDOR_FLOOR_Y, state.enemy.z);
  return proj;
}

// Poses that should show the "aiming/firing" sprite instead of idle, for
// the non-GABRIEL enemy types (sniper + missile share one aim pose).
const ENEMY_AIM_POSES = ['lock_red', 'lock_yellow', 'fire', 'lockon', 'target', 'impact'];

// Shared by renderEnemy() and fireWeapon() so the hit-test always matches
// what's actually drawn.
function computeEnemyDrawRect() {
  const e = state.enemy;
  const proj = screenSpaceEnemyAnchor();
  const set = ASSETS[e.type];
  const img = (e.type === 'gabriel')
    ? (e.attackState === 'telegraph' ? set.windup : (e.attackState === 'impact' ? set.release : set.idle))
    : (ENEMY_AIM_POSES.indexOf(e.attackState) !== -1 ? set.fire : set.idle);

  const distNorm = 1 - (e.z - ENEMY_Z_MIN) / (ENEMY_Z_MAX - ENEMY_Z_MIN);
  const closeBoost = 1 + Math.max(0, distNorm - 0.55) * 2.6;
  const drawH = ENEMY_WORLD_HEIGHT * proj.scale * closeBoost;
  const aspect = imgReady(img) ? img.naturalWidth / img.naturalHeight : 0.72;
  const drawW = drawH * aspect;

  const closeT = Math.max(0, Math.min(1, (distNorm - 0.5) / 0.5));
  const anchorFrac = 1.0 - closeT * 0.45;
  const drawBottomY = proj.y + (1 - anchorFrac) * drawH;
  const drawX = proj.x - drawW / 2;
  const drawTopY = drawBottomY - drawH;

  return { img, proj, x: drawX, y: drawTopY, w: drawW, h: drawH, cx: proj.x, cy: drawTopY + drawH * 0.42 };
}

// PART 3: fire spawns a muzzle flash + a fast traveling bullet only — no
// full-length line is ever drawn between muzzle and target. The bullet is
// resolved (hit-test, then spark on a hit) by updateBullets() once it
// actually arrives, not here at fire-time — see BULLET_TRAVEL_MS.
function fireWeapon(now) {
  const p = state.player;
  if (p.reloading || p.ammo <= 0) return;
  if (now < p.fireCooldownUntil) return;
  p.fireCooldownUntil = now + FIRE_COOLDOWN_MS;
  p.ammo -= 1;

  const muzzleX = state.centerX + p.strafeOffset;
  const muzzleY = state.cssH * 0.86 - 60;
  const aim = getAimPoint();

  spawnParticle({ type: 'muzzle', x: muzzleX, y: muzzleY, born: now, until: now + 45 });
  spawnBullet({ x1: muzzleX, y1: muzzleY, x2: aim.x, y2: aim.y, firedAt: now, resolveAt: now + BULLET_TRAVEL_MS });
}

function updateBullets(now) {
  for (const b of state.bullets) {
    if (!b.active) continue;
    if (now < b.resolveAt) continue;
    b.active = false;
    const rect = computeEnemyDrawRect();
    const hitRadius = Math.max(18, rect.w * 0.42);
    const dist = Math.hypot(b.x2 - rect.cx, b.y2 - rect.cy);
    if (dist <= hitRadius) {
      state.enemy.hitFlashUntil = now + 120;
      spawnParticle({ type: 'spark', x: b.x2, y: b.y2, born: now, until: now + 180 });
    }
  }
}

function getFlashlightCenter() {
  const lx = clampAxis(state.input.lightX) * FLASHLIGHT_STICK_RANGE;
  const ly = clampAxis(state.input.lightY) * FLASHLIGHT_STICK_RANGE;
  return { x: state.centerX + lx, y: state.horizonY + state.cssH * 0.06 + ly };
}
function clampAxis(v) { return Math.max(-1, Math.min(1, v)); }

function getAimPoint() {
  const center = getFlashlightCenter();
  let dx = clampAxis(state.input.aimX) * AIM_RANGE;
  let dy = clampAxis(state.input.aimY) * AIM_RANGE;
  const maxR = FLASHLIGHT_BASE_RADIUS - AIM_MARKER_PAD;
  const dist = Math.hypot(dx, dy);
  if (dist > maxR) { const s = maxR / dist; dx *= s; dy *= s; }
  return { x: center.x + dx, y: center.y + dy };
}

// ---------------------------------------------------------------------
// RENDER
// ---------------------------------------------------------------------

const darkCanvas = document.createElement('canvas');
const darkCtx = darkCanvas.getContext('2d');

function renderStructure(s, theme) {
  const half = CORRIDOR_HALF_WIDTH;
  switch (s.kind) {
    case 'gantry': {
      const tl = project(-half, CORRIDOR_CEIL_Y, s.z);
      const tr = project(half, CORRIDOR_CEIL_Y, s.z);
      const bl = project(-half, CORRIDOR_FLOOR_Y, s.z);
      const br = project(half, CORRIDOR_FLOOR_Y, s.z);
      ctx.strokeStyle = theme.wall;
      ctx.lineWidth = Math.max(1, 5 * tl.scale);
      ctx.beginPath();
      ctx.moveTo(bl.x, bl.y); ctx.lineTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(br.x, br.y);
      ctx.stroke();
      break;
    }
    case 'wallFrame': {
      for (const side of [-1, 1]) {
        const top = project(side * half, CORRIDOR_CEIL_Y * 0.7, s.z);
        const bot = project(side * half, CORRIDOR_FLOOR_Y * 0.7, s.z);
        ctx.strokeStyle = theme.wallDark;
        ctx.lineWidth = Math.max(1, 2.5 * top.scale);
        ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y); ctx.stroke();
      }
      break;
    }
    case 'ceilingLight': {
      const p1 = project(-40, CORRIDOR_CEIL_Y, s.z);
      const p2 = project(40, CORRIDOR_CEIL_Y, s.z);
      const flicker = 0.75 + 0.25 * Math.sin(state.timeSec * 3 + s.phase);
      ctx.strokeStyle = theme.accent;
      ctx.globalAlpha = flicker * Math.min(1, p1.scale * 1.4);
      ctx.lineWidth = Math.max(1, 4 * p1.scale);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      ctx.globalAlpha = 1;
      break;
    }
    case 'floorSeam': {
      const l = project(-half, CORRIDOR_FLOOR_Y, s.z);
      const r = project(half, CORRIDOR_FLOOR_Y, s.z);
      ctx.strokeStyle = theme.wallDark;
      ctx.lineWidth = Math.max(1, 2 * l.scale);
      ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.stroke();
      break;
    }
    case 'grating': {
      const l = project(-half * 0.7, CORRIDOR_FLOOR_Y * 0.98, s.z);
      const r = project(half * 0.7, CORRIDOR_FLOOR_Y * 0.98, s.z);
      const w = r.x - l.x;
      ctx.strokeStyle = theme.wallDark;
      ctx.lineWidth = Math.max(1, 1.5 * l.scale);
      const bars = 6;
      for (let i = 0; i <= bars; i++) {
        const x = l.x + (w * i) / bars;
        ctx.beginPath(); ctx.moveTo(x, l.y - 3 * l.scale); ctx.lineTo(x, l.y + 3 * l.scale); ctx.stroke();
      }
      break;
    }
    case 'pipe': {
      const p1 = project(-half * 1.02, CORRIDOR_CEIL_Y * 0.35, s.z);
      const p2 = project(half * 1.02, CORRIDOR_CEIL_Y * 0.35, s.z);
      ctx.strokeStyle = theme.wallDark;
      ctx.lineWidth = Math.max(1, 3 * p1.scale);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      break;
    }
    case 'panel': {
      const side = s.phase > Math.PI ? 1 : -1;
      const a = project(side * half, CORRIDOR_CEIL_Y * 0.3, s.z);
      const b = project(side * half, CORRIDOR_FLOOR_Y * 0.3, s.z);
      const size = 26 * a.scale;
      ctx.fillStyle = theme.wallDark;
      ctx.globalAlpha = 0.6;
      ctx.fillRect(a.x - size / 2, a.y, size, Math.max(2, b.y - a.y));
      ctx.globalAlpha = 1;
      break;
    }
    case 'warningLight': {
      const side = s.phase > Math.PI ? 1 : -1;
      const pt = project(side * half * 0.96, CORRIDOR_CEIL_Y * 0.55, s.z);
      const blink = Math.sin(state.timeSec * 6 + s.phase) > 0.4;
      if (blink) {
        ctx.fillStyle = theme.warn;
        ctx.globalAlpha = Math.min(1, pt.scale * 1.6);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, Math.max(1.5, 4 * pt.scale), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      break;
    }
  }
}

function renderCorridor(theme) {
  ctx.fillStyle = theme.fog;
  ctx.fillRect(0, 0, state.cssW, state.cssH);

  // floor / ceiling wedge (ground plane readability even without structures)
  const flFar = project(0, CORRIDOR_FLOOR_Y, Z_FAR);
  const flNearL = project(-CORRIDOR_HALF_WIDTH * 2.4, CORRIDOR_FLOOR_Y, Z_NEAR);
  const flNearR = project(CORRIDOR_HALF_WIDTH * 2.4, CORRIDOR_FLOOR_Y, Z_NEAR);
  ctx.fillStyle = theme.floor;
  ctx.beginPath();
  ctx.moveTo(flFar.x, flFar.y);
  ctx.lineTo(flNearL.x, flNearL.y);
  ctx.lineTo(flNearR.x, flNearR.y);
  ctx.closePath();
  ctx.fill();

  const sorted = structures.slice().sort((a, b) => b.z - a.z); // far to near
  for (const s of sorted) renderStructure(s, theme);
}

// PART 4: drum-can cover objects, drawn far-to-near so nearer barrels
// correctly overlap farther ones. Each barrel shows a visible ground
// shadow/glow whose radius IS the COVER ZONE boundary — matching
// isPlayerInCover()'s own math exactly, so what you see is what protects
// you (drawn brighter once the player is actually standing in it, as
// direct visual confirmation cover is active).
function renderBarrels() {
  const inCover = isPlayerInCover();
  const sorted = barrels.slice().sort((a, b) => b.z - a.z);
  for (const b of sorted) {
    const proj = project(b.lane, CORRIDOR_FLOOR_Y, b.z);
    const radius = COVER_RADIUS_PX * proj.scale;
    if (radius < 1.5) continue;

    const playerScreenX = state.centerX + state.player.strafeOffset;
    const thisOneActive = inCover && b.z <= COVER_BARREL_Z_MAX && Math.abs(proj.x - playerScreenX) < radius;

    ctx.save();
    ctx.fillStyle = thisOneActive ? 'rgba(120,255,170,0.30)' : 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(proj.x, proj.y + 4 * proj.scale, radius, radius * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();
    if (thisOneActive) {
      ctx.strokeStyle = 'rgba(160,255,200,0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();

    const img = ASSETS.barrel;
    const drawH = 300 * proj.scale;
    if (imgReady(img)) {
      const aspect = img.naturalWidth / img.naturalHeight;
      const drawW = drawH * aspect;
      ctx.drawImage(img, proj.x - drawW / 2, proj.y - drawH, drawW, drawH);
    } else {
      ctx.fillStyle = '#6b2a20';
      ctx.fillRect(proj.x - drawH * 0.28, proj.y - drawH, drawH * 0.56, drawH);
    }
  }
}

function drawSpriteCentered(img, cx, bottomY, scale, alpha, extraH) {
  if (!imgReady(img)) {
    // placeholder silhouette
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#445';
    const w = 90 * scale, h = 150 * scale;
    ctx.fillRect(cx - w / 2, bottomY - h, w, h);
    ctx.globalAlpha = 1;
    return;
  }
  const drawH = img.naturalHeight * scale * (extraH || 1);
  const drawW = img.naturalWidth * scale * (extraH || 1);
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, cx - drawW / 2, bottomY - drawH, drawW, drawH);
  ctx.globalAlpha = 1;
}

// PART 5: STEALTH matched to ACTION-GAME's actual drawPlayerStealthed()
// (game.js ~L21907). Same technique: sample the content already painted
// behind the player into thin horizontal strips, nudge each strip
// sideways by a per-strip-phased sine wave, mask the warped copy to the
// player's own silhouette, paint that back, then the plain sprite on top
// at reduced neutral alpha. No recolor/glow/outline, matching the source.
const stealthDistortCanvas = document.createElement('canvas');
const stealthDistortCtx = stealthDistortCanvas.getContext('2d');
const stealthMaskCanvas = document.createElement('canvas');
const stealthMaskCtx = stealthMaskCanvas.getContext('2d');

function getStealthStrength(now) {
  const p = state.player;
  const sinceToggle = now - p.stealthToggledAt;
  if (p.stealth) {
    return sinceToggle < STEALTH_FADE_MS ? Math.min(1, sinceToggle / STEALTH_FADE_MS) : 1;
  }
  return sinceToggle < STEALTH_FADE_MS ? Math.max(0, 1 - sinceToggle / STEALTH_FADE_MS) : 0;
}

function drawPlayerStealthed(img, dx, dy, w, h, strength, now) {
  const cw = Math.max(1, Math.round(w));
  const ch = Math.max(1, Math.round(h));
  if (stealthDistortCanvas.width !== cw || stealthDistortCanvas.height !== ch) {
    stealthDistortCanvas.width = cw;
    stealthDistortCanvas.height = ch;
    stealthMaskCanvas.width = cw;
    stealthMaskCanvas.height = ch;
  }
  const dpr = state.dpr;
  const dctx = stealthDistortCtx;
  dctx.clearRect(0, 0, cw, ch);
  const stripH = ch / STEALTH_DISTORT_STRIPS;
  for (let i = 0; i < STEALTH_DISTORT_STRIPS; i++) {
    const sy = i * stripH;
    const wave = Math.sin((now / STEALTH_DISTORT_PERIOD_MS) * Math.PI * 2 + i * 0.9) * STEALTH_DISTORT_AMPLITUDE_PX * strength;
    // Source rect is in the MAIN canvas's own backing-buffer pixels
    // (DPR-scaled); dest rect is this 1x offscreen buffer's own pixels.
    dctx.drawImage(ctx.canvas, dx * dpr, (dy + sy) * dpr, cw * dpr, (stripH + 1) * dpr, wave, sy, cw, stripH + 1);
  }
  const mctx = stealthMaskCtx;
  mctx.clearRect(0, 0, cw, ch);
  mctx.drawImage(dctx.canvas, 0, 0);
  mctx.globalCompositeOperation = 'destination-in';
  mctx.drawImage(img, 0, 0, cw, ch);
  mctx.globalCompositeOperation = 'source-over';

  ctx.drawImage(stealthMaskCanvas, dx, dy, w, h);
  ctx.save();
  ctx.globalAlpha = 1 - (1 - STEALTH_ALPHA_ACTIVE) * strength;
  ctx.drawImage(img, dx, dy, w, h);
  ctx.restore();
}

function renderPlayer(theme) {
  const p = state.player;
  const cx = state.centerX + p.strafeOffset;
  const bottomY = state.cssH * 1.02;
  let img = ASSETS.player.fire;
  if (p.reloading) img = ASSETS.player.aim;
  else if (state.input.fireHeld) img = ASSETS.player.fire;
  else if (p.facing === 'walk') img = ASSETS.player.walk[p.walkFrame];
  else img = ASSETS.player.aim;

  const nowTs = now_();
  // PART 1: NORTH DASH and SOUTH BACKSTEP both use the same north-facing
  // lunge pose — the character never turns to face south in this game, so
  // BACKSTEP no longer shows a front-on image. EAST/WEST DASH use real
  // direction-specific art so the dash direction actually reads visually.
  if (nowTs < p.fwdDashUntil) {
    img = ASSETS.player.dashN;
  } else if (nowTs < p.dashUntil) {
    img = p.dashDir > 0 ? ASSETS.player.dashE : ASSETS.player.dashW;
  }

  const baseScale = (state.cssH / 900) * 1.0;
  const strength = getStealthStrength(nowTs);

  if (!imgReady(img)) {
    drawSpriteCentered(img, cx, bottomY, baseScale * p.scale, 1);
    return;
  }
  const drawH = img.naturalHeight * baseScale * p.scale;
  const drawW = img.naturalWidth * baseScale * p.scale;
  const dx = cx - drawW / 2;
  const dy = bottomY - drawH;
  if (strength > 0.001) {
    drawPlayerStealthed(img, dx, dy, drawW, drawH, strength, nowTs);
  } else {
    ctx.drawImage(img, dx, dy, drawW, drawH);
  }
}

function renderEnemy(theme) {
  const e = state.enemy;
  const rect = computeEnemyDrawRect();
  const now = performance.now();

  // PART 6: face whichever side the player is actually on, instead of a
  // permanent EAST-facing pose. The source art's natural pose faces
  // screen-right ("east"); mirror it around the sprite's own center when
  // facing west.
  const flashing = now < e.hitFlashUntil;
  ctx.save();
  if (flashing) ctx.filter = 'brightness(2.2)';
  if (e.facing === 'west') {
    ctx.translate(rect.cx, 0);
    ctx.scale(-1, 1);
    ctx.translate(-rect.cx, 0);
  }
  if (imgReady(rect.img)) {
    ctx.drawImage(rect.img, rect.x, rect.y, rect.w, rect.h);
  } else {
    ctx.fillStyle = '#334';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();
}

// FOLLOWUP FIX: attack telegraphs (LOCK boxes, ▲, target ellipse, bolts)
// used to be drawn as part of renderEnemy(), BEFORE the DARK/FLASHLIGHT
// mask — so the mask's own darkness overlay silently dimmed them to
// near-invisible whenever they fell outside the lit circle (proven via a
// pixel sample: a "should be red" ▲ pixel came back near-black). A
// telegraph exists specifically to warn the player regardless of where
// their torch happens to be pointed, so this is drawn as its own pass
// AFTER renderFlashlightMask() in the main loop instead.
function renderEnemyTelegraphs(theme) {
  const e = state.enemy;
  const now = performance.now();

  if (e.kind === 'claw' && (e.attackState === 'telegraph' || e.attackState === 'impact')) {
    // GABRIEL's melee telegraph is unchanged from before this batch: a
    // simple growing warning ring at the player's position.
    const m = playerMarkerPos();
    const tRemain = Math.max(0, e.attackUntil - now);
    const grow = e.attackState === 'telegraph' ? (1 - tRemain / 700) : 1;
    ctx.save();
    ctx.strokeStyle = e.attackState === 'impact' ? '#fff' : theme.warn;
    ctx.lineWidth = 3;
    ctx.globalAlpha = e.attackState === 'impact' ? 1 : 0.55 + 0.35 * Math.sin(now * 0.02);
    ctx.beginPath();
    ctx.ellipse(m.x, m.y, 50 + grow * 20, 16 + grow * 6, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // PART 8: SNIPER — red tracking LOCK box, turns yellow on LOCK COMPLETE,
  // then a short fast bolt (never a full-screen line) on FIRE.
  if (e.kind === 'sniper') {
    if (e.attackState === 'lock_red' || e.attackState === 'lock_yellow') {
      const size = 46;
      ctx.save();
      ctx.strokeStyle = e.attackState === 'lock_red' ? '#ff3b3b' : '#ffd23b';
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.65 + 0.35 * Math.sin(now * 0.018);
      ctx.strokeRect(e.lockX - size / 2, e.lockY - size / 2, size, size);
      // corner ticks for a more "targeting reticle" read
      const c = 10;
      ctx.beginPath();
      ctx.moveTo(e.lockX - size / 2, e.lockY - size / 2 + c); ctx.lineTo(e.lockX - size / 2, e.lockY - size / 2); ctx.lineTo(e.lockX - size / 2 + c, e.lockY - size / 2);
      ctx.moveTo(e.lockX + size / 2 - c, e.lockY - size / 2); ctx.lineTo(e.lockX + size / 2, e.lockY - size / 2); ctx.lineTo(e.lockX + size / 2, e.lockY - size / 2 + c);
      ctx.moveTo(e.lockX - size / 2, e.lockY + size / 2 - c); ctx.lineTo(e.lockX - size / 2, e.lockY + size / 2); ctx.lineTo(e.lockX - size / 2 + c, e.lockY + size / 2);
      ctx.moveTo(e.lockX + size / 2 - c, e.lockY + size / 2); ctx.lineTo(e.lockX + size / 2, e.lockY + size / 2); ctx.lineTo(e.lockX + size / 2, e.lockY + size / 2 - c);
      ctx.stroke();
      ctx.restore();
    } else if (e.attackState === 'fire') {
      const t = clamp(1 - (e.attackUntil - now) / SNIPER_FIRE_TRAVEL_MS, 0, 1);
      const hx = e.fireFromX + (e.fireToX - e.fireFromX) * t;
      const hy = e.fireFromY + (e.fireToY - e.fireFromY) * t;
      const tailT = Math.max(0, t - 0.35);
      const tx = e.fireFromX + (e.fireToX - e.fireFromX) * tailT;
      const ty = e.fireFromY + (e.fireToY - e.fireFromY) * tailT;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,90,70,0.95)';
      ctx.lineWidth = 3;
      ctx.shadowColor = 'rgba(255,90,70,0.8)';
      ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.restore();
    }
    return;
  }

  // PART 7: MISSILE — blinking red LOCK ▲ during PHASE1, then a filled
  // white ellipse at the frozen target ramping transparent->opaque as the
  // countdown during PHASE2 (never just a stroked outline).
  if (e.kind === 'missile') {
    if (e.attackState === 'lockon') {
      const m = playerMarkerPos();
      const blink = Math.sin(now * 0.02) > 0;
      if (blink) {
        ctx.save();
        ctx.fillStyle = '#ff3b3b';
        ctx.beginPath();
        ctx.moveTo(m.x, m.y - 34);
        ctx.lineTo(m.x - 12, m.y - 14);
        ctx.lineTo(m.x + 12, m.y - 14);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    } else if (e.attackState === 'target') {
      const progress = clamp(1 - (e.attackUntil - now) / MISSILE_TARGET_MS, 0, 1);
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,' + (progress * 0.9) + ')';
      ctx.beginPath();
      ctx.ellipse(e.missileTargetX, e.missileTargetY, 30 + progress * 28, 12 + progress * 10, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

function renderParticles() {
  const now = performance.now();
  for (const pt of state.particles) {
    if (!pt.active) continue;
    if (now > pt.until) { pt.active = false; continue; }
    // Each particle fades over its OWN lifetime (born..until), not a
    // shared fixed divisor — that mismatch previously let 'smoke' (a
    // 420ms particle) compute a negative radius and crash ctx.arc().
    const total = Math.max(1, pt.until - (pt.born || pt.until - 45));
    const fadeAlpha = clamp((pt.until - now) / total, 0, 1);
    if (pt.type === 'muzzle') {
      ctx.fillStyle = 'rgba(255,220,140,' + fadeAlpha + ')';
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2); ctx.fill();
    } else if (pt.type === 'spark') {
      // PART 3: a small burst of short radiating spark lines, gone fast —
      // "小さな火花・瞬間的に散る複数のspark・短時間で消える", not a
      // lingering glow or a big explosion.
      ctx.strokeStyle = 'rgba(255,235,180,' + fadeAlpha + ')';
      ctx.lineWidth = 2;
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + pt.x * 0.01; // cheap per-spark angle jitter
        const len = 7 + 6 * fadeAlpha;
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pt.x + Math.cos(ang) * len, pt.y + Math.sin(ang) * len);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,' + fadeAlpha + ')';
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2); ctx.fill();
    } else if (pt.type === 'explosionFlash') {
      ctx.fillStyle = 'rgba(255,255,255,' + fadeAlpha + ')';
      ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.r || 30, 0, Math.PI * 2); ctx.fill();
    } else if (pt.type === 'smoke') {
      const growProgress = 1 - fadeAlpha; // 0 at spawn -> 1 at expiry, always >= 0
      ctx.fillStyle = 'rgba(90,90,90,' + fadeAlpha * 0.35 + ')';
      ctx.beginPath(); ctx.arc(pt.x, pt.y, (pt.r || 18) * (1 + growProgress * 0.8), 0, Math.PI * 2); ctx.fill();
    }
  }
}

// PART 3: the traveling bullet itself — a short bright streak that moves
// from muzzle to target over BULLET_TRAVEL_MS, never a static full-length
// line drawn all at once.
function renderBullets() {
  const now = performance.now();
  for (const b of state.bullets) {
    if (!b.active) continue;
    const dur = Math.max(1, b.resolveAt - b.firedAt);
    const t = Math.max(0, Math.min(1, (now - b.firedAt) / dur));
    const hx = b.x1 + (b.x2 - b.x1) * t;
    const hy = b.y1 + (b.y2 - b.y1) * t;
    const tailT = Math.max(0, t - 0.22);
    const tx = b.x1 + (b.x2 - b.x1) * tailT;
    const ty = b.y1 + (b.y2 - b.y1) * tailT;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,245,210,0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath(); ctx.arc(hx, hy, 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}

function renderFlashlightMask() {
  if (darkCanvas.width !== canvas.width || darkCanvas.height !== canvas.height) {
    darkCanvas.width = canvas.width;
    darkCanvas.height = canvas.height;
  }
  darkCtx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  darkCtx.globalCompositeOperation = 'source-over';
  darkCtx.clearRect(0, 0, state.cssW, state.cssH);
  darkCtx.fillStyle = 'rgba(0,0,0,0.90)';
  darkCtx.fillRect(0, 0, state.cssW, state.cssH);

  const center = getFlashlightCenter();
  const grad = darkCtx.createRadialGradient(center.x, center.y, 0, center.x, center.y, FLASHLIGHT_BASE_RADIUS);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.7, 'rgba(0,0,0,0.85)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  darkCtx.globalCompositeOperation = 'destination-out';
  darkCtx.fillStyle = grad;
  darkCtx.beginPath();
  darkCtx.arc(center.x, center.y, FLASHLIGHT_BASE_RADIUS, 0, Math.PI * 2);
  darkCtx.fill();

  // a soft, wide ambient glow around the player so the near-ground isn't pure black
  const ambient = darkCtx.createRadialGradient(
    state.centerX, state.cssH * 0.95, 0,
    state.centerX, state.cssH * 0.95, state.cssW * 0.55
  );
  ambient.addColorStop(0, 'rgba(0,0,0,0.55)');
  ambient.addColorStop(1, 'rgba(0,0,0,0)');
  darkCtx.fillStyle = ambient;
  darkCtx.beginPath();
  darkCtx.arc(state.centerX, state.cssH * 0.95, state.cssW * 0.55, 0, Math.PI * 2);
  darkCtx.fill();

  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.drawImage(darkCanvas, 0, 0, state.cssW, state.cssH);
}

// PART 2: simple, high-visibility "+" crosshair — no circle, no gap.
function renderAimReticle() {
  const aim = getAimPoint();
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(aim.x - 11, aim.y); ctx.lineTo(aim.x + 11, aim.y);
  ctx.moveTo(aim.x, aim.y - 11); ctx.lineTo(aim.x, aim.y + 11);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------
// HUD (DOM writes only on change — no per-frame element creation)
// ---------------------------------------------------------------------

function updateHud() {
  const p = state.player;
  const pct = Math.round((p.hp / PLAYER_MAX_HP) * 100);
  if (pct !== p.lastHpFillPct) { hpFillEl.style.width = pct + '%'; p.lastHpFillPct = pct; }

  const ammoText = String(p.reloading ? '...' : p.ammo);
  if (ammoText !== p.lastAmmoText) { ammoCountEl.textContent = ammoText; p.lastAmmoText = ammoText; }
  ammoReserveEl.textContent = p.reserve;

  const stealthText = p.stealth ? 'ON' : 'OFF';
  if (stealthText !== p.lastStealthText) {
    stealthStateEl.textContent = stealthText;
    stealthReadoutEl.classList.toggle('active', p.stealth);
    p.lastStealthText = stealthText;
  }
}

// ---------------------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------------------

let lastTs = performance.now();
let rafHandle = null;

function now_() { return performance.now(); }

function frame(ts) {
  rafHandle = requestAnimationFrame(frame);
  let dt = (ts - lastTs) / 1000;
  if (!isFinite(dt) || dt < 0) dt = 0;
  dt = Math.min(dt, 0.05); // clamp huge gaps (tab switch, debugger pause)
  lastTs = ts;
  state.timeSec += dt;

  const gpInput = pollGamepad();
  state.input.moveX = gpInput.move.x !== 0 ? gpInput.move.x : touchMove.x;
  state.input.moveY = gpInput.move.y !== 0 ? gpInput.move.y : touchMove.y;
  state.input.lightX = Math.abs(gpInput.light.x) > 0.001 ? gpInput.light.x : touchLight.x;
  state.input.lightY = Math.abs(gpInput.light.y) > 0.001 ? gpInput.light.y : touchLight.y;
  state.input.aimX = Math.abs(gpInput.aim.x) > 0.001 ? gpInput.aim.x : touchAim.x;
  state.input.aimY = Math.abs(gpInput.aim.y) > 0.001 ? gpInput.aim.y : touchAim.y;
  state.input.fireHeld = gpInput.fire || touchFireHeld;

  const actions = consumeActions();
  const forwardDelta = updatePlayer(dt, ts, state.input.moveX, state.input.moveY, actions);
  applyForwardDelta(forwardDelta);
  updateEnemy(dt, ts);
  updateBullets(ts);

  if (state.input.fireHeld) fireWeapon(ts);

  const theme = THEMES[state.theme];
  renderCorridor(theme);
  renderBarrels();
  renderEnemy(theme);
  renderPlayer(theme);
  renderParticles();
  renderBullets();
  renderFlashlightMask();
  // FOLLOWUP FIX: telegraphs (LOCK boxes/▲/target ellipse/bolts) render
  // AFTER the darkness mask so they stay legible as warnings no matter
  // where the flashlight is pointed — see renderEnemyTelegraphs()'s own
  // comment for the bug this fixes.
  renderEnemyTelegraphs(theme);
  renderAimReticle();

  updateHud();

  // debug FPS (throttled DOM write)
  state.debug.frameTimes.push(ts);
  while (state.debug.frameTimes.length && ts - state.debug.frameTimes[0] > 1000) state.debug.frameTimes.shift();
  if (ts - state.debug.lastReportAt > 250) {
    state.debug.lastReportAt = ts;
    dbgFpsEl.textContent = String(state.debug.frameTimes.length);
    dbgFrameEl.textContent = (dt * 1000).toFixed(1);
    dbgStateEl.textContent = `${state.enemy.type}/${state.enemy.attackState}`;
  }
}

function start() {
  lastTs = performance.now();
  rafHandle = requestAnimationFrame(frame);
}
function stop() {
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop(); else { lastTs = performance.now(); start(); }
});

start();

window.__darkoutTps = {
  state, THEMES, ASSETS,
  // pure read-only helpers, exposed for automated testing only
  getAimPoint, getFlashlightCenter, computeEnemyDrawRect,
  isPlayerInCover, getStealthStrength, applyAimCurve, playerMarkerPos, barrels,
};
