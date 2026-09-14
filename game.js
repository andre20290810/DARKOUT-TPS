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
const ENEMY_Z_MAX = 1500;
// 2ND-ROUND PART 4: max-approach distance is now PER ENEMY TYPE instead of
// one shared ENEMY_Z_MIN=70 floor — the old shared floor let the player
// walk up until a giant ROID mech's own closeBoost/anchor-crop math
// overflowed the screen entirely (way oversized, not "just barely fits").
// ROID1/ROID2 (giant mechs): always fully visible, foot-anchored, and the
// approach floor is SOLVED per-frame from the current viewport height (see
// approachZMinForRoid()) rather than a fixed world-z constant, so "whole
// body just inside frame" holds on any device, not just the one this was
// eyeballed on. GABRIEL (human-scale): allowed to approach much closer,
// reusing round 1's existing closeBoost/anchor-crop formula UNCHANGED
// (that formula already does "get close -> frame shifts toward the upper
// body" correctly) — only ITS OWN zMin/world-height are new this round.
// (145, not something smaller: round 1's closeBoost formula reaches its
// OWN fixed maximum multiplier — 2.17x — at any zMin, since distNorm is
// self-relative to zMin; so zMin alone controls how much on-screen height
// that maximum boost lands on, via proj.scale(zMin). 145 was picked so the
// closest approach reads as "clearly, dramatically close — upper body
// fills most of the frame" without overflowing so far past the viewport
// that it looks broken, while staying well inside — i.e. reachable before
// — ROID's own ~247 floor (a live, viewport-height-solved value; see
// approachZMinForRoid()), satisfying "GABRIELの方がROIDより近づける".)
const GABRIEL_Z_MIN = 145;
const ENEMY_Z_ABS_FLOOR = 15; // safety floor under the dynamic ROID solve, never actually reached in practice
// Enemy sprite height expressed in the SAME world-unit space the corridor
// projection uses (see project()), so proj.scale converts it to pixels
// consistently with everything else on screen — NOT the source image's own
// pixel height, which would double up with proj.scale and blow up the size.
// ROID (giant mech) and GABRIEL (human-scale) now get their OWN target
// height — previously both shared one ENEMY_WORLD_HEIGHT=700, which made
// GABRIEL exactly as "big" as the giant ROID mechs; PART 4 explicitly asks
// for GABRIEL to read closer to human scale.
const ROID_WORLD_HEIGHT = 700; // unchanged value from round 1 (was ENEMY_WORLD_HEIGHT)
const GABRIEL_WORLD_HEIGHT = 480;
const ROID_FULLBODY_SCREEN_FRAC = 0.92; // PART4: ROID's own max-approach target — whole body still just inside frame

// PART 2: ROID1/ROID2 5-zone facing (farLeft/left/center/right/farRight),
// replacing round 1's coarse east/west-only flip. NEAR/FAR/HYST are this
// game's own screen-space tuning (ACTION-GAME's own real
// ROID_FACE_ZONE_PX/FAR_PX/HYST_PX values of 60/120/20 are a different
// game's canvas-coordinate scale — not directly portable — but the same
// order of magnitude was kept since DARKOUT-TPS's own pre-existing
// ENEMY_TURN_HYSTERESIS_PX=36 single-boundary constant was tuned for this
// exact canvas and is in the same range).
const ROID_FACE_ZONE_NEAR_PX = 60;
const ROID_FACE_ZONE_FAR_PX = 120;
const ROID_FACE_ZONE_HYST_PX = 20;

// PART 3: ROID's FIRE pose is a non-directional 4-frame ping-pong
// animation (matches ACTION-GAME's own real ROID1_SPRITES/ROID2_SPRITES —
// investigated directly: its FIRE frames are NOT zone-specific, only
// SEARCH is), gated on an actual shot having just been fired — not on
// being merely "in an attack state" the whole time. Values copied verbatim
// from ACTION-GAME's own real ROID_FIRE_FRAME_MS/ROID_ATTACK_POSE_HOLD_MS
// constants (game.js ~L5023/5038).
const ROID_FIRE_FRAME_MS = 110;
const ROID_ATTACK_POSE_HOLD_MS = ROID_FIRE_FRAME_MS * 4;

// Flashlight / aim / view.
// 2ND-ROUND PART 6/8: RIGHT STICK now drives ONE unified "view" point — the
// flashlight beam AND the aim reticle sit at the exact same spot (spec:
// "右スティックは今後、照準を合わせる/視界を操作するための入力として扱います").
// VIEW_RANGE replaces the old separate FLASHLIGHT_STICK_RANGE (was LEFT
// STICK, linear) / AIM_RANGE (was RIGHT STICK, curved) split — max reach is
// kept the same magnitude both previously used (190px) so the beam/reticle
// still sweeps the same distance at full deflection; the whole point moves
// through applyAimCurve() now, and LEFT STICK is fully freed for MOVE.
const FLASHLIGHT_BASE_RADIUS = 150;
const VIEW_RANGE = 190; // px, pre-clamp — max sweep at full stick deflection

