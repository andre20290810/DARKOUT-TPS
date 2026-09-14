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
const DASH_FORWARD_IMPULSE = 1050;
const DASH_BACK_IMPULSE = 820;
const DASH_DURATION_MS = 260;
const DASH_INVINCIBLE_MS = 300;

// Player screen-space lateral movement (WEST/EAST), in CSS px/sec.
const STRAFE_SPEED = 260;
const STRAFE_DASH_IMPULSE = 340; // px, applied as an eased pulse
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
const AIM_RANGE = 190; // px, pre-clamp
const AIM_MARKER_PAD = 14; // keep the aim reticle a little inside the light edge

const FIRE_COOLDOWN_MS = 130;
const MAG_SIZE = 12;
const RESERVE_MAX = 48;
const RELOAD_MS = 950;

const PLAYER_MAX_HP = 100;

const GAMEPAD_AXIS_DEADZONE = 0.16;
const GAMEPAD_TRIGGER_THRESHOLD = 0.5;

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
    dashN: loadImg('assets/player/player_dash_north.png'),
    dashS: loadImg('assets/player/player_dash_south.png'),
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
    invincibleUntil: 0,
    stealth: false,
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
    lane: 0, // world X offset
    attackState: 'idle', // idle -> telegraph -> impact -> cooldown
    attackUntil: 0,
    nextIdleCheckAt: 0,
    kind: 'rifle', // 'rifle' | 'missile' | 'claw'
    hp: 100,
    hitFlashUntil: 0,
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
// PROJECTION
// ---------------------------------------------------------------------

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

    // sticks
    const ax = (v) => (Math.abs(v) < GAMEPAD_AXIS_DEADZONE ? 0 : v);
    gpLight.x = ax(gp.axes[0] || 0);
    gpLight.y = ax(gp.axes[1] || 0);
    gpAim.x = ax(gp.axes[2] || 0);
    gpAim.y = ax(gp.axes[3] || 0);

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
    state.enemy.kind = btn.dataset.enemy === 'gabriel' ? 'claw' : 'rifle';
    state.enemy.attackState = 'idle';
    state.enemy.z = 900;
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

  // LT/RT strafe dash (impulse, eased)
  if (actions.westDash) { p.dashDir = -1; p.dashUntil = now + DASH_DURATION_MS; p.dashStrafeStart = p.strafeOffset; p.invincibleUntil = now + DASH_INVINCIBLE_MS; }
  if (actions.eastDash) { p.dashDir = 1; p.dashUntil = now + DASH_DURATION_MS; p.dashStrafeStart = p.strafeOffset; p.invincibleUntil = now + DASH_INVINCIBLE_MS; }
  if (now < p.dashUntil) {
    const tNorm = 1 - (p.dashUntil - now) / DASH_DURATION_MS;
    const eased = 1 - Math.pow(1 - tNorm, 2);
    p.strafeOffset = Math.max(-maxOff, Math.min(maxOff, p.dashStrafeStart + p.dashDir * STRAFE_DASH_IMPULSE * eased));
  }

  // NORTH/SOUTH world scroll + player scale sync
  let forwardDelta = 0;
  if (moveY < 0) { forwardDelta += WALK_FORWARD_SPEED * dt; p.scaleTarget = 0.94; }
  else if (moveY > 0) { forwardDelta -= WALK_BACK_SPEED * dt; p.scaleTarget = 1.06; }
  else { p.scaleTarget = 1.0; }

  if (actions.northDash) { p.fwdDashSign = 1; p.fwdDashUntil = now + DASH_DURATION_MS; p.invincibleUntil = now + DASH_INVINCIBLE_MS; }
  if (actions.southDash) { p.fwdDashSign = -1; p.fwdDashUntil = now + DASH_DURATION_MS; p.invincibleUntil = now + DASH_INVINCIBLE_MS; }
  if (now < p.fwdDashUntil) {
    const impulse = p.fwdDashSign > 0 ? DASH_FORWARD_IMPULSE : -DASH_BACK_IMPULSE;
    forwardDelta += impulse * dt * 3.2; // burst over the short dash window
    p.scaleTarget = p.fwdDashSign > 0 ? 0.82 : 1.18;
  }

  p.scale += (p.scaleTarget - p.scale) * Math.min(1, dt * 10);

  // toggle STEALTH
  if (actions.stealth) p.stealth = !p.stealth;

  // FLASH — brief screen pulse (instant opacity via .firing, no transition)
  // then a plain setTimeout drops the class so the base rule's own
  // transition fades it back out. Plus: interrupts a nearby enemy's
  // telegraphed attack (reused as a stun, per DARK OUT's FLASH concept).
  if (actions.flash) {
    flashOverlayEl.classList.add('firing');
    clearTimeout(flashOverlayEl._flashTimer);
    flashOverlayEl._flashTimer = setTimeout(() => { flashOverlayEl.classList.remove('firing'); }, 90);
    if (state.enemy.attackState === 'telegraph') {
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
  const e = state.enemy;
  e.z = Math.max(ENEMY_Z_MIN, Math.min(ENEMY_Z_MAX, e.z - forwardDelta));
}

function updateEnemy(dt, now) {
  const e = state.enemy;
  const p = state.player;

  if (e.attackState === 'idle') {
    if (!e.nextIdleCheckAt) e.nextIdleCheckAt = now + 1500;
    if (now >= e.nextIdleCheckAt && e.z < 900) {
      const stealthMul = p.stealth ? 1.8 : 1.0;
      e.attackState = 'telegraph';
      e.attackUntil = now + 700 * stealthMul;
      e.kind = (e.type === 'roid2' && Math.random() < 0.35) ? 'missile' : (e.type === 'gabriel' ? 'claw' : 'rifle');
    } else if (now >= e.nextIdleCheckAt) {
      e.nextIdleCheckAt = now + 400; // too far, re-check soon without attacking
    }
  } else if (e.attackState === 'telegraph') {
    if (now >= e.attackUntil) {
      e.attackState = 'impact';
      e.attackUntil = now + 140;
      const dodged = now < p.invincibleUntil;
      if (!dodged) {
        p.hp = Math.max(0, p.hp - (e.kind === 'missile' ? 22 : e.kind === 'claw' ? 20 : 14));
        centerWarningEl.textContent = 'HIT!';
        centerWarningEl.hidden = false;
        centerWarningEl.style.color = '#ff4040';
      } else {
        centerWarningEl.textContent = 'AVOIDED';
        centerWarningEl.hidden = false;
        centerWarningEl.style.color = '#7fffb0';
      }
      setTimeout(() => { centerWarningEl.hidden = true; }, 500);
    }
  } else if (e.attackState === 'impact') {
    if (now >= e.attackUntil) {
      e.attackState = 'cooldown';
      e.attackUntil = now + 1200;
    }
  } else if (e.attackState === 'cooldown') {
    if (now >= e.attackUntil) {
      e.attackState = 'idle';
      e.nextIdleCheckAt = now + 900 + Math.random() * 1400;
    }
  }

  if (now < e.hitFlashUntil) { /* visual only, drawn in render */ }
}

function screenSpaceEnemyAnchor() {
  const proj = project(state.enemy.lane, CORRIDOR_FLOOR_Y, state.enemy.z);
  return proj;
}

// Shared by renderEnemy() and fireWeapon() so the hit-test always matches
// what's actually drawn.
function computeEnemyDrawRect() {
  const e = state.enemy;
  const proj = screenSpaceEnemyAnchor();
  const set = ASSETS[e.type];
  const img = (e.type === 'gabriel')
    ? (e.attackState === 'telegraph' ? set.windup : (e.attackState === 'impact' ? set.release : set.idle))
    : ((e.attackState === 'telegraph' || e.attackState === 'impact') ? set.fire : set.idle);

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

function fireWeapon(now) {
  const p = state.player;
  if (p.reloading || p.ammo <= 0) return;
  if (now < p.fireCooldownUntil) return;
  p.fireCooldownUntil = now + FIRE_COOLDOWN_MS;
  p.ammo -= 1;

  const muzzleX = state.centerX + p.strafeOffset;
  const muzzleY = state.cssH * 0.86;
  const aim = getAimPoint();

  spawnParticle({ type: 'muzzle', x: muzzleX, y: muzzleY - 60, until: performance.now() + 60 });
  spawnParticle({ type: 'tracer', x: muzzleX, y: muzzleY - 60, x2: aim.x, y2: aim.y, until: performance.now() + 70 });

  const rect = computeEnemyDrawRect();
  const hitRadius = Math.max(18, rect.w * 0.42);
  const dist = Math.hypot(aim.x - rect.cx, aim.y - rect.cy);
  if (dist <= hitRadius) {
    state.enemy.hitFlashUntil = performance.now() + 120;
    spawnParticle({ type: 'spark', x: aim.x, y: aim.y, until: performance.now() + 160 });
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

function renderPlayer(theme) {
  const p = state.player;
  const cx = state.centerX + p.strafeOffset;
  const bottomY = state.cssH * 1.02;
  let img = ASSETS.player.fire;
  if (p.reloading) img = ASSETS.player.aim;
  else if (state.input.fireHeld) img = ASSETS.player.fire;
  else if (p.facing === 'walk') img = ASSETS.player.walk[p.walkFrame];
  else img = ASSETS.player.aim;
  if (now_() < p.fwdDashUntil) img = p.fwdDashSign > 0 ? ASSETS.player.dashN : ASSETS.player.dashS;

  const baseScale = (state.cssH / 900) * 1.0;
  const alpha = p.stealth ? 0.42 : 1.0;

  if (p.stealth) {
    ctx.save();
    ctx.shadowColor = theme.accent;
    ctx.shadowBlur = 18;
    drawSpriteCentered(img, cx, bottomY, baseScale * p.scale, alpha);
    ctx.restore();
  } else {
    drawSpriteCentered(img, cx, bottomY, baseScale * p.scale, alpha);
  }
}

function renderEnemy(theme) {
  const e = state.enemy;
  const rect = computeEnemyDrawRect();
  const proj = rect.proj;

  const flashing = performance.now() < e.hitFlashUntil;
  ctx.save();
  if (flashing) ctx.filter = 'brightness(2.2)';
  if (imgReady(rect.img)) {
    ctx.drawImage(rect.img, rect.x, rect.y, rect.w, rect.h);
  } else {
    ctx.fillStyle = '#334';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();

  // attack telegraph marker at the PLAYER's position (per PART11 rifle spec)
  if (e.attackState === 'telegraph' || e.attackState === 'impact') {
    const p = state.player;
    const mx = state.centerX + p.strafeOffset;
    const my = state.cssH * 0.9;
    const now = performance.now();
    const tRemain = Math.max(0, e.attackUntil - now);
    const grow = e.attackState === 'telegraph' ? (1 - tRemain / 700) : 1;
    ctx.save();
    ctx.strokeStyle = e.attackState === 'impact' ? '#fff' : theme.warn;
    ctx.lineWidth = 3;
    ctx.globalAlpha = e.attackState === 'impact' ? 1 : 0.55 + 0.35 * Math.sin(now * 0.02);
    ctx.beginPath();
    ctx.ellipse(mx, my, 50 + grow * 20, 16 + grow * 6, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    if (e.kind === 'missile' && e.attackState === 'telegraph') {
      ctx.save();
      ctx.strokeStyle = '#ff4040';
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(proj.x, proj.y); ctx.lineTo(mx, my); ctx.stroke();
      ctx.restore();
    }
  }
}

function renderParticles() {
  const now = performance.now();
  for (const pt of state.particles) {
    if (!pt.active) continue;
    if (now > pt.until) { pt.active = false; continue; }
    const lifeLeft = (pt.until - now) / 60;
    if (pt.type === 'muzzle') {
      ctx.fillStyle = 'rgba(255,220,140,' + Math.max(0, lifeLeft) + ')';
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 14, 0, Math.PI * 2); ctx.fill();
    } else if (pt.type === 'tracer') {
      ctx.strokeStyle = 'rgba(255,240,200,' + Math.max(0, lifeLeft) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(pt.x, pt.y); ctx.lineTo(pt.x2, pt.y2); ctx.stroke();
    } else if (pt.type === 'spark') {
      ctx.strokeStyle = 'rgba(255,255,255,' + Math.max(0, lifeLeft) + ')';
      ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pt.x + Math.cos(ang) * 12, pt.y + Math.sin(ang) * 12);
        ctx.stroke();
      }
    }
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

function renderAimReticle() {
  const aim = getAimPoint();
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(aim.x, aim.y, 9, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(aim.x - 14, aim.y); ctx.lineTo(aim.x - 4, aim.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(aim.x + 4, aim.y); ctx.lineTo(aim.x + 14, aim.y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(aim.x, aim.y - 14); ctx.lineTo(aim.x, aim.y - 4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(aim.x, aim.y + 4); ctx.lineTo(aim.x, aim.y + 14); ctx.stroke();
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

  if (state.input.fireHeld) fireWeapon(ts);

  const theme = THEMES[state.theme];
  renderCorridor(theme);
  renderEnemy(theme);
  renderPlayer(theme);
  renderParticles();
  renderFlashlightMask();
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
};