// FOLLOWUP FIX (AIM was too twitchy for fine target lock): deadzone is
// intentionally the SAME as MOVE's (never shrunk — a smaller deadzone
// invites stick drift, which the spec explicitly warns against). What
// changes is a response curve applied only to the RIGHT STICK (which now
// drives BOTH the flashlight/view direction and the aim reticle — PART 6 of
// the 2nd-round spec merges "視界操作" and "AIM" into one stick): output =
// sign(x) * |x|^AIM_CURVE_POWER. At x=1 (full deflection) output is still 1
// — max reach/max sweep speed is preserved — but small nudges are dulled
// far more aggressively than the 1st-round curve (power raised from 2.2 to
// 2.6: at x=0.5, output now drops to ~0.5^2.6≈0.165, vs ~0.22 before).
// MOVE (LEFT STICK/D-PAD) is untouched (its own deadzone/curve below is the
// original linear one).
const AIM_DEADZONE = 0.16;
const AIM_CURVE_POWER = 2.6;

const FIRE_COOLDOWN_MS = 130;
const MAG_SIZE = 12;
const RESERVE_MAX = 48;
const RELOAD_MS = 950;
// FOLLOWUP FIX (PART 3): the player's own shot is a fast traveling bullet
// resolved on arrival, not an instant full-length line.
const BULLET_TRAVEL_MS = 55;

const PLAYER_MAX_HP = 100;
// PART 5 (2nd round): a moderate visual size bump only — leaning toward
// the original "waist-up TPS presence" intent without overwhelming AIM/
// enemy visibility. There is no separate player hit/collision-radius
// constant in this game (damage is resolved via enemy attack-phase
// judgment, not player-sprite distance checks), so this scale change has
// nothing coupled to it that would need a matching, unrequested gameplay
// change.
const PLAYER_SCALE_BOOST = 1.18;

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
// 2ND-ROUND PART 1: the barrel was rendered far too large — at its closest
// (drawH = 300 * proj.scale, proj.scale up to ~0.87 near the camera) it hit
// ~260px tall, well OVER the player's own ~147px on-screen height (a drum
// can was visually bigger than the protagonist). BARREL_DRAW_H is the new
// world-scale "height" the barrel targets (down from the old hardcoded
// 300), tuned so it never exceeds the player's own apparent height even at
// the closest reachable distance (Z_NEAR=40 -> drawH ≈ 112px < ~147px) while
// still reading as "a drum can a person can crouch behind" at typical COVER
// range (z=COVER_BARREL_Z_MAX -> drawH ≈ 60px). COVER_RADIUS_PX is scaled
// down by the exact same ratio (130/300≈0.43->150/300=0.5) as BARREL_DRAW_H
// so the visible shadow/footprint and the actual COVER ZONE judgment never
// drift apart after the resize (spec: "見た目とcover判定範囲が大きく乖離
// しないよう調整").
const BARREL_DRAW_H = 150; // was 300 (inline) — see comment above
const COVER_RADIUS_PX = 36; // was 72 — same 0.5x ratio as BARREL_DRAW_H
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

// 2ND-ROUND PART 2/3: ROID1/ROID2 direction-specific SEARCH art (5 frames
// each) and non-directional FIRE ping-pong art (4 frames each), copied
// read-only from ACTION-GAME's real assets/characters/roid{1,2}/ directory
// — not guessed or generated. bodyTopFrac/bodyBottomFrac are ACTION-GAME's
// OWN real per-frame alpha-channel-measured body bounds (copied verbatim
// from its ROID1_SPRITES/ROID2_SPRITES definitions, game.js ~L4937-4973) —
// reused here so a frame's own canvas padding (they vary a lot: e.g.
// roid1_search_05.png is a 1280x2427 canvas where the body itself only
// fills a portion) never desyncs the on-screen body height between frames,
// the same problem ACTION-GAME's own computeBodyVisualScale() exists to
// solve — see spriteFrame()/computeRoidBodyScale() below.
function spriteFrame(src, bodyTopFrac, bodyBottomFrac) {
  return { img: loadImg(src), bodyTopFrac, bodyBottomFrac };
}

const ROID1_SPRITES = {
  search: [
    spriteFrame('assets/roid1/roid1_search_01.png', 0.0016, 0.9984),
    spriteFrame('assets/roid1/roid1_search_02.png', 0.0016, 0.9984),
    spriteFrame('assets/roid1/roid1_search_03.png', 0.0011, 0.9977),
    spriteFrame('assets/roid1/roid1_search_04.png', 0.0023, 0.9977),
    spriteFrame('assets/roid1/roid1_search_05.png', 0.0012, 0.9979),
  ],
  fire: [
    spriteFrame('assets/roid1/roid1_fire_01.png', 0.0023, 0.9984),
    spriteFrame('assets/roid1/roid1_fire_02.png', 0.0023, 0.9984),
    spriteFrame('assets/roid1/roid1_fire_03.png', 0.0023, 0.9984),
    spriteFrame('assets/roid1/roid1_fire_04.png', 0.0023, 0.9984),
  ],
};
const ROID2_SPRITES = {
  search: [
    spriteFrame('assets/roid2/roid2_search_01.png', 0.0031, 0.9984),
    spriteFrame('assets/roid2/roid2_search_02.png', 0.0031, 0.9977),
    spriteFrame('assets/roid2/roid2_search_03.png', 0.0023, 0.9977),
    spriteFrame('assets/roid2/roid2_search_04.png', 0.0031, 0.9984),
    spriteFrame('assets/roid2/roid2_search_05.png', 0.0031, 0.9969),
  ],
  fire: [
    spriteFrame('assets/roid2/roid2_fire_01.png', 0.0556, 0.9802),
    spriteFrame('assets/roid2/roid2_fire_02.png', 0.1091, 0.9286),
    spriteFrame('assets/roid2/roid2_fire_03.png', 0.0734, 0.9593),
    spriteFrame('assets/roid2/roid2_fire_04.png', 0.0853, 0.9831),
  ],
};
// zone -> search-frame-index, copied verbatim from ACTION-GAME's own
// ROID1_FACE_FRAME/ROID2_FACE_FRAME (game.js ~L5059-5060) — both bosses
// share the same zone->index layout in the reference game.
const ROID_FACE_FRAME = { farRight: 0, right: 1, center: 2, left: 3, farLeft: 4 };

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
  roid1: ROID1_SPRITES,
  roid2: ROID2_SPRITES,
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
    facing: 'east',   // GABRIEL ONLY — 'east' | 'west', which way the sprite mirrors
    // PART 2 (2nd round): ROID1/ROID2's own 5-zone facing, hysteresis-held
    // one step at a time — replaces the old 2-state east/west flip for
    // these types (real direction-specific art now exists, see
    // ROID1_SPRITES/ROID2_SPRITES, so no canvas mirroring is needed).
    zone: 'center',   // 'farLeft' | 'left' | 'center' | 'right' | 'farRight'
    lastTurnAt: -Infinity,
    attackState: 'idle', // per-kind phase name; see updateEnemy() for the full list
    attackUntil: 0,
    nextIdleCheckAt: 0,
    kind: 'sniper',   // 'sniper' | 'missile' | 'claw'
    hp: 100,
    hitFlashUntil: 0,
    // PART 3 (2nd round): ROID's own NORMAL<->FIRE animation state — the
    // FIRE pose ping-pongs through its 4 frames only while actively firing
    // (see isRoidActivelyFiring()/updateRoidAnimation()), gated on
    // lastShotFiredAt (stamped at the real moment a shot exists — SNIPER's
    // FIRE-phase bolt spawn — not for the whole attack-state span).
    roidFireFrame: 0, roidFireDir: 1, roidFireFrameElapsedMs: 0,
    lastShotFiredAt: -Infinity,
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
    // PART 6/8 (2nd round): flashlight aim + reticle aim are now ONE
    // unified "view" input driven by the RIGHT STICK (see getFlashlightCenter/
    // getAimPoint) — the old separate lightX/lightY + aimX/aimY pair is gone.
    viewX: 0, viewY: 0,
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
      // vx/vy default to 0 (most particle types don't move) — explicit so
      // a pool slot previously used by a velocity-carrying 'ishard'
      // particle (PART 9, 2nd round) never leaves stale motion on a
      // later, unrelated particle that reuses the same slot.
      Object.assign(p, { vx: 0, vy: 0 }, cfg, { active: true });
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
  const gpView = { x: 0, y: 0 };
  let gpFire = false;

  if (gp) {
    const b = gp.buttons;
    const prev = state.prevButtons;
    const pressed = (i) => !!(b[i] && b[i].pressed);
    const edge = (i) => pressed(i) && !prev[i];

    // 2ND-ROUND PART 8: button remap.
    // LEFT STICK + D-PAD -> MOVE (both usable interchangeably, summed then
    // clamped to a unit vector — the same "shared pipeline" pattern D-PAD
    // already used ALONE before this batch).
    if (pressed(14)) gpMove.x -= 1; // D-PAD left
    if (pressed(15)) gpMove.x += 1; // D-PAD right
    if (pressed(12)) gpMove.y -= 1; // D-PAD up = north/forward
    if (pressed(13)) gpMove.y += 1; // D-PAD down = south/back
    const ax = (v) => (Math.abs(v) < GAMEPAD_AXIS_DEADZONE ? 0 : v);
    gpMove.x += ax(gp.axes[0] || 0);
    gpMove.y += ax(gp.axes[1] || 0);
    const moveMag = Math.hypot(gpMove.x, gpMove.y);
    if (moveMag > 1) { gpMove.x /= moveMag; gpMove.y /= moveMag; }

    // RIGHT STICK -> unified VIEW (flashlight + aim reticle, PART 6/8) —
    // deadzone (never shrunk) then the response curve so small nudges move
    // the view far less while full deflection still reaches the same max
    // sweep speed as before.
    gpView.x = applyAimCurve(gp.axes[2] || 0);
    gpView.y = applyAimCurve(gp.axes[3] || 0);

    gpFire = pressed(5);                            // RB = FIRE
    if (edge(4)) state.actions.flash = true;         // LB = FLASH
    if (edge(3)) state.actions.northDash = true;      // Y = NORTH DASH
    if (edge(2)) state.actions.westDash = true;       // X = WEST DASH
    if (edge(1)) state.actions.eastDash = true;       // B = EAST DASH
    if (edge(0)) state.actions.southDash = true;      // A = SOUTH DASH / BACKSTEP
    // LT(6) + RT(7) held SIMULTANEOUSLY -> STEALTH. Rising-edge on the AND
    // condition itself (never LT alone, never RT alone, and never re-fires
    // on every frame both stay held — a latch, not a hold-to-toggle).
    const bothTriggersHeld = pressed(6) && pressed(7);
    const bothTriggersHeldPrev = !!prev[6] && !!prev[7];
    if (bothTriggersHeld && !bothTriggersHeldPrev) state.actions.stealth = true;
    // RELOAD isn't named anywhere in the 2nd-round button spec (every
    // face/shoulder/trigger button is now spoken for by MOVE/AIM/DASH/FIRE/
    // FLASH/STEALTH) — left stick click (L3) is the one remaining unused
    // standard-mapping button, so RELOAD moves there rather than being
    // silently dropped. Touch's own RELOAD button is unaffected.
    if (edge(10)) state.actions.reload = true;        // L3 = RELOAD

    const nextPrev = new Array(b.length);
    for (let i = 0; i < b.length; i++) nextPrev[i] = pressed(i);
    state.prevButtons = nextPrev;
  } else {
    state.prevButtons = [];
  }

  return { move: gpMove, view: gpView, fire: gpFire };
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
    state.enemy.zone = 'center';
    state.enemy.lastTurnAt = -Infinity;
    state.enemy.roidFireFrame = 0;
    state.enemy.roidFireDir = 1;
    state.enemy.roidFireFrameElapsedMs = 0;
    state.enemy.lastShotFiredAt = -Infinity;
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

// PART 4 (2nd round): the closest world-z ROID1/ROID2 can ever be pushed to
// — solved from the CURRENT viewport height so "whole body just inside
// frame" holds on any device, rather than a fixed world-z constant that
// would only happen to look right on the one screen this was eyeballed on.
// drawH for ROID at any z is ROID_WORLD_HEIGHT*proj.scale (see
// computeEnemyDrawRect() — ROID is always foot-anchored/never cropped), so
// this simply solves that same formula for the z where drawH ==
// ROID_FULLBODY_SCREEN_FRAC * cssH.
function approachZMinForRoid() {
  const targetH = ROID_FULLBODY_SCREEN_FRAC * state.cssH;
  const neededScale = targetH / ROID_WORLD_HEIGHT;
  const z = FOCAL * (1 / Math.max(0.001, neededScale) - 1);
  return clamp(z, ENEMY_Z_ABS_FLOOR, ENEMY_Z_MAX);
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
  // PART 4: per-type max-approach floor — ROID1/ROID2 (giant mechs) stop
  // much farther out than GABRIEL (human-scale), see the constants above.
  const zMin = e.type === 'gabriel' ? GABRIEL_Z_MIN : approachZMinForRoid();
  e.z = Math.max(zMin, Math.min(ENEMY_Z_MAX, e.z - forwardDelta));
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

// Facing/turning — a slow, deliberate "heavy mech" turn, not an instant
// flip; the flip itself is rate-limited by ENEMY_TURN_COOLDOWN_MS either
// way. Lane drift is a slow bias toward the player's general side, never a
// fast strafe — the mech shifts weight, it doesn't sidestep.
function updateEnemyFacing(dt, now) {
  const e = state.enemy;
  const proj = project(e.lane, CORRIDOR_FLOOR_Y, e.z);
  const playerScreenX = state.centerX + state.player.strafeOffset;
  const diff = playerScreenX - proj.x;

  if (e.type === 'gabriel') {
    // GABRIEL — unchanged from round 1: simple 2-state east/west flip.
    let desired = e.facing;
    if (diff > ENEMY_TURN_HYSTERESIS_PX) desired = 'east';
    else if (diff < -ENEMY_TURN_HYSTERESIS_PX) desired = 'west';
    if (desired !== e.facing && now - e.lastTurnAt > ENEMY_TURN_COOLDOWN_MS) {
      e.facing = desired;
      e.lastTurnAt = now;
    }
  } else {
    // PART 2 (2nd round): ROID1/ROID2 — 5-zone hysteresis-held facing,
    // stepping only ONE zone at a time (never jumps straight from farLeft
    // to farRight), the same "single-step-per-frame hysteresis" shape
    // ACTION-GAME's own real updateRoidTargetTracking() uses for its
    // facingZone (game.js ~L7658-7683), adapted to this game's own
    // screen-space diff (the same value the old 2-zone version already
    // computed the exact same way).
    let zone = e.zone;
    const NEAR = ROID_FACE_ZONE_NEAR_PX, FAR = ROID_FACE_ZONE_FAR_PX, HYST = ROID_FACE_ZONE_HYST_PX;
    if (zone === 'center') {
      if (diff > NEAR) zone = 'right';
      else if (diff < -NEAR) zone = 'left';
    } else if (zone === 'right') {
      if (diff > FAR) zone = 'farRight';
      else if (diff < NEAR - HYST) zone = 'center';
    } else if (zone === 'farRight') {
      if (diff < FAR - HYST) zone = 'right';
    } else if (zone === 'left') {
      if (diff < -FAR) zone = 'farLeft';
      else if (diff > -(NEAR - HYST)) zone = 'center';
    } else if (zone === 'farLeft') {
      if (diff > -(FAR - HYST)) zone = 'left';
    }
    if (zone !== e.zone && now - e.lastTurnAt > ENEMY_TURN_COOLDOWN_MS) {
      e.zone = zone;
      e.lastTurnAt = now;
    }
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

// PART 3 (2nd round): is ROID currently within its post-shot FIRE-pose hold
// window? Matches ACTION-GAME's own real isRoidActivelyFiring() — gated on
// the actual shot-fired timestamp, not on "attackState is any attack-ish
// value" (which is what made the OLD static single fire-image swap show
// for the entire lock/fire/impact span, including during MISSILE attacks
// where the real reference game never swaps to FIRE at all).
function isRoidActivelyFiring(now) {
  return (now - state.enemy.lastShotFiredAt) < ROID_ATTACK_POSE_HOLD_MS;
}

// Ping-pong index/direction stepper — bounces 0->last->0 instead of
// wrapping, matching ACTION-GAME's own real stepPingPong() (game.js
// ~L7602-7609), used here for ROID's FIRE frame cycling.
function stepPingPong(index, dir, len) {
  if (len <= 1) return { index: 0, dir: 1 };
  let next = index + dir;
  let nextDir = dir;
  if (next >= len) { next = len - 2 >= 0 ? len - 2 : 0; nextDir = -1; }
  else if (next < 0) { next = Math.min(1, len - 1); nextDir = 1; }
  return { index: next, dir: nextDir };
}

function updateRoidAnimation(dt, now) {
  const e = state.enemy;
  if (e.type !== 'roid1' && e.type !== 'roid2') return;
  if (isRoidActivelyFiring(now)) {
    e.roidFireFrameElapsedMs += dt * 1000;
    if (e.roidFireFrameElapsedMs >= ROID_FIRE_FRAME_MS) {
      e.roidFireFrameElapsedMs = 0;
      const step = stepPingPong(e.roidFireFrame, e.roidFireDir, ASSETS[e.type].fire.length);
      e.roidFireFrame = step.index;
      e.roidFireDir = step.dir;
    }
  } else {
    e.roidFireFrame = 0; e.roidFireDir = 1; e.roidFireFrameElapsedMs = 0;
  }
}

function updateEnemy(dt, now) {
  const e = state.enemy;
  const p = state.player;

  updateEnemyFacing(dt, now);
  updateRoidAnimation(dt, now);

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
          // PART 3 (2nd round): this is the real "a shot now exists"
          // instant (matches ACTION-GAME's own fireRoidSniperBullet(), the
          // exact moment it stamps roidState.lastShotFiredAt) — triggers
          // the NORMAL<->FIRE ping-pong for ROID1/ROID2 only.
          if (e.type !== 'gabriel') e.lastShotFiredAt = now;
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

// PART 2/3/4 (2nd round): per-frame body-height normalization for
// ROID1/ROID2 — mirrors ACTION-GAME's own real computeBodyVisualScale(),
// so a frame's own canvas padding (varies a lot between the 9 real source
// images) never desyncs the on-screen body height between zones/poses.
function computeBodyVisualScale(frame, targetBodyHeightPx) {
  const bodyHeightPx = (frame.bodyBottomFrac - frame.bodyTopFrac) * frame.img.naturalHeight;
  return bodyHeightPx > 0 ? targetBodyHeightPx / bodyHeightPx : 1;
}

// Shared by renderEnemy() and fireWeapon() so the hit-test always matches
// what's actually drawn.
function computeEnemyDrawRect() {
  const e = state.enemy;
  const proj = screenSpaceEnemyAnchor();

  if (e.type === 'gabriel') {
    // GABRIEL: round-1's existing crop-toward-upper-body approach shape is
    // UNCHANGED (it already does "get close -> frame shifts to the upper
    // body" correctly) — PART 4 only retunes GABRIEL's OWN zMin/world
    // height (see GABRIEL_Z_MIN/GABRIEL_WORLD_HEIGHT), not this formula.
    const set = ASSETS.gabriel;
    const img = e.attackState === 'telegraph' ? set.windup : (e.attackState === 'impact' ? set.release : set.idle);
    const distNorm = 1 - (e.z - GABRIEL_Z_MIN) / (ENEMY_Z_MAX - GABRIEL_Z_MIN);
    const closeBoost = 1 + Math.max(0, distNorm - 0.55) * 2.6;
    const drawH = GABRIEL_WORLD_HEIGHT * proj.scale * closeBoost;
    const aspect = imgReady(img) ? img.naturalWidth / img.naturalHeight : 0.72;
    const drawW = drawH * aspect;
    const closeT = Math.max(0, Math.min(1, (distNorm - 0.5) / 0.5));
    const anchorFrac = 1.0 - closeT * 0.45;
    const drawBottomY = proj.y + (1 - anchorFrac) * drawH;
    const drawX = proj.x - drawW / 2;
    const drawTopY = drawBottomY - drawH;
    return { img, proj, x: drawX, y: drawTopY, w: drawW, h: drawH, cx: proj.x, cy: drawTopY + drawH * 0.42 };
  }

  // PART 2/3: ROID1/ROID2 — real direction-specific SEARCH art selected by
  // 5-zone facing, or the non-directional FIRE ping-pong while a shot is
  // actively being fired (matches ACTION-GAME's own real behavior — see
  // the ROID1_SPRITES/ROID2_SPRITES comment). Always foot-anchored, full
  // body, never cropped (PART 4: stays that way all the way down to this
  // type's own approachZMinForRoid() floor).
  const sprites = ASSETS[e.type];
  const zoneIndex = ROID_FACE_FRAME[e.zone] != null ? ROID_FACE_FRAME[e.zone] : 2;
  const frame = isRoidActivelyFiring(performance.now()) ? sprites.fire[e.roidFireFrame] : sprites.search[zoneIndex];
  const img = frame.img;

  const targetBodyHeightPx = ROID_WORLD_HEIGHT * proj.scale;
  const ready = imgReady(img);
  const scale = ready ? computeBodyVisualScale(frame, targetBodyHeightPx) : targetBodyHeightPx / 900;
  const nativeW = ready ? img.naturalWidth : 640;
  const nativeH = ready ? img.naturalHeight : 900;
  const w = nativeW * scale;
  const h = nativeH * scale;
  const dx = proj.x - w / 2;
  const dy = proj.y - frame.bodyBottomFrac * h;

  return {
    img, proj, x: dx, y: dy, w, h, cx: proj.x,
    cy: dy + h * ((frame.bodyTopFrac + frame.bodyBottomFrac) / 2),
  };
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

// Shared by updateBullets() (real hit resolution) and renderAimReticle()
// (PART 7's crosshair preview) so the crosshair's white->red feedback
// always matches an ACTUAL registered hit, never a guessed narrower zone.
// ROID1/ROID2 have no distinguished "weak point" separate from the general
// body hit region in the real ACTION-GAME reference either (confirmed by
// investigation — only GABRIEL has a real weak-point concept there, the
// eye, and it depends on ACTION-GAME's own DEFENSE-pose system that
// DARKOUT-TPS's GABRIEL doesn't implement), so this one shared region is
// used for all 3 enemy types rather than inventing an unfounded narrower
// hitbox for any of them.
function enemyHitRadius(rect) {
  return Math.max(18, rect.w * 0.42);
}

// PART 9 (2nd round): the player's own bullet impact — small radiating
// debris particles that actually TRAVEL outward from the hit point (see
// updateParticles()), never a fixed set of lines redrawn from the same
// static point every frame (that fixed-symmetric redraw is exactly what
// read as an "＊" glyph). Kept as its own particle type/spawn path
// (distinct from 'spark', which resolveSniperImpact()/resolveMissileImpact()
// still use unchanged — PART 11 explicitly keeps those "爆発" as-is).
function spawnPlayerImpact(x, y, now) {
  spawnParticle({ type: 'ihit', x, y, r: 9, born: now, until: now + 70 });
  const n = 5 + Math.floor(Math.random() * 3); // 5-7, never the same shape twice
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const speed = 55 + Math.random() * 95;
    spawnParticle({
      type: 'ishard', x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
      born: now, until: now + 110 + Math.random() * 70,
    });
  }
  if (Math.random() < 0.45) {
    spawnParticle({ type: 'smoke', x, y, r: 7, born: now, until: now + 220 });
  }
}

function updateBullets(now) {
  for (const b of state.bullets) {
    if (!b.active) continue;
    if (now < b.resolveAt) continue;
    b.active = false;
    const rect = computeEnemyDrawRect();
    const hitRadius = enemyHitRadius(rect);
    const dist = Math.hypot(b.x2 - rect.cx, b.y2 - rect.cy);
    if (dist <= hitRadius) {
      state.enemy.hitFlashUntil = now + 120;
      spawnPlayerImpact(b.x2, b.y2, now);
    }
  }
}

// PART 9: advances the velocity-carrying 'ishard' debris particles each
// frame (light drag so they scatter and settle rather than fly forever).
// Every other particle type is purely alpha/size-animated in place and has
// no vx/vy, so this is a no-op for them.
function updateParticles(dt) {
  for (const pt of state.particles) {
    if (!pt.active || (!pt.vx && !pt.vy)) continue;
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.vx *= 0.92;
    pt.vy *= 0.92;
  }
}

// 2ND-ROUND PART 6/8: the RIGHT STICK's curved output (state.input.viewX/Y,
// see pollGamepad()) is the single source of truth for where the player is
// looking — the flashlight beam is centered exactly there, and the aim
// reticle sits at the exact same point (see getAimPoint() below). There is
// no more independent flashlight-anchor stick.
function getFlashlightCenter() {
  const vx = clampAxis(state.input.viewX) * VIEW_RANGE;
  const vy = clampAxis(state.input.viewY) * VIEW_RANGE;
  return { x: state.centerX + vx, y: state.horizonY + state.cssH * 0.06 + vy };
}
function clampAxis(v) { return Math.max(-1, Math.min(1, v)); }

function getAimPoint() {
  // Aim = view. Kept as its own named function (rather than inlining
  // getFlashlightCenter() at every call site) since fireWeapon(), the
  // crosshair renderer, and the test API all call it under this name.
  return getFlashlightCenter();
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
    const drawH = BARREL_DRAW_H * proj.scale;
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

  // PART 5 (2nd round): the player reads a bit bigger now, leaning toward
  // the original "腰から上を中心に表示するTPS" intent — PLAYER_SCALE_BOOST
  // is the ONLY new factor here; nothing about AIM/hit-test/cover geometry
  // reads this value (there is no player collision-radius constant in this
  // game to begin with, so there is nothing coupled to accidentally
  // over-scale alongside the sprite).
  const baseScale = (state.cssH / 900) * PLAYER_SCALE_BOOST;
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

  // GABRIEL ONLY: face whichever side the player is actually on instead of
  // a permanent EAST-facing pose — mirrored around the sprite's own center.
  // ROID1/ROID2 no longer mirror at all (PART 2, 2nd round): real
  // direction-specific art (see ROID1_SPRITES/ROID2_SPRITES) already shows
  // the correct facing per zone, so flipping it would be wrong twice over.
  const flashing = now < e.hitFlashUntil;
  ctx.save();
  if (flashing) ctx.filter = 'brightness(2.2)';
  if (e.type === 'gabriel' && e.facing === 'west') {
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
    } else if (pt.type === 'ihit') {
      // PART 9 (2nd round): a short, bright, instant flash at the impact
      // core — "金属片が一瞬爆ぜた" — never a symmetric fixed-line burst.
      ctx.fillStyle = 'rgba(255,255,255,' + fadeAlpha + ')';
      ctx.beginPath(); ctx.arc(pt.x, pt.y, (pt.r || 9) * (0.4 + fadeAlpha * 0.6), 0, Math.PI * 2); ctx.fill();
    } else if (pt.type === 'ishard') {
      // PART 9: each debris particle genuinely TRAVELS along its own
      // random vx/vy (see updateParticles()) and is drawn as a short
      // motion-streak trailing behind its current position — never
      // redrawn as a fixed set of lines from one static point (that fixed
      // symmetry is what read as an "＊" glyph).
      const speed = Math.hypot(pt.vx, pt.vy);
      const trail = Math.min(9, speed * 0.05 + 1.5);
      const ang = Math.atan2(pt.vy, pt.vx);
      ctx.strokeStyle = 'rgba(255,225,150,' + fadeAlpha + ')';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(pt.x - Math.cos(ang) * trail, pt.y - Math.sin(ang) * trail);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
    }
  }
}

// PART 10 (2nd round): the traveling bullet as a perspective light-bolt —
// thick/bright near the muzzle (t≈0, still close to the camera), tapering
// to a thin/faint streak as it travels toward the target (t≈1, receding
// into the depth of the corridor) — "奥へ進む→細くなる". A soft wide glow
// underneath a narrower bright core, plus a short fading tail; never a
// fixed-width straight line, and never a full-length static bar (still
// only a short moving segment, resolved over BULLET_TRAVEL_MS).
const BULLET_WIDTH_NEAR = 4.5;
const BULLET_WIDTH_FAR = 1.2;
function renderBullets() {
  const now = performance.now();
  for (const b of state.bullets) {
    if (!b.active) continue;
    const dur = Math.max(1, b.resolveAt - b.firedAt);
    const t = Math.max(0, Math.min(1, (now - b.firedAt) / dur));
    const hx = b.x1 + (b.x2 - b.x1) * t;
    const hy = b.y1 + (b.y2 - b.y1) * t;
    const tailT = Math.max(0, t - 0.24);
    const tx = b.x1 + (b.x2 - b.x1) * tailT;
    const ty = b.y1 + (b.y2 - b.y1) * tailT;
    const width = BULLET_WIDTH_NEAR + (BULLET_WIDTH_FAR - BULLET_WIDTH_NEAR) * t;

    ctx.save();
    ctx.lineCap = 'round';
    // soft outer glow, fading toward the tail
    const glowGrad = ctx.createLinearGradient(tx, ty, hx, hy);
    glowGrad.addColorStop(0, 'rgba(255,225,150,0)');
    glowGrad.addColorStop(1, 'rgba(255,230,160,0.5)');
    ctx.strokeStyle = glowGrad;
    ctx.lineWidth = width * 2.4;
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
    // bright core
    const coreGrad = ctx.createLinearGradient(tx, ty, hx, hy);
    coreGrad.addColorStop(0, 'rgba(255,255,255,0)');
    coreGrad.addColorStop(1, 'rgba(255,255,255,0.95)');
    ctx.strokeStyle = coreGrad;
    ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath(); ctx.arc(hx, hy, Math.max(1, width * 0.7), 0, Math.PI * 2); ctx.fill();
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
// PART 7 (2nd round): "+" is now smaller, and turns white->red whenever it
// sits over a spot that would register as a real hit — reusing the EXACT
// SAME hit region enemyHitRadius()/computeEnemyDrawRect() already resolve
// bullets against (see enemyHitRadius()'s own comment for why no separate,
// unfounded "weak point" hitbox is invented for any of the 3 enemy types).
function isAimOnEffectiveHit() {
  const aim = getAimPoint();
  const rect = computeEnemyDrawRect();
  return Math.hypot(aim.x - rect.cx, aim.y - rect.cy) <= enemyHitRadius(rect);
}
function renderAimReticle() {
  const aim = getAimPoint();
  const hot = isAimOnEffectiveHit();
  ctx.save();
  ctx.strokeStyle = hot ? 'rgba(255,70,60,0.95)' : 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1.5;
  const r = 6; // was 11 — PART 7: smaller crosshair
  ctx.beginPath();
  ctx.moveTo(aim.x - r, aim.y); ctx.lineTo(aim.x + r, aim.y);
  ctx.moveTo(aim.x, aim.y - r); ctx.lineTo(aim.x, aim.y + r);
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
  // PART 6/8: RIGHT STICK's merged view axes take priority; the touch
  // fallback still has two separate pads (light/aim, unchanged DOM/CSS,
  // out of this round's scope) — touch-aim wins over touch-light when both
  // are active, matching the old aim-over-light precedence.
  if (Math.abs(gpInput.view.x) > 0.001 || Math.abs(gpInput.view.y) > 0.001) {
    state.input.viewX = gpInput.view.x;
    state.input.viewY = gpInput.view.y;
  } else if (touchAim.x !== 0 || touchAim.y !== 0) {
    state.input.viewX = touchAim.x;
    state.input.viewY = touchAim.y;
  } else {
    state.input.viewX = touchLight.x;
    state.input.viewY = touchLight.y;
  }
  state.input.fireHeld = gpInput.fire || touchFireHeld;

  const actions = consumeActions();
  const forwardDelta = updatePlayer(dt, ts, state.input.moveX, state.input.moveY, actions);
  applyForwardDelta(forwardDelta);
  updateEnemy(dt, ts);
  updateBullets(ts);
  updateParticles(dt);

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
  isAimOnEffectiveHit, enemyHitRadius, approachZMinForRoid, isRoidActivelyFiring,
};
