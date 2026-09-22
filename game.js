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
// 5TH ROUND PART 7: ADAM shares GABRIEL's own crop-toward-upper-body
// approach formula (same "family" boss in ACTION-GAME, same human scale) —
// given its own, independently-tunable constant rather than literally
// reusing GABRIEL_Z_MIN, but seeded at the identical value since there is
// no real signal it should differ and this project's rule is never to
// invent numbers without a reason.
const ADAM_Z_MIN = 145;
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
const ADAM_WORLD_HEIGHT = 480; // 5TH ROUND PART 7: seeded at GABRIEL's own value (same human scale), independently tunable
// 5TH ROUND ROOT CAUSE FIX ("最大接近時、敵の足付近しか見えない"): the old
// PART4 value (0.92) only ever solved for "drawH equals this fraction of
// screen height" — it never accounted for WHERE the anchor point (ROID's
// own feet, since it's always foot-anchored/never cropped) actually sits
// on screen. ROID's feet land at proj.y = horizonY + CORRIDOR_FLOOR_Y*scale
// (~40% down the canvas, HORIZON_Y_RATIO, plus a small further offset —
// see approachZMinForRoid()), and since ROID's sprite is body-only-padding
// (bodyBottomFrac≈0.998, i.e. the feet sit right at the image's own bottom
// edge) the ENTIRE drawn height extends upward from that point. Solving
// dy = proj.y - drawH for the old 0.92 target gives a NEGATIVE value on
// ordinary screens — meaning the sprite's head/torso were being pushed
// off the top of the canvas by construction, leaving only the lower
// (foot/leg) portion actually visible, exactly matching the real-device
// report. 0.42 is chosen so dy stays a comfortably positive ~8% of the
// canvas height (full derivation: dy ≈ cssH*(0.40 - 0.757*FRAC), so
// FRAC<=0.46 is required for ANY headroom at all) — full body, including
// the head, now stays on screen with margin at max approach, while still
// reading as a large, close, imposing mech (42% of screen height). GABRIEL
// is untouched (uses its own, unrelated GABRIEL_Z_MIN/closeBoost crop
// formula, never this constant).
const ROID_FULLBODY_SCREEN_FRAC = 0.42;

// PART 9 (3rd round): ROID1/ROID2 now use only 3 real direction poses —
// SOUTH-WEST / SOUTH / SOUTH-EAST — never the true EAST/WEST full-profile
// images (investigated the real asset set directly: roid{1,2}_search_02.png
// and _04.png read as moderate ~30-45° diagonal turns, NOT full 90° side
// profiles, while _01.png/_05.png are the more extreme turns — _05
// confirmed a genuine full side profile by direct visual inspection — so
// those two are excluded entirely this round; see ROID_FACE_FRAME below).
// The old 5-zone farLeft/left/center/right/farRight hysteresis collapses to
// a simple 3-zone left/center/right one (single NEAR boundary + HYST,
// mirroring the exact shape round 1's original 2-zone east/west system
// used before PART 2 of the 2nd round added the now-removed far tier).
const ROID_FACE_ZONE_NEAR_PX = 60;
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
// 3RD-ROUND PART 3: the round-2 "merged view" design (RIGHT STICK driving
// both flashlight AND aim as one point) is explicitly retired this round —
// LEFT STICK is back to being its OWN independent control (FLASHLIGHT only,
// never MOVE) and RIGHT STICK is back to being its OWN independent AIM
// control. FLASHLIGHT_BASE_RADIUS is the lit-circle radius (unchanged).
// LIGHT_RANGE/AIM_RANGE are each the max px the flashlight/aim can be
// pushed from their own resting point at full stick deflection — PART 4
// cuts both by 20% from round 2's shared 190px (190*0.8=152).
const FLASHLIGHT_BASE_RADIUS = 150;
const LIGHT_RANGE = 152; // was VIEW_RANGE=190 (2nd round) — PART4: ~20% lower max reach/speed
const AIM_RANGE = 152;   // was VIEW_RANGE=190 (2nd round) — PART4: ~20% lower max reach/speed

// PART 4 (3rd round): deadzone is intentionally the SAME as MOVE's on BOTH
// sticks (never shrunk — a smaller deadzone invites stick drift). What's
// new: LEFT STICK (FLASHLIGHT) now ALSO gets a response curve for the first
// time (round 1/2 left it linear) — gentler than AIM's own, since the
// flashlight is a broader "look around" sweep rather than a precision
// input. RIGHT STICK (AIM)'s curve is pushed even further than round 2's
// (power 2.6->2.9) for the "弱点へ精密にAIMできることを優先" precision
// request: at x=0.5 output now drops to ~0.5^2.9≈0.134 (vs ~0.165 before),
// while x=1 still reaches the (now 20%-lower) max range unchanged.
const LIGHT_DEADZONE = 0.16;
const LIGHT_CURVE_POWER = 2.0;
const AIM_DEADZONE = 0.16;
const AIM_CURVE_POWER = 2.9; // was 2.6 (2nd round), was 2.2 (1st round)

// PART 5/6 (3rd round): AIM is no longer "flashlight-relative" — it has its
// own resting point (the player's own screen-space centerline, PART 5) plus
// a persistent manual offset (PART 6, LT/RT+D-PAD) plus a live offset.
// 4th round: the live offset is now purely velocity-integrated and NEVER
// auto-recenters (see AIM_MOVE_SPEED_PX_S above and updatePlayer()'s own
// AIM section) — the old "relaxes back to 0 on release" behavior this
// comment used to describe was exactly the bug this round was asked to fix.
const AIM_MANUAL_SPEED = 140; // px/sec, D-PAD-driven height/horizontal trim while LT/RT is held alone
const AIM_MANUAL_MAX_OFFSET = 70; // px, clamp on each manual-offset axis

const FIRE_COOLDOWN_MS = 130;
const MAG_SIZE = 12;
const RESERVE_MAX = 48;
const RELOAD_MS = 950;
// FOLLOWUP FIX (PART 3): the player's own shot is a fast traveling bullet
// resolved on arrival, not an instant full-length line.
const BULLET_TRAVEL_MS = 55;
// PART 7 (3rd round): FIRE recoil haptics — short, weak-to-medium, once per
// shot (triggered from inside fireWeapon(), which is itself already
// per-shot cooldown-gated, so this can never fire faster than real shots
// do). Feature-detected at call time (see triggerFireHaptics()); never
// throws on unsupported hardware/browsers.
const FIRE_HAPTIC_DURATION_MS = 70;
const FIRE_HAPTIC_WEAK = 0.35;
const FIRE_HAPTIC_STRONG = 0.15;

// 5TH ROUND PART 11: 5x the previous value (100 -> 500), per spec — the
// current definition is read and multiplied, not a guessed replacement
// number. Existing damage values (SNIPER_DAMAGE/MISSILE_DAMAGE/CLAW_DAMAGE)
// are intentionally left unchanged this round.
const PLAYER_MAX_HP = 100 * 5;
// 5TH ROUND PART 12: short damage-blink duration — brief enough not to
// obscure gameplay, clearly visible as an immediate "you were just hit"
// cue. Never overlaps the moment damage is possible again: damage is only
// ever applied when the player is NOT already DASH-invincible (all three
// damage sites gate on `invincible = now < p.invincibleUntil` before
// applying it), so this and DASH_INVINCIBLE_MS never need to race.
const PLAYER_HIT_FLASH_MS = 160;
// PART 2 (3rd round): a further visual size bump — leaning further toward
// the "腰から上を画面手前に大きく見せる" TPS framing. This constant is
// consumed ONLY by renderPlayer()'s own draw-size calculation; it never
// touches movement speed, strafe/dash distances, AIM math, or the bullet
// hit-test region (there is no separate player hit/collision-radius
// constant in this game at all — damage is resolved via enemy attack-phase
// judgment, not player-sprite distance checks — so render size and
// gameplay judgment are already fully decoupled by construction).
const PLAYER_SCALE_BOOST = 1.45; // was 1.18 (2nd round)

const GAMEPAD_AXIS_DEADZONE = 0.16;
const GAMEPAD_TRIGGER_THRESHOLD = 0.5;
// 5TH ROUND: root-cause fixes for "北へ勝手に進み続ける" / "十字キーが
// 効かなくなる" / "スティックが効かない" reports. GAMEPAD_SETTLE_MS is a
// brief window after a gamepad is FIRST adopted (page load, or reconnect
// after a disconnect) during which its raw button/axis state is NOT fed
// into movement/actions — some real controllers (Bluetooth pads in
// particular) report noisy/uncalibrated button state for the first few
// polls before settling, which previously landed straight into gameplay
// as real input (this is the same class of bug ACTION-GAME's own gamepad
// work already had to solve — see that project's "settle window" fix).
const GAMEPAD_SETTLE_MS = 350;

// ---------------------------------------------------------------------
// AIM — 4th round: position-integrated (velocity) control, replacing the
// old "stick position directly maps to AIM offset, auto-recenters to 0 on
// release" design. See updatePlayer()'s own AIM section for the full
// before/after writeup. AIM_MOVE_SPEED_PX_S is the max px/sec the AIM
// point can travel at full stick deflection — chosen so a full sweep
// across AIM_RANGE (152px each way, unchanged from before) takes roughly
// 1/3 second, i.e. a deliberate but responsive sweep, not an instant snap
// and not a sluggish crawl. The existing deadzone/curve shape (AIM_DEADZONE/
// AIM_CURVE_POWER above) is completely unchanged — only what the curved
// output DRIVES (velocity instead of absolute position) is new, per spec
// ("既存AIM感度について、今回の目的と無関係な大幅変更はしない").
const AIM_MOVE_SPEED_PX_S = 460;

// FOCUS / AUTO AIM (4th round) — LB replaces the retired FLASH action.
// Bare, testable starting values (spec explicitly says exact balance is
// not yet decided) — kept as named constants, not scattered literals, so
// they're trivial to retune later.
const FOCUS_MAX = 100;
const FOCUS_DRAIN_PER_SEC = 40;   // empties in 2.5s of continuous AUTO AIM
const FOCUS_RECOVER_PER_SEC = 20; // refills in 5s from empty while not in use
// How fast AUTO AIM's assisted point approaches the target hit-center —
// a smooth pull-in, not an instant snap-to-target (dt-multiplier lerp,
// same shape as AIM_MOVE_SPEED_PX_S's own manual-AIM integration above).
const AUTO_AIM_APPROACH_RATE = 9;

// ENEMY DEATH (4th round) — durations for the two death-effect families.
const DEATH_EXPLODE_MS = 650; // DRONE/ROID1/ROID2/ADAM SPHERE: existing explosion particles + fade
const DEATH_BURN_MS = 950;    // GABRIEL/ADAM: burn-down/dissolve, see startEnemyDeath()

// Per-shot damage — PREVIOUSLY DID NOT EXIST AT ALL (see PHASE 9 root-cause
// report: enemy.hp was declared but never once decremented anywhere in the
// codebase). This is not a retune of an existing SHOT-power value — it is
// the minimum new constant required to make hits actually reduce HP. Picked
// so a fresh 100HP enemy takes ~9 hits (close to one MAG_SIZE=12 magazine).
const BULLET_DAMAGE = 12;
const ENEMY_MAX_HP = 100;

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

// PART 13 (3rd round): COVER's own, much milder, player-sprite effect —
// ~10% extra transparency + a subtle dark tint, clearly weaker than
// STEALTH's alpha 0.35 drop + distortion so the two states read distinctly.
const COVER_ALPHA_DROP = 0.10;
const COVER_TINT_STRENGTH = 0.18;

// ---------------------------------------------------------------------
// COVER (drum-can barrels) — PART 4/9. Kept as one explicit lookup so
// which attack kinds cover blocks is trivial to retune later, per spec.
// SNIPER is blocked by cover (duck behind the barrel to beat the lock).
// MISSILE is NOT blocked by cover (must reposition out of the target
// ellipse instead) and CLAW (GABRIEL melee) is NOT blocked (reach attack,
// a barrel doesn't stop it) — neither of those was asked to change.
// ---------------------------------------------------------------------
const COVER_BLOCKS_ATTACK = { sniper: true, missile: false, claw: false };
// 3RD-ROUND PART 1/11/12: barrel shrunk again (still read as "taller than an
// adult male" at BARREL_DRAW_H=150) — 75 is exactly a 50% cut from that,
// inside the requested 40-60% range, targeting "clearly shorter than an
// adult male, chest-height or below". PART 11/12 also retire the old
// separate COVER_RADIUS_PX (a fraction of the visual size, chosen only to
// look reasonable on the ground-shadow ellipse that PART 10 now deletes
// entirely) in favor of ONE shared BARREL_TOUCH_RADIUS_PX used for BOTH
// physical collision (can't walk through the barrel) AND cover activation
// (cover starts exactly when you're touching it) — sized to match the
// barrel's own real visual half-width (drawW≈drawH since barrel.png is
// square, so half-width ≈ BARREL_DRAW_H/2 ≈ 37.5 at scale 1; 40 is a hair
// outside that so the collision boundary reads as "the barrel's edge",
// not "somewhere inside the barrel's own graphic").
const BARREL_DRAW_H = 75; // was 150 (a 50% cut, within the requested 40-60% range)
const BARREL_TOUCH_RADIUS_PX = 40; // was COVER_RADIUS_PX=36 (a different, ellipse-shadow-sized concept) — now shared by collision AND cover
const BARREL_TOUCH_Z_MAX = 300; // was COVER_BARREL_Z_MAX — barrel must be this close (world-z) to be interactable at all
const BARREL_COLLIDE_Z_FLOOR = 55; // PART 11: forward movement can never push an X-aligned barrel's own z below this (walking into it from the front)
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

// 5TH ROUND PART 8/9/10: GABRIEL/ADAM's CLAW attack rebuilt into a real
// blink -> fast-approach -> brief-windup -> spatial-hit-test swing
// sequence, replacing the old shape where entering the attack motion
// guaranteed a hit unless the player happened to be mid-DASH-invincibility
// at that exact instant (never an actual position check at all — "GABRIEL
// が攻撃モーションに入ったら自動的に主人公へダメージ" was literally true
// before this round). See updateEnemy()'s 'claw' branch for the full
// state machine; CLAW_BLINK_MS/CLAW_APPROACH_MS are the two reaction
// windows the player gets (spec explicitly forbids an instant guaranteed
// hit the same frame the fast-approach lands), CLAW_HIT_RANGE_PX is the
// real lateral reach checked at the swing instant.
const CLAW_BLINK_MS = 500;      // GABRIEL/ADAM blinks in place — first "something is coming" tell
const CLAW_APPROACH_MS = 220;   // fast close-the-distance dash to its own zMin (same duration class as the player's own DASH_DURATION_MS)
const CLAW_WINDUP_MS = 280;     // brief claw-raised telegraph AFTER arriving — the real "point of no return" reaction window (see DASH-evasion, PART 9)
const CLAW_SWING_MS = 140;      // unchanged from the old single impact duration
const CLAW_COOLDOWN_MS = 1200;  // unchanged from the old cooldown duration
const CLAW_DAMAGE = 20;         // unchanged value, now a named constant
// Real lateral reach at the swing instant — a bit under STRAFE_DASH_DISTANCE_PX
// (100px) so a single, well-timed DASH reliably clears it, matching spec
// item 9's "DASHで回避可能" requirement without making it trivial to avoid
// by accident (deadzone/idle drift alone won't clear 95px).
const CLAW_HIT_RANGE_PX = 95;

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
// 4th round: enemy HP gauge (PART 23) + FOCUS gauge (PART 17/18) — neither
// existed before this round (see PHASE 9's root-cause report: there was no
// boss HP gauge markup at all, only the player's own #hp-bar-*).
const enemyNameEl = document.getElementById('enemy-name');
const enemyHpFillEl = document.getElementById('enemy-hp-bar-fill');
const focusFillEl = document.getElementById('focus-bar-fill');
// PART 29/30 (4th round follow-up): main gameplay BGM — real audio file now
// provided (assets/audio/after_the_limits.mp3). See tryStartBgm()/
// togglePauseMenu() for the actual lifecycle.
const bgmAudioEl = document.getElementById('bgm-audio');
const themeLabelEl = document.getElementById('theme-label');

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
// 5TH ROUND PART 7: ADAM SPHERE — real ACTION-GAME asset (adam_sphere_01..04,
// alpha-channel-measured the same way ROID's frames were, not guessed:
// topFrac≈0.10/bottomFrac≈0.89 for all 4). The sphere is rotationally
// symmetric (no facing/direction concept), so unlike ROID it reuses the
// SAME 4 real frames for every zone AND for the "fire" pose slot — there is
// no separate attack-pose art for it in ACTION-GAME, and this project's own
// rule is never to fabricate new art, so the existing idle/pulse frames are
// what plays throughout, cycled as a simple animation via the same
// roidFireFrame ping-pong machinery ROID already uses.
const ADAM_SPHERE_SPRITES = {
  search: [
    spriteFrame('assets/adam_sphere/adam_sphere_01.png', 0.1065, 0.8892),
    spriteFrame('assets/adam_sphere/adam_sphere_02.png', 0.1094, 0.88),
    spriteFrame('assets/adam_sphere/adam_sphere_03.png', 0.1009, 0.8963),
    spriteFrame('assets/adam_sphere/adam_sphere_04.png', 0.1023, 0.8864),
    spriteFrame('assets/adam_sphere/adam_sphere_01.png', 0.1065, 0.8892),
  ],
  fire: [
    spriteFrame('assets/adam_sphere/adam_sphere_01.png', 0.1065, 0.8892),
    spriteFrame('assets/adam_sphere/adam_sphere_02.png', 0.1094, 0.88),
    spriteFrame('assets/adam_sphere/adam_sphere_03.png', 0.1009, 0.8963),
    spriteFrame('assets/adam_sphere/adam_sphere_04.png', 0.1023, 0.8864),
  ],
};
// zone -> search-frame-index, copied verbatim from ACTION-GAME's own
// ROID1_FACE_FRAME/ROID2_FACE_FRAME (game.js ~L5059-5060) — both bosses
// share the same zone->index layout in the reference game.
// PART 9 (3rd round): only the 3 non-full-profile SEARCH frames are ever
// selected now — right(SE)=search_02, center(S)=search_03, left(SW)=
// search_04. search_01/search_05 stay defined in ROID1_SPRITES/
// ROID2_SPRITES (real assets, harmless to keep loaded) but are simply never
// referenced by this map, so they can never be chosen.
const ROID_FACE_FRAME = { right: 1, center: 2, left: 3 };

// ENEMY SELECT / AUTO MODE (4th round) — investigated first: only
// roid1/roid2/gabriel have any implementation in this repo at all (assets,
// AI, attack phases). DRONE / ADAM SPHERE / ADAM have NO assets, NO AI, NO
// code anywhere in this file (confirmed via full-file search before writing
// this) — they are NOT implemented, and per spec this is reported rather
// than faked. ENEMY_IMPLEMENTED/ENEMY_LABEL/ENEMY_DEATH_FAMILY cover all 6
// selectable identities so the UI can list all of them (per spec item 10)
// while cleanly refusing to "start a fight" against one that doesn't exist.
// 5TH ROUND PART 7: ADAM/ADAM SPHERE flip to TRUE — real assets found and
// investigated directly in ACTION-GAME (andre20290810/ACTION-GAME), never
// assumed absent. ADAM reuses GABRIEL's own attack-family state machine
// (computeEnemyDrawRect()/updateEnemy()'s 'claw' kind) with its own real
// art (ASSETS.adam); ADAM SPHERE reuses the ROID-style ranged sniper/
// missile state machine with its own real art (ASSETS.adamSphere). Both
// are simplifications of ACTION-GAME's own fuller DEFENSE/counter and
// double-shot/blockade systems (out of this round's scope) — see the
// completion report for the honest accounting of what was and wasn't
// ported. DRONE remains false: no asset/AI/code for it exists anywhere in
// this repo (re-checked this round, unchanged from prior rounds).
const ENEMY_IMPLEMENTED = {
  drone: false, roid1: true, roid2: true, gabriel: true, adamSphere: true, adam: true,
};
const ENEMY_LABEL = {
  drone: 'DRONE', roid1: 'ROID 1', roid2: 'ROID 2', gabriel: 'GABRIEL', adamSphere: 'ADAM SPHERE', adam: 'ADAM',
};
// 'explode' = reuse existing explosionFlash/spark/smoke burst (PART 25).
// 'burn' = GABRIEL/ADAM's own burn-down/dissolve effect (PART 26) — never
// the same simple explosion DRONE gets, per spec.
const ENEMY_DEATH_FAMILY = {
  drone: 'explode', roid1: 'explode', roid2: 'explode', adamSphere: 'explode',
  gabriel: 'burn', adam: 'burn',
};
// AUTO MODE's order is the FULL requested order — DRONE/ADAM SPHERE/ADAM
// are listed for documentation/UI purposes but AUTO_SEQUENCE (used by the
// actual cycling logic below) only ever contains the 3 real, implemented
// enemies, in their requested relative order. See selectEnemy()/
// advanceAutoMode() and the completion report for the honest accounting of
// this gap — nothing here pretends DRONE/ADAM SPHERE/ADAM are playable.
const ENEMY_SELECT_ORDER = ['drone', 'roid1', 'roid2', 'gabriel', 'adamSphere', 'adam'];
const AUTO_SEQUENCE = ENEMY_SELECT_ORDER.filter((t) => ENEMY_IMPLEMENTED[t]);

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
  // 5TH ROUND PART 7: ADAM — real ACTION-GAME asset, copied read-only, same
  // as every other character here. ADAM shares GABRIEL's own attack FAMILY
  // in ACTION-GAME (isGabrielFamilyBossType() there groups 'gabriel' and
  // 'adam' together), so it's wired into the SAME idle/windup/release CLAW
  // pipeline GABRIEL already uses (see computeEnemyDrawRect()/updateEnemy())
  // rather than inventing a second, parallel attack system. windup uses the
  // real ACTION-GAME "attack" (pre-swing) pose; release uses the real
  // "straight_claw" (connecting swing) pose — both existing files, no
  // fabricated art. ACTION-GAME's fuller DEFENSE/counter-attack system for
  // ADAM is NOT ported (out of this round's scope) — see completion report.
  adam: {
    idle: loadImg('assets/adam/adam_idle_south.png'),
    windup: loadImg('assets/adam/adam_attack_south.png'),
    release: loadImg('assets/adam/adam_straight_claw.png'),
  },
  adamSphere: ADAM_SPHERE_SPRITES,
  barrel: loadImg('assets/objects/barrel.png'),
};

function imgReady(img) {
  return !!img && img.complete && img.naturalWidth > 0;
}

// ---------------------------------------------------------------------
// LOADING GATE (5TH ROUND PART 17/18/19/20; 6TH ROUND: root-cause fix for
// the real-device "stuck at 98%" report)
// ---------------------------------------------------------------------
// 6TH ROUND ROOT CAUSE (confirmed by direct reproduction — see the
// completion report for the exact repro method): the previous version
// required `bgmAudioEl.readyState >= 3` (HAVE_FUTURE_DATA) before treating
// the BGM as "loaded", counted as 1 of the ~42 required items — so a
// single stuck item landed at (41/42)*100 ≈ 97.6% → rounds to 98%,
// matching the report exactly. HTMLMediaElement.readyState reaching 3
// requires the browser to actually BUFFER playable data, and mobile
// browsers (iOS Safari in particular) are well known to defer that
// buffering indefinitely — even with preload="auto" — until a real user
// gesture has occurred. That created a genuine deadlock: the loading gate
// waited for a state audio could only reach AFTER the gate opens, so on
// exactly the devices this project targets (touch/mobile), it could never
// complete. This is a browser-policy issue confirmed by reproducing it
// directly (freezing bgmAudioEl.readyState at 1, matching real iOS
// pre-gesture behavior, reliably reproduces a permanent 98% stall
// identical to the report), not a missing/broken file.
//
// Fix (spec section 2's own required/non-required split): only real
// character/boss/object IMAGES — the things that would visibly be missing
// from the scene if gameplay started too early — block 100%/START.
// REQUIRED_IMAGES is collected from the SAME real ASSETS object every
// character already draws from (never a fabricated separate list). BGM
// readiness is tracked and logged SEPARATELY for diagnostics, and is
// never part of the blocking total — it starts (or keeps trying to start)
// via the existing gesture-gated tryStartBgm() regardless of its buffered
// state, which already tolerates an unready audio element correctly (see
// PART 19 in this round's report). A load FAILURE (a real network error,
// not merely "not buffered yet") is still logged loudly either way.
// ---------------------------------------------------------------------
function collectImages(node, out) {
  if (!node) return;
  if (node.tagName === 'IMG') { out.push(node); return; }
  if (Array.isArray(node)) { for (const v of node) collectImages(v, out); return; }
  if (typeof node === 'object') { for (const k in node) collectImages(node[k], out); }
}
const REQUIRED_IMAGES = [];
collectImages(ASSETS, REQUIRED_IMAGES);

const loadingScreenEl = document.getElementById('loading-screen');
const loadingBarFillEl = document.getElementById('loading-bar-fill');
const loadingPctEl = document.getElementById('loading-pct');
const loadingStatusEl = document.getElementById('loading-status');
const loadingEtaEl = document.getElementById('loading-eta');
const loadingWalkSpriteEl = document.getElementById('loading-walk-sprite');
const modeSelectScreenEl = document.getElementById('mode-select-screen');

// 6TH ROUND PART 3: LOADING-screen-only walk animation. Reuses the SAME
// real player north-walk Image objects the game itself draws from
// (ASSETS.player.walk[0..2] — no new asset, no separate fetch, the
// browser just serves the already-in-flight/cached request again) but is
// driven by its OWN tiny interval, completely separate from state.player
// or the real frame() loop — PART 14 requires this stay 100% cosmetic and
// never touch real game state, and this implementation has no code path
// that could (it only ever writes to a decorative <img>'s src).
const LOADING_WALK_FRAME_MS = 140; // matches the real player's own walk-frame cadence (see updatePlayer()'s p.walkTimer > 0.14)
let loadingWalkTimerHandle = null;
let loadingWalkFrameIndex = 0;
function startLoadingWalkAnimation() {
  if (loadingWalkTimerHandle !== null) return;
  loadingWalkTimerHandle = setInterval(() => {
    loadingWalkFrameIndex = (loadingWalkFrameIndex + 1) % ASSETS.player.walk.length;
    loadingWalkSpriteEl.src = ASSETS.player.walk[loadingWalkFrameIndex].src;
  }, LOADING_WALK_FRAME_MS);
}
function stopLoadingWalkAnimation() {
  if (loadingWalkTimerHandle !== null) { clearInterval(loadingWalkTimerHandle); loadingWalkTimerHandle = null; }
}

// 6TH ROUND PART 11: wireless-controller purchase link. No real store URL
// exists anywhere in this repo or in ACTION-GAME (checked directly) — per
// spec, this is left as an explicit, safe placeholder rather than a
// guessed address; changing where it points is a one-line edit here.
const CONTROLLER_STORE_URL = ''; // PLACEHOLDER — not yet set, see completion report
const controllerStoreLinkEl = document.getElementById('controller-store-link');
if (CONTROLLER_STORE_URL) {
  controllerStoreLinkEl.href = CONTROLLER_STORE_URL;
} else {
  // No destination configured yet — keep the link visibly inert (never a
  // dead "#" that silently does nothing) rather than a guessed address.
  controllerStoreLinkEl.addEventListener('click', (e) => e.preventDefault());
  controllerStoreLinkEl.setAttribute('aria-disabled', 'true');
}

// 6TH ROUND PART 12: EN/JA toggle for the mode-select screen only — swaps
// textContent in place from each element's own data-en/data-ja attribute,
// never a page reload, and never itself a start/gesture action (PART 12's
// own explicit "言語切り替えだけではゲームを開始しない" — this function
// touches only text, no game/audio state).
let uiLang = 'en';
function applyUiLang() {
  document.querySelectorAll('[data-en][data-ja]').forEach((el) => {
    el.textContent = uiLang === 'ja' ? el.dataset.ja : el.dataset.en;
  });
}
document.getElementById('lang-toggle-btn').addEventListener('click', () => {
  uiLang = uiLang === 'en' ? 'ja' : 'en';
  applyUiLang();
});

const loadFailureLogged = new Set();
let bgmLoadLoggedReady = false;

// 6TH ROUND PART 1: diagnostic console output — total/loaded/pending/failed,
// with pending items listed by file path, so a future stall (whatever its
// cause) is immediately diagnosable instead of a silent freeze. Throttled
// to once per ~1s while incomplete (never spammed every frame) plus once
// on actual completion.
let lastDiagLogAt = 0;
function logLoadingDiagnostics(now, loaded, total, pendingPaths, failedPaths) {
  if (now - lastDiagLogAt < 1000 && loaded < total) return;
  lastDiagLogAt = now;
  console.log('[loading] total:', total, 'loaded:', loaded, 'pending:', pendingPaths.length, 'failed:', failedPaths.length);
  if (pendingPaths.length) console.log('[loading] pending files:', pendingPaths);
  if (failedPaths.length) console.log('[loading] FAILED files:', failedPaths);
}

// 6TH ROUND PART 6: real-progress-rate ETA, exponentially-smoothed so it
// never jitters wildly frame to frame. Samples (timestamp, loadedCount)
// on every call; needs at least ETA_MIN_SAMPLES spanning ETA_MIN_SPAN_MS
// of real elapsed time before it will show a number at all (shows
// "CALCULATING..." until then) — never a fabricated/guessed early value.
const ETA_MIN_SAMPLES = 3;
const ETA_MIN_SPAN_MS = 400;
const ETA_SMOOTHING = 0.25; // EMA factor applied to the rate itself
let etaSamples = []; // {t, loaded}
let etaSmoothedRate = null; // items/ms, smoothed

function estimateRemainingSeconds(now, loaded, total) {
  etaSamples.push({ t: now, loaded });
  if (etaSamples.length > 8) etaSamples.shift();
  if (etaSamples.length < ETA_MIN_SAMPLES) return null;
  const first = etaSamples[0];
  const span = now - first.t;
  if (span < ETA_MIN_SPAN_MS) return null;
  const deltaLoaded = loaded - first.loaded;
  if (deltaLoaded <= 0) return etaSmoothedRate ? Math.max(0, (total - loaded) / (etaSmoothedRate * 1000)) : null;
  const instRate = deltaLoaded / span; // items per ms
  etaSmoothedRate = etaSmoothedRate === null ? instRate : (etaSmoothedRate + ETA_SMOOTHING * (instRate - etaSmoothedRate));
  if (etaSmoothedRate <= 0) return null;
  const remainingItems = total - loaded;
  return Math.max(0, remainingItems / (etaSmoothedRate * 1000));
}

// Checked once per frame (cheap — ~40 images, no per-frame allocation
// beyond a couple of counters) until it returns true. Never a
// setTimeout/fixed-duration "looks done" fallback — genuinely polls each
// required image's own real state (img.complete/naturalWidth) every time.
function checkAssetsReady(now) {
  let loaded = 0;
  const total = REQUIRED_IMAGES.length;
  const pendingPaths = [];
  const failedPaths = [];
  for (const img of REQUIRED_IMAGES) {
    if (imgReady(img)) {
      loaded++;
    } else if (img.complete && img.naturalWidth === 0) {
      failedPaths.push(img.src);
      if (!loadFailureLogged.has(img.src)) {
        loadFailureLogged.add(img.src);
        console.error('[loading] REQUIRED image failed to load:', img.src);
      }
    } else {
      pendingPaths.push(img.src);
    }
  }
  // BGM: diagnostic-only, never blocks the percentage/100% (see the
  // section comment above for why — mobile browsers can legitimately
  // never reach readyState>=3 before a gesture).
  if (bgmAudioEl) {
    if (bgmAudioEl.error && !loadFailureLogged.has(bgmAudioEl.src)) {
      loadFailureLogged.add(bgmAudioEl.src);
      console.error('[loading] BGM (non-blocking) failed to load:', bgmAudioEl.src, bgmAudioEl.error);
    } else if (bgmAudioEl.readyState >= 3 && !bgmLoadLoggedReady) {
      bgmLoadLoggedReady = true;
      console.log('[loading] BGM buffered and ready:', bgmAudioEl.src);
    }
  }
  logLoadingDiagnostics(now, loaded, total, pendingPaths, failedPaths);
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 100;
  loadingBarFillEl.style.width = pct + '%';
  loadingPctEl.textContent = String(pct);
  const etaSec = estimateRemainingSeconds(now, loaded, total);
  if (loaded >= total) {
    loadingEtaEl.textContent = '';
  } else if (etaSec === null) {
    loadingEtaEl.textContent = 'CALCULATING...';
  } else {
    loadingEtaEl.textContent = 'ESTIMATED TIME: ' + Math.max(1, Math.ceil(etaSec)) + ' SEC';
  }
  return loaded >= total;
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
    hitFlashUntil: 0, // 5TH ROUND PART 12: player damage-blink window, see PLAYER_HIT_FLASH_MS
    // PART 5/6 (3rd round), rewritten 4th round: AIM's own persistent
    // state — liveX/Y is velocity-integrated by the RIGHT STICK and NEVER
    // auto-recenters (see updatePlayer()'s own AIM section); manualOffsetX/Y
    // are the separate, persistent LT+D-PAD-up/down / RT+D-PAD-left/right
    // trims, unaffected either way.
    aimLiveX: 0, aimLiveY: 0,
    aimManualOffsetX: 0, aimManualOffsetY: 0,
    // PART 12/13 (3rd round): 0..1 smoothed "how deep in a barrel's touch
    // radius" state, driving the COVER visual (see renderPlayer()) —
    // smoothed the same dt-based way p.scale already is, so leaving cover
    // fades out over a short interval rather than snapping.
    coverVisual: 0,
    // 4th round: FOCUS / AUTO AIM (LB, replaces the retired FLASH).
    focus: FOCUS_MAX,
    autoAimActive: false,
    lastFocusFillPct: -1,
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
    zone: 'center',   // 'left' (SW) | 'center' (S) | 'right' (SE) — PART 9, 3rd round
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
    // 5TH ROUND PART 8: CLAW 'approach' phase's start-z snapshot, so the
    // fast close-the-distance dash-in can be eased deterministically
    // (same recompute-from-a-stored-start pattern the player's own DASH
    // uses) rather than a raw per-frame velocity step.
    clawApproachStartZ: 0,
    // 4th round: real max HP (enemy.hp was previously declared but never
    // actually compared against a max anywhere — see PHASE 9 root-cause
    // report) + death-sequence state. 'alive' -> ('exploding'|'burning') ->
    // 'gone'. combat AI (updateEnemy()) and damage (updateBullets()) both
    // check this and stop the instant it leaves 'alive' (PART 27).
    maxHp: ENEMY_MAX_HP,
    deathState: 'alive',
    deathStartedAt: 0,
    deathUntil: 0,
    lastHpFillPct: -1,
    lastNameText: '',
  },

  input: {
    moveX: 0, moveY: 0,
    // PART 3 (3rd round): the round-2 merged "view" stick is retired —
    // LEFT STICK (lightX/Y) is its own independent FLASHLIGHT control
    // again, RIGHT STICK (aimX/Y) is its own independent AIM control.
    lightX: 0, lightY: 0,
    aimX: 0, aimY: 0,
    // PART 6 (3rd round): while LT or RT is held alone, D-PAD drives the
    // AIM manual-offset trim instead of MOVE — these are continuous
    // -1/0/+1 magnitudes (same shape as moveX/moveY), applied dt-scaled in
    // updatePlayer().
    aimHeightAdjust: 0, aimHorizAdjust: 0,
    fireHeld: false,
    focusHeld: false, // 4th round: LB/touch-focus — FOCUS/AUTO AIM
  },

  // edge-triggered one-shot actions, consumed by update() each frame
  actions: {
    reload: false,
    stealth: false,
    northDash: false,
    southDash: false,
    eastDash: false,
    westDash: false,
    pauseToggle: false, // 4th round: gamepad Start / touch PAUSE button
  },

  gamepadConnected: false,
  gamepadIndex: null,
  prevButtons: [],
  // 5TH ROUND: settle window state — see GAMEPAD_SETTLE_MS above.
  // gamepadSettleUntil is a timestamp; while now < this, pollGamepad()
  // returns neutral input but keeps re-syncing prevButtons so no stale/
  // noisy pre-settle state can leak in as a real input once settle ends.
  gamepadSettleUntil: 0,

  // 4th round: touch UI is OFF by default (spec item 6 — Gamepad play
  // shouldn't have the screen full of sticks/buttons); PAUSE toggles it.
  touchControlsVisible: false,
  paused: false,
  // 5TH ROUND PART 17/18: LOADING gate — see checkAssetsReady()/frame()'s
  // own gating. assetsReady flips once every required image + the BGM are
  // genuinely confirmed loaded; gameStarted flips on the first real
  // gesture AFTER that (never before), which is also the single unified
  // trigger for BGM playback (see handleFirstGesture()).
  assetsReady: false,
  gameStarted: false,
  // ENEMY SELECT / AUTO MODE (4th round). 'auto' cycles AUTO_SEQUENCE;
  // any other value is one specific implemented enemy type. autoMode.index
  // is AUTO_SEQUENCE's own index (only ever points at an implemented type).
  enemySelect: 'auto',
  autoMode: { active: true, index: 0 },

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

// 5TH ROUND PART 16 ("延々と前進している感覚"): a purely COSMETIC,
// continuous forward-flow illusion for the floor-pattern structures
// (floorSeam/grating) so the corridor still reads as "flowing past /
// advancing" even while the player stands still fighting — spec's own
// contrast is "同じ場所で止まって戦っている" vs "延々と奥へ近づき続けて
// いる". This NEVER writes to structures[].z, applyForwardDelta(), enemy
// z, or barrel z — those stay 100% player-input-driven, exactly as the
// "北へ勝手に進み続ける" fix above requires; it only computes a RENDER-TIME
// offset in renderStructure() below. Seamless by construction: floorSeam/
// grating already repeat identically every SPACING world-z units, so
// shifting the whole repeating pattern by an amount that wraps every
// SPACING units is visually indistinguishable at the wrap instant — never
// a jump/pop (spec: "継ぎ目で大きくジャンプ...しないように").
const AMBIENT_FLOOR_CRAWL_SPACING = { floorSeam: 95, grating: 210 };
const AMBIENT_FLOOR_CRAWL_SPEED = 70; // world-z units/sec — gentler than WALK_FORWARD_SPEED (150) so it never reads as if the player is actually walking

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
    state.gamepadSettleUntil = 0;
  }
});

// Generic deadzone + rescale + power-curve shaper, shared by both sticks
// (PART 4, 3rd round: LEFT STICK/FLASHLIGHT now gets a curve for the first
// time too — round 1/2 left it linear). Rescaling after the deadzone cut
// avoids a "dead jump" right at the deadzone boundary; the power curve then
// compresses small/medium inputs while preserving output=1 at input=1
// (full stick deflection still reaches the — now 20%-lower, see
// LIGHT_RANGE/AIM_RANGE — max reach/speed).
function applyStickCurve(raw, deadzone, power) {
  const a = Math.abs(raw);
  if (a < deadzone) return 0;
  const rescaled = (a - deadzone) / (1 - deadzone);
  const curved = Math.pow(rescaled, power);
  return raw < 0 ? -curved : curved;
}
function applyAimCurve(raw) { return applyStickCurve(raw, AIM_DEADZONE, AIM_CURVE_POWER); }
function applyLightCurve(raw) { return applyStickCurve(raw, LIGHT_DEADZONE, LIGHT_CURVE_POWER); }

function pollGamepad(now) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null;
  if (state.gamepadIndex !== null) {
    gp = pads[state.gamepadIndex] || null;
    if (!gp || !gp.connected) { gp = null; state.gamepadIndex = null; }
  }
  if (!gp) {
    // 5TH ROUND ("複数Gamepadの誤認識" investigation): previously this
    // just grabbed the FIRST connected pad index, so a spurious/ghost
    // gamepad entry (a known real phenomenon on some browser/OS combos —
    // ghost entries typically report mapping:'' and/or an empty id) sitting
    // at a lower index than the player's real controller would win
    // permanently (the loop never re-evaluates once ANY index looks
    // "connected"). Now a standard-mapping candidate with a real id is
    // preferred over one without, when more than one pad is present.
    let candidate = null, candidateIndex = -1;
    for (let i = 0; i < pads.length; i++) {
      const cand = pads[i];
      if (!cand || !cand.connected) continue;
      if (!candidate) { candidate = cand; candidateIndex = i; continue; }
      const candidateIsStandard = candidate.mapping === 'standard' && !!candidate.id;
      const thisIsStandard = cand.mapping === 'standard' && !!cand.id;
      if (thisIsStandard && !candidateIsStandard) { candidate = cand; candidateIndex = i; }
    }
    if (candidate) {
      gp = candidate;
      state.gamepadIndex = candidateIndex;
      // New adoption — see GAMEPAD_SETTLE_MS above. Don't trust this pad's
      // raw state as real input yet; re-baseline prevButtons every frame
      // until settle ends so no pre-settle noise can register as an edge
      // the instant settle expires.
      state.gamepadSettleUntil = (now || 0) + GAMEPAD_SETTLE_MS;
      state.prevButtons = [];
      console.log('[gamepad] adopted index', candidateIndex, 'id=', candidate.id, 'mapping=', candidate.mapping || '(non-standard)', 'axes=', candidate.axes.length, 'buttons=', candidate.buttons.length);
      // 5TH ROUND ("スティックが効かない" investigation): LEFT STICK/RIGHT
      // STICK are read from axes[0..3] (W3C Standard Gamepad layout — the
      // layout the vast majority of consumer pads, including non-standard-
      // mapped ones, still report axes in). If a real device genuinely
      // exposes fewer than 4 axes, AIM (axes[2]/[3]) would silently read
      // as permanently-neutral with no visible cause — surfaced here as a
      // real diagnostic instead of failing silently.
      if (candidate.axes.length < 4) {
        console.warn('[gamepad] only', candidate.axes.length, 'axes reported — RIGHT STICK (AIM) will not respond on this device/mapping.');
      }
    }
  }

  state.gamepadConnected = !!gp;
  dbgGamepadEl.textContent = gp ? (gp.id ? gp.id.slice(0, 18) : 'CONNECTED') : 'NONE';

  const gpMove = { x: 0, y: 0 };
  const gpLight = { x: 0, y: 0 };
  const gpAim = { x: 0, y: 0 };
  const gpAimAdjust = { height: 0, horiz: 0 };
  let gpFire = false;
  let gpFocusHeld = false; // LB held — FOCUS/AUTO AIM (4th round)

  if (gp) {
    const b = gp.buttons;
    const settling = (now || 0) < state.gamepadSettleUntil;

    if (settling) {
      // 5TH ROUND: settle window — keep re-syncing prevButtons to the
      // CURRENT raw state every frame (so whatever the pad happens to be
      // doing while it calibrates never becomes a false rising edge once
      // settle ends) but never feed this frame's state into gameplay.
      const settleSnapshot = new Array(b.length);
      for (let i = 0; i < b.length; i++) settleSnapshot[i] = !!(b[i] && b[i].pressed);
      state.prevButtons = settleSnapshot;
      return { move: gpMove, light: gpLight, aim: gpAim, aimAdjust: gpAimAdjust, fire: gpFire, focusHeld: gpFocusHeld };
    }

    const prev = state.prevButtons;
    const pressed = (i) => !!(b[i] && b[i].pressed);
    const edge = (i) => pressed(i) && !prev[i];

    // 6TH ROUND PART 9 fix: the mode-select trigger (any first button press
    // while !state.gameStarted, see below) used to be checked LAST in this
    // function — AFTER gpFire/edge(3..0) DASH latches were already computed
    // from this exact same press. That meant the very button press which
    // chose "WIRELESS CONTROLLER" could ALSO land as FIRE or a DASH on the
    // first real gameplay frame the instant state.gameStarted flipped true
    // (spec explicitly calls this out: "ボタンがそのままDASH/FIRE等として
    // 誤発火しないように"). Checked here, FIRST, before any action is
    // derived from this frame's raw button state — if it fires, this exact
    // press is fully consumed for mode-select only: prevButtons is
    // re-baselined (so it can never retroactively read as a stale edge
    // either) and the settle window is re-armed for defense-in-depth
    // against the next frame too, then this frame returns neutral input,
    // never reaching the gpFire/DASH lines below.
    if (!state.gameStarted && state.assetsReady) {
      let modeSelectTriggered = false;
      for (let i = 0; i < b.length; i++) {
        if (pressed(i) && !prev[i]) { modeSelectTriggered = true; break; }
      }
      if (modeSelectTriggered) {
        const triggerSnapshot = new Array(b.length);
        for (let i = 0; i < b.length; i++) triggerSnapshot[i] = pressed(i);
        state.prevButtons = triggerSnapshot;
        handleModeSelect('controller');
        state.gamepadSettleUntil = (now || 0) + GAMEPAD_SETTLE_MS;
        return { move: gpMove, light: gpLight, aim: gpAim, aimAdjust: gpAimAdjust, fire: gpFire, focusHeld: gpFocusHeld };
      }
    }

    // PART 3 (3rd round): LT(6)/RT(7) held SIMULTANEOUSLY -> STEALTH,
    // unchanged latch shape from round 2 (rising-edge on the AND condition
    // itself — never LT alone, never RT alone, never re-fires while both
    // stay held). Computed FIRST so PART 6's D-PAD modifier logic below can
    // check it and give STEALTH priority, per spec ("誤判定を防ぐ").
    // 5TH ROUND root-cause fix ("十字キーが効かなくなる"): this used to
    // read the browser's own .pressed boolean directly, which many
    // real analog triggers report as true from a very small pull (well
    // under half travel) — a barely-touched/resting-drifted LT or RT was
    // silently stealing the D-PAD away from MOVE into the AIM-trim
    // branches below with no visible cause. GAMEPAD_TRIGGER_THRESHOLD was
    // already declared for exactly this but was never actually wired in —
    // now both triggers are gated on their real analog .value crossing it,
    // falling back to .pressed only if .value is unavailable (older
    // browsers/synthetic gamepad-button objects with no analog value).
    const triggerValue = (i) => (b[i] && typeof b[i].value === 'number') ? b[i].value : (pressed(i) ? 1 : 0);
    const ltHeld = triggerValue(6) >= GAMEPAD_TRIGGER_THRESHOLD;
    const rtHeld = triggerValue(7) >= GAMEPAD_TRIGGER_THRESHOLD;
    const bothTriggersHeld = ltHeld && rtHeld;
    const bothTriggersHeldPrev = !!prev[6] && !!prev[7];
    if (bothTriggersHeld && !bothTriggersHeldPrev) state.actions.stealth = true;

    // 5TH ROUND root-cause fix ("北へ勝手に進み続ける"): a real D-PAD can
    // never physically report opposite directions (UP+DOWN, or LEFT+RIGHT)
    // pressed at the same time — seeing that combination is a strong
    // signal of a malformed/misread report from a non-standard-mapped or
    // otherwise misbehaving device, so it's treated as noise for THIS
    // frame only (never a lasting ban on any one direction — the very
    // next clean frame reads normally again).
    const dpadUp = pressed(12), dpadDown = pressed(13), dpadLeft = pressed(14), dpadRight = pressed(15);
    const dpadVerticalValid = !(dpadUp && dpadDown);
    const dpadHorizontalValid = !(dpadLeft && dpadRight);

    // PART 3/6 (3rd round): D-PAD is MOVE only when NEITHER trigger is held.
    // LT alone -> D-PAD UP/DOWN trims AIM height (PART 6). RT alone -> D-PAD
    // LEFT/RIGHT trims AIM horizontal offset. Both held at once is the
    // STEALTH gesture above — D-PAD does nothing that frame either way, so
    // a STEALTH press can never also register as a MOVE/AIM-trim input.
    if (bothTriggersHeld) {
      // pure STEALTH gesture window — D-PAD intentionally inert here.
    } else if (ltHeld) {
      if (dpadVerticalValid) {
        if (dpadUp) gpAimAdjust.height -= 1; // D-PAD up = raise AIM
        if (dpadDown) gpAimAdjust.height += 1; // D-PAD down = lower AIM
      }
    } else if (rtHeld) {
      if (dpadHorizontalValid) {
        if (dpadLeft) gpAimAdjust.horiz -= 1; // D-PAD left = AIM left
        if (dpadRight) gpAimAdjust.horiz += 1; // D-PAD right = AIM right
      }
    } else {
      if (dpadHorizontalValid) {
        if (dpadLeft) gpMove.x -= 1; // D-PAD left
        if (dpadRight) gpMove.x += 1; // D-PAD right
      }
      if (dpadVerticalValid) {
        if (dpadUp) gpMove.y -= 1; // D-PAD up = north/forward
        if (dpadDown) gpMove.y += 1; // D-PAD down = south/back
      }
    }
    const moveMag = Math.hypot(gpMove.x, gpMove.y);
    if (moveMag > 1) { gpMove.x /= moveMag; gpMove.y /= moveMag; }

    // PART 3/4 (3rd round): LEFT STICK -> FLASHLIGHT only (never MOVE).
    // RIGHT STICK -> AIM only. Both curved+deadzoned independently now.
    gpLight.x = applyLightCurve(gp.axes[0] || 0);
    gpLight.y = applyLightCurve(gp.axes[1] || 0);
    gpAim.x = applyAimCurve(gp.axes[2] || 0);
    gpAim.y = applyAimCurve(gp.axes[3] || 0);

    gpFire = pressed(5);                            // RB = FIRE
    // 4th round: LB is FOCUS/AUTO AIM — a HELD state (consumed continuously
    // in updatePlayer(), not an edge-triggered one-shot action), replacing
    // the retired FLASH. See gpFocusHeld below and PART 16/17/19.
    const gpFocusHeldLocal = pressed(4);
    if (edge(3)) state.actions.northDash = true;      // Y = NORTH DASH
    if (edge(2)) state.actions.westDash = true;       // X = WEST DASH
    if (edge(1)) state.actions.eastDash = true;       // B = EAST DASH
    if (edge(0)) state.actions.southDash = true;      // A = SOUTH DASH / BACKSTEP
    // RELOAD isn't named anywhere in the button spec (every face/shoulder/
    // trigger button is spoken for by MOVE/AIM/DASH/FIRE/FOCUS/STEALTH/AIM
    // trim) — left stick click (L3) is the one remaining unused
    // standard-mapping button, so RELOAD stays there. Touch's own RELOAD
    // button is unaffected.
    if (edge(10)) state.actions.reload = true;        // L3 = RELOAD
    // 4th round: Start/Menu (standard mapping button 9) toggles PAUSE —
    // previously unused. Touch's own on-screen PAUSE button is unaffected.
    if (edge(9)) state.actions.pauseToggle = true;
    gpFocusHeld = gpFocusHeldLocal;

    // PART 29/30 (4th round follow-up): the mode-select trigger itself now
    // lives at the TOP of this function (see the 6TH ROUND PART 9 comment
    // above `const edge = ...`) so it is consumed before any FIRE/DASH
    // action can be derived from the same press. By the time execution
    // reaches here, state.gameStarted is already true whenever a gamepad is
    // in play, so there is nothing left to check.

    const nextPrev = new Array(b.length);
    for (let i = 0; i < b.length; i++) nextPrev[i] = pressed(i);
    state.prevButtons = nextPrev;
  } else {
    state.prevButtons = [];
  }

  return { move: gpMove, light: gpLight, aim: gpAim, aimAdjust: gpAimAdjust, fire: gpFire, focusHeld: gpFocusHeld };
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
let touchFocusHeld = false; // 4th round: FOCUS/AUTO AIM touch button (replaces FLASH's old slot)
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
// 4th round: FLASH's touch button is retired; the same slot now hosts
// FOCUS (held, same pattern as touch-fire above — not an edge action,
// since AUTO AIM needs to know while the button is held, see
// touchFocusHeld's use in updatePlayer()).
wireButton('touch-focus', () => {});
const focusBtnEl = document.getElementById('touch-focus');
focusBtnEl.addEventListener('pointerdown', () => { touchFocusHeld = true; });
focusBtnEl.addEventListener('pointerup', () => { touchFocusHeld = false; });
focusBtnEl.addEventListener('pointercancel', () => { touchFocusHeld = false; });
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
// PART 10/11 (4th round): ENEMY SELECT — extends the existing BOSS TEST
// panel (previously ROID1/ROID2/GABRIEL only) with AUTO + all 6 requested
// identities, reusing the SAME selectEnemy()/spawnEnemy() reset every other
// entry point uses (never a second, duplicate enemy-switch implementation).
document.querySelectorAll('.enemy-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.enemy-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectEnemy(btn.dataset.enemy);
  });
});

// ---------------------------------------------------------------------
// PAUSE MENU / TOUCH CONTROLS VISIBILITY (4th round)
// ---------------------------------------------------------------------

const pauseMenuEl = document.getElementById('pause-menu');
const touchControlsEl = document.getElementById('touch-controls');
const touchToggleBtnEl = document.getElementById('touch-controls-toggle');

// PART 6/7/8: touch UI defaults to HIDDEN (state.touchControlsVisible
// starts false) — only [hidden]/a CSS class is ever touched here, the
// underlying touch input implementation (makeVirtualStick()/wireButton()
// listeners) is completely untouched either way, so switching back ON from
// PAUSE restores full touch control exactly as before. The PAUSE button
// itself lives OUTSIDE #touch-controls (see index.html) so it's never
// hidden along with the rest of the touch UI.
function setTouchControlsVisible(visible) {
  state.touchControlsVisible = visible;
  touchControlsEl.classList.toggle('touch-controls-visible', visible);
  touchToggleBtnEl.textContent = 'TOUCH CONTROLS : ' + (visible ? 'ON' : 'OFF');
}
setTouchControlsVisible(state.touchControlsVisible);

// ---------------------------------------------------------------------
// BGM — "AFTER THE LIMITS" (4th round follow-up, PART 29/30)
// ---------------------------------------------------------------------
// This prototype has no separate TITLE/menu screen — the page IS gameplay
// from the moment it loads (see start() at the bottom of this file), so
// "GAMEPLAY開始" has no dedicated button to hook. What DOES gate audio
// here is the browser's own autoplay policy: playback with sound may only
// start from inside a real user-gesture event handler, never on load. So
// tryStartBgm() is called from the first genuine input this game already
// listens for — a touch/mouse pointerdown, a keydown, or the first
// detected gamepad button press (see the edge-detection loop added to
// pollGamepad() below) — whichever comes first. bgmStarted guards against
// calling play() repeatedly before playback has actually begun, and
// against ever calling it again afterward (so it never re-triggers/
// restarts once genuinely started).
let bgmStarted = false;
function tryStartBgm() {
  if (bgmStarted || !bgmAudioEl) return;
  const p = bgmAudioEl.play();
  if (p && p.catch) p.catch(() => {}); // autoplay rejected (no gesture yet) — silently retry on the next one
  if (!bgmAudioEl.paused) bgmStarted = true;
}

// 6TH ROUND PART 7/8/9/10: replaces the 5th round's "any input starts the
// game" handleFirstGesture() with an explicit MODE SELECT screen (spec:
// no more bare "TAP TO START" — the player must choose WIRELESS
// CONTROLLER or TOUCH CONTROLS, and THAT single click/press is the same
// gesture that unlocks Audio, starts gameplay, and configures the touch
// UI's visibility). mode is 'controller' | 'touch'. Idempotent — a second
// call (button mashed, or both a click AND a gamepad confirm racing) is a
// silent no-op once state.gameStarted is already true, so BGM/game can
// never double-start (PART 15).
function handleModeSelect(mode) {
  if (!state.assetsReady || state.gameStarted) return;
  modeSelectScreenEl.hidden = true;
  stopLoadingWalkAnimation();
  // PART 9: touch controls default to the SAME hidden-by-default state a
  // WIRELESS CONTROLLER player always had (setTouchControlsVisible()
  // itself is completely unchanged) — only a TOUCH CONTROLS choice turns
  // them on.
  setTouchControlsVisible(mode === 'touch');
  tryStartBgm();
  state.gameStarted = true;
}

document.getElementById('mode-btn-controller').addEventListener('click', () => handleModeSelect('controller'));
document.getElementById('mode-btn-touch').addEventListener('click', () => handleModeSelect('touch'));

// PART 30 (4th round follow-up): PAUSE/RESUME lifecycle for the BGM.
// audio.pause()/audio.play() on the SAME element never touch currentTime —
// that's the native platform guarantee this relies on for "同じ再生位置
// からresume" (no manual position bookkeeping needed, and no risk of a
// second overlapping playback either, since play() on an element that's
// merely paused-in-place just continues that one instance).
function togglePauseMenu() {
  state.paused = !state.paused;
  pauseMenuEl.hidden = !state.paused;
  if (state.paused) {
    bgmAudioEl.pause();
  } else if (bgmStarted) {
    const p = bgmAudioEl.play();
    if (p && p.catch) p.catch(() => {});
  }
}
document.getElementById('pause-btn').addEventListener('pointerdown', (e) => { e.preventDefault(); togglePauseMenu(); });
document.getElementById('pause-resume-btn').addEventListener('pointerdown', (e) => { e.preventDefault(); togglePauseMenu(); });
touchToggleBtnEl.addEventListener('pointerdown', (e) => { e.preventDefault(); setTouchControlsVisible(!state.touchControlsVisible); });

// ---------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------

function consumeActions() {
  const a = state.actions;
  const out = { ...a };
  a.reload = a.stealth = a.northDash = a.southDash = a.eastDash = a.westDash = a.pauseToggle = false;
  return out;
}

function updatePlayer(dt, now, moveX, moveY, actions) {
  const p = state.player;
  const strafeOffsetAtFrameStart = p.strafeOffset;

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

  // PART 11 (3rd round): barrel collision — clamp AFTER both the
  // continuous move and any active dash have been applied this frame, so
  // neither can walk/dash straight through a barrel. Uses the offset from
  // the START of this frame to figure out which side we're approaching
  // from (so the block lands at the correct edge, not always the same
  // side).
  p.strafeOffset = clampStrafeForBarrels(p.strafeOffset, strafeOffsetAtFrameStart);

  // 5TH ROUND ROOT CAUSE FIX ("最初の攻撃ではダメージが入るが、その後
  // 何度撃ってもダメージが入らない"): live-repro testing (holding
  // FOCUS/AIM to line up, releasing it, then firing) showed the FIRST shot
  // always lands, but any shot fired after the player so much as taps
  // STRAFE afterward misses — even though the player never touches AIM
  // again. Root cause: getAimPoint() anchors the reticle at
  // `baseX = centerX + p.strafeOffset` (PART 5, 3rd round — deliberate,
  // reticle sits near the player) and simply ADDS the persistent
  // aimLiveX offset on top. aimLiveX is correct only relative to
  // whatever strafeOffset was true the instant it was last set (by stick
  // input or AUTO AIM) — the enemy itself barely moves in screen space
  // (computeEnemyDrawRect()'s cx tracks world position, not the player's
  // own strafeOffset), so once the player strafes even briefly afterward,
  // baseX shifts but aimLiveX does not, and the ABSOLUTE reticle position
  // silently drags off the target by the exact strafe distance — confirmed
  // by test: a single 250ms D-PAD tap (~60px of strafe) was enough to move
  // a dead-center reticle (dist≈3px) completely off ROID1's ~48px hit
  // radius, and it then stayed off target for every subsequent shot since
  // nothing else ever corrects it. Fix: whenever strafeOffset actually
  // changes this frame (continuous move OR dash OR barrel clamp — the
  // total real delta after all of the above), subtract that exact delta
  // from aimLiveX so the reticle's ABSOLUTE on-screen position — and thus
  // whether it's still over the enemy — is unaffected by pure strafing.
  // Deliberate right-stick input / AUTO AIM still move it normally on top
  // of this; AIM_RANGE's own clamp (unchanged) is still the final bound,
  // so a very large strafe simply lets the reticle start drifting again
  // only once that full range is exhausted, never silently before it.
  const strafeDeltaThisFrame = p.strafeOffset - strafeOffsetAtFrameStart;
  if (strafeDeltaThisFrame !== 0) {
    p.aimLiveX = clamp(p.aimLiveX - strafeDeltaThisFrame, -AIM_RANGE, AIM_RANGE);
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

  // 4th round: FOCUS / AUTO AIM (LB / touch-focus), replacing FLASH. Held +
  // FOCUS>0 -> AUTO AIM active, draining FOCUS; released (or FOCUS empty)
  // -> AUTO AIM off, FOCUS recovers. SHOT itself is untouched (still RB) —
  // this only ever assists the AIM point, never fires on its own.
  p.autoAimActive = state.input.focusHeld && p.focus > 0.001;
  if (p.autoAimActive) {
    p.focus = Math.max(0, p.focus - FOCUS_DRAIN_PER_SEC * dt);
  } else {
    p.focus = Math.min(FOCUS_MAX, p.focus + FOCUS_RECOVER_PER_SEC * dt);
  }

  // AIM — 4th round rewrite: position-integrated (velocity), NOT
  // "stick position = AIM position with an auto-recenter-to-0 on release".
  // aimLiveX/Y is now a genuinely PERSISTENT offset: it only ever moves
  // while the stick is actually deflected (or AUTO AIM is pulling it), and
  // simply stays exactly where it is the instant the stick returns to
  // neutral — never snaps or decays back toward 0. Root cause of the old
  // "AIM resets on release" bug: the previous code intentionally lerped
  // aimLiveX/Y back to 0 every frame the stick was neutral (see git
  // history) — that recenter-to-center behavior is exactly what this round
  // was asked to remove.
  if (p.autoAimActive) {
    // AUTO AIM: smoothly pull the SAME persistent aimLiveX/Y toward the
    // current enemy's existing hit-center (computeEnemyDrawRect()/
    // enemyHitRadius() — the exact region SHOT already resolves against,
    // no invented separate "weak point"), converted into the same
    // base-relative offset space getAimPoint() reads. A smooth approach,
    // never an instant snap. Because this writes the SAME variable manual
    // AIM reads/writes, releasing LB leaves AIM exactly where AUTO AIM put
    // it — manual AIM simply resumes from there (PART 20), never resets.
    const rect = computeEnemyDrawRect();
    const baseX = state.centerX + p.strafeOffset;
    const baseY = state.horizonY + state.cssH * 0.06;
    const targetLiveX = clamp(rect.cx - baseX - p.aimManualOffsetX, -AIM_RANGE, AIM_RANGE);
    const targetLiveY = clamp(rect.cy - baseY - p.aimManualOffsetY, -AIM_RANGE, AIM_RANGE);
    const approachT = Math.min(1, dt * AUTO_AIM_APPROACH_RATE);
    p.aimLiveX += (targetLiveX - p.aimLiveX) * approachT;
    p.aimLiveY += (targetLiveY - p.aimLiveY) * approachT;
  } else {
    // Manual AIM: stick input (already deadzoned/curved upstream by
    // applyAimCurve()) drives VELOCITY, not absolute position. Deadzone
    // means state.input.aimX/Y is exactly 0 while the stick is neutral, so
    // this is naturally a no-op (position frozen) without any special-case
    // branch for "stick released".
    p.aimLiveX = clamp(p.aimLiveX + state.input.aimX * AIM_MOVE_SPEED_PX_S * dt, -AIM_RANGE, AIM_RANGE);
    p.aimLiveY = clamp(p.aimLiveY + state.input.aimY * AIM_MOVE_SPEED_PX_S * dt, -AIM_RANGE, AIM_RANGE);
  }
  // PART 6 (3rd round): persistent manual AIM trim — LT+D-PAD up/down
  // moves height only (X untouched), RT+D-PAD left/right moves horizontal
  // offset only (Y untouched); dt-scaled so held input ramps smoothly,
  // clamped so the reticle can never be trimmed off past a bounded range.
  p.aimManualOffsetY = clamp(p.aimManualOffsetY + state.input.aimHeightAdjust * AIM_MANUAL_SPEED * dt, -AIM_MANUAL_MAX_OFFSET, AIM_MANUAL_MAX_OFFSET);
  p.aimManualOffsetX = clamp(p.aimManualOffsetX + state.input.aimHorizAdjust * AIM_MANUAL_SPEED * dt, -AIM_MANUAL_MAX_OFFSET, AIM_MANUAL_MAX_OFFSET);

  // PART 12/13 (3rd round): COVER is now purely "touching a barrel" (see
  // isPlayerInCover(), which now shares its radius/z-range with barrel
  // collision above) — the only feedback is this short dt-based fade
  // driving the player sprite's own alpha/tint in renderPlayer(), no more
  // ground-level ellipse.
  const coverTarget = isPlayerInCover() ? 1 : 0;
  p.coverVisual += (coverTarget - p.coverVisual) * Math.min(1, dt * 10);

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

// PART 11 (3rd round): forward movement can never push an X-aligned barrel
// closer than BARREL_COLLIDE_Z_FLOOR — this is what stops the player from
// simply walking straight through a barrel that's directly ahead. Only
// forward motion is capped (backing away is always free); a barrel not
// aligned with the player's own screen X isn't in the way at all.
function clampForwardDeltaForBarrels(forwardDelta) {
  if (forwardDelta <= 0) return forwardDelta;
  const playerScreenX = state.centerX + state.player.strafeOffset;
  let allowed = forwardDelta;
  for (const b of barrels) {
    if (b.z - forwardDelta >= BARREL_COLLIDE_Z_FLOOR) continue;
    const proj = project(b.lane, CORRIDOR_FLOOR_Y, b.z);
    const radius = BARREL_TOUCH_RADIUS_PX * proj.scale;
    if (Math.abs(proj.x - playerScreenX) < radius) {
      allowed = Math.min(allowed, Math.max(0, b.z - BARREL_COLLIDE_Z_FLOOR));
    }
  }
  return allowed;
}

// PART 11 (3rd round): sideways (strafe) collision — a barrel close enough
// in z (within BARREL_TOUCH_Z_MAX) blocks the player's screen-X from
// crossing into its own touch radius, landing them at whichever edge they
// approached from (prevOffset) rather than snapping through to the far
// side. This is what stops WEST/EAST movement AND dashes from cutting
// straight through a barrel from the side.
function clampStrafeForBarrels(desiredOffset, prevOffset) {
  let offset = desiredOffset;
  for (const b of barrels) {
    if (b.z > BARREL_TOUCH_Z_MAX) continue;
    const proj = project(b.lane, CORRIDOR_FLOOR_Y, b.z);
    const radius = BARREL_TOUCH_RADIUS_PX * proj.scale;
    const desiredScreenX = state.centerX + offset;
    if (Math.abs(proj.x - desiredScreenX) < radius) {
      const prevScreenX = state.centerX + prevOffset;
      const fromLeft = prevScreenX <= proj.x;
      const edgeScreenX = fromLeft ? proj.x - radius : proj.x + radius;
      offset = edgeScreenX - state.centerX;
    }
  }
  return offset;
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
  // much farther out than GABRIEL/ADAM (human-scale), see the constants
  // above. ADAM SPHERE has no dedicated floor of its own (5TH ROUND PART
  // 7) — it reuses the ROID-style dynamic solve, same as DRONE would.
  const zMin = e.type === 'gabriel' ? GABRIEL_Z_MIN : (e.type === 'adam' ? ADAM_Z_MIN : approachZMinForRoid());
  e.z = Math.max(zMin, Math.min(ENEMY_Z_MAX, e.z - forwardDelta));
}

// PART 12 (3rd round): COVER is now purely "is the player physically
// touching a barrel" — the EXACT SAME radius/z-range clampStrafeForBarrels()
// uses for hard collision (BARREL_TOUCH_RADIUS_PX/BARREL_TOUCH_Z_MAX), so
// there is no separate, larger "safe zone" floating around the barrel
// independent of its own collision footprint.
// BUG FIX (found during regression testing): clampStrafeForBarrels() always
// resolves a colliding player to EXACTLY the collision radius's edge
// (distance == radius), so a strict "< radius" check here could never be
// true from a normal walk-into-the-barrel approach — COVER would never
// actually activate via real collision contact, only if some other code
// path placed the player strictly inside the radius. COVER_TOUCH_SLOP_PX
// is a few px of extra tolerance so resting right against the collision
// edge (the only way to ever actually touch a barrel) still reads as
// "touching" — it does NOT change the collision boundary itself.
const COVER_TOUCH_SLOP_PX = 6;
function isPlayerInCover() {
  const playerScreenX = state.centerX + state.player.strafeOffset;
  for (const b of barrels) {
    if (b.z > BARREL_TOUCH_Z_MAX) continue;
    const proj = project(b.lane, CORRIDOR_FLOOR_Y, b.z);
    const radius = BARREL_TOUCH_RADIUS_PX * proj.scale + COVER_TOUCH_SLOP_PX;
    if (Math.abs(proj.x - playerScreenX) < radius) return true;
  }
  return false;
}

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

  if (e.type === 'gabriel' || e.type === 'adam') {
    // GABRIEL/ADAM (5TH ROUND PART 7: same attack family) — unchanged from
    // round 1: simple 2-state east/west flip.
    let desired = e.facing;
    if (diff > ENEMY_TURN_HYSTERESIS_PX) desired = 'east';
    else if (diff < -ENEMY_TURN_HYSTERESIS_PX) desired = 'west';
    if (desired !== e.facing && now - e.lastTurnAt > ENEMY_TURN_COOLDOWN_MS) {
      e.facing = desired;
      e.lastTurnAt = now;
    }
  } else {
    // PART 9 (3rd round): ROID1/ROID2 — 3-zone hysteresis-held facing
    // (SW/S/SE only — the old 5-zone farLeft/farRight tier that used to
    // select the true side-profile images is gone, see ROID_FACE_FRAME).
    // Single NEAR boundary + HYST, the same shape round 1's original
    // 2-zone east/west system used.
    let zone = e.zone;
    const NEAR = ROID_FACE_ZONE_NEAR_PX, HYST = ROID_FACE_ZONE_HYST_PX;
    if (zone === 'center') {
      if (diff > NEAR) zone = 'right';
      else if (diff < -NEAR) zone = 'left';
    } else if (zone === 'right') {
      if (diff < NEAR - HYST) zone = 'center';
    } else if (zone === 'left') {
      if (diff > -(NEAR - HYST)) zone = 'center';
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
    // 5TH ROUND PART 12/13: "HIT!" text removed — the blink IS the hit
    // feedback now (see renderPlayer()'s hitFlashUntil branch). Damage
    // application/effects above are unchanged.
    p.hitFlashUntil = now + PLAYER_HIT_FLASH_MS;
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
    p.hitFlashUntil = now + PLAYER_HIT_FLASH_MS;
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

// ENEMY SELECT / AUTO MODE (4th round) — PART 13: the single shared reset
// point for "start fighting a fresh instance of this enemy type", used by
// selectEnemy()/advanceEnemyRotation() and the ENEMY SELECT UI alike, so
// there is exactly one enemy-reset code path, not one per caller. Resets
// EVERY per-enemy field to a clean initial value — HP, AI/attack-phase
// state, projectile/lock/target coordinates, animation frame, hit-flash,
// death state — so nothing from a previous enemy can ever leak into the
// next one (PART 13's explicit requirement).
function spawnEnemy(type) {
  const e = state.enemy;
  e.type = type;
  e.z = 900;
  e.lane = 0;
  e.laneTarget = 0;
  e.facing = 'east';
  e.zone = 'center';
  e.lastTurnAt = -Infinity;
  e.attackState = 'idle';
  e.attackUntil = 0;
  e.nextIdleCheckAt = 0;
  e.kind = (type === 'gabriel' || type === 'adam') ? 'claw' : 'sniper';
  e.hp = ENEMY_MAX_HP;
  e.maxHp = ENEMY_MAX_HP;
  e.hitFlashUntil = 0;
  e.roidFireFrame = 0;
  e.roidFireDir = 1;
  e.roidFireFrameElapsedMs = 0;
  e.lastShotFiredAt = -Infinity;
  e.lockX = 0; e.lockY = 0;
  e.fireFromX = 0; e.fireFromY = 0; e.fireToX = 0; e.fireToY = 0;
  e.missileTargetX = 0; e.missileTargetY = 0;
  e.clawApproachStartZ = 0;
  e.deathState = 'alive';
  e.deathStartedAt = 0;
  e.deathUntil = 0;
}

// PART 10/11: ENEMY SELECT entry point. AUTO starts the AUTO_SEQUENCE from
// its first (implemented) enemy; a specific implemented type starts that
// fight directly; a specific UNIMPLEMENTED type (drone/adamSphere/adam —
// see ENEMY_IMPLEMENTED, investigated up front: none of the three have any
// asset/AI/code in this repo) is refused with an on-screen notice rather
// than fabricating a fight against an enemy that doesn't exist.
function selectEnemy(type) {
  if (type === 'auto') {
    state.enemySelect = 'auto';
    state.autoMode.active = true;
    state.autoMode.index = 0;
    spawnEnemy(AUTO_SEQUENCE[0]);
    return;
  }
  if (!ENEMY_IMPLEMENTED[type]) {
    showCenterMsg((ENEMY_LABEL[type] || type.toUpperCase()) + ' NOT IMPLEMENTED', '#ffcf5c');
    return;
  }
  state.enemySelect = type;
  state.autoMode.active = false;
  spawnEnemy(type);
}

// PART 12: called once an enemy's death effect finishes while AUTO MODE is
// active — advances to the next entry in AUTO_SEQUENCE (looping back to the
// start after the last one, for a repeatable test loop) and spawns it via
// the SAME spawnEnemy() reset every other entry point uses.
function advanceEnemyRotation(now) {
  if (!state.autoMode.active) return;
  state.autoMode.index = (state.autoMode.index + 1) % AUTO_SEQUENCE.length;
  spawnEnemy(AUTO_SEQUENCE[state.autoMode.index]);
}

// PART 24/25/26/27: called once when enemy.hp first reaches 0. Picks the
// death family (ENEMY_DEATH_FAMILY), stamps the death-timer window, and
// immediately forces attackState back to 'idle' so any in-progress
// telegraph (LOCK box, missile target ellipse, etc.) stops being drawn on
// the very next frame — updateEnemy()'s own deathState!=='alive' early
// return (PART 27) is what actually stops combat AI/new attacks from here on.
function startEnemyDeath(now) {
  const e = state.enemy;
  if (e.deathState !== 'alive') return;
  const family = ENEMY_DEATH_FAMILY[e.type] || 'explode';
  e.deathState = family === 'burn' ? 'burning' : 'exploding';
  e.deathStartedAt = now;
  e.deathUntil = now + (family === 'burn' ? DEATH_BURN_MS : DEATH_EXPLODE_MS);
  e.attackState = 'idle';

  const rect = computeEnemyDrawRect();
  if (family === 'explode') {
    // PART 25: DRONE/ROID1/ROID2/ADAM SPHERE — reuses the EXACT SAME
    // particle types (explosionFlash/spark/smoke) resolveMissileImpact()
    // already spawns elsewhere in this file, just bigger/more of them for
    // a "defeated" moment instead of a mid-fight impact. No new particle
    // type, no new image asset.
    spawnParticle({ type: 'explosionFlash', x: rect.cx, y: rect.cy, r: 60, born: now, until: now + 170 });
    for (let i = 0; i < 3; i++) {
      spawnParticle({ type: 'smoke', x: rect.cx + (i - 1) * 16, y: rect.cy, r: 30, born: now, until: now + 500 + i * 90 });
    }
    for (let i = 0; i < 8; i++) {
      spawnParticle({
        type: 'spark', x: rect.cx + (Math.random() - 0.5) * rect.w * 0.5, y: rect.cy + (Math.random() - 0.5) * rect.h * 0.3,
        born: now, until: now + 180 + Math.random() * 160,
      });
    }
  } else {
    // PART 26: GABRIEL/ADAM — NOT the same explosion. A scatter of ember
    // ('spark', already amber-toned — see renderParticles()) bursts across
    // the body, paired with renderEnemy()'s own bottom-up dissolve/tint for
    // the sustained "burning down" read over DEATH_BURN_MS.
    for (let i = 0; i < 7; i++) {
      spawnParticle({
        type: 'spark', x: rect.cx + (Math.random() - 0.5) * rect.w * 0.6, y: rect.y + rect.h * (0.3 + Math.random() * 0.5),
        born: now, until: now + 260 + Math.random() * 320,
      });
    }
  }
}

function updateEnemy(dt, now) {
  const e = state.enemy;
  const p = state.player;

  // PART 27: once death has started, combat AI is fully stopped — no
  // facing/animation updates, no attack-phase progression, no new
  // projectiles. Only the death-timer itself advances, until it completes.
  if (e.deathState !== 'alive') {
    if (now >= e.deathUntil) {
      e.deathState = 'gone';
      advanceEnemyRotation(now);
    }
    return;
  }

  updateEnemyFacing(dt, now);
  updateRoidAnimation(dt, now);

  if (e.attackState === 'idle') {
    if (!e.nextIdleCheckAt) e.nextIdleCheckAt = now + 1500;
    if (now >= e.nextIdleCheckAt && e.z < 900) {
      const stealthMul = p.stealth ? 1.8 : 1.0;
      if (e.type === 'gabriel' || e.type === 'adam') {
        e.kind = 'claw';
        e.attackState = 'blink';
        e.attackUntil = now + CLAW_BLINK_MS * stealthMul;
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

  // --- GABRIEL/ADAM claw (5TH ROUND PART 8/9/10 rebuild) ---
  // blink -> approach -> telegraph(windup, reuses existing render state
  // name) -> impact(swing, reuses existing render state name) -> cooldown.
  // Root-cause note: the OLD sequence was telegraph->impact->cooldown, and
  // "avoided" was decided ENTIRELY by `now < p.invincibleUntil` (DASH's own
  // i-frame window) — there was no spatial check at all, so simply not
  // dashing at that one instant guaranteed a hit regardless of actual
  // distance. The new 'impact' entry below checks BOTH the existing DASH
  // i-frames AND a real lateral distance test (CLAW_HIT_RANGE_PX) — either
  // one avoids it, matching "GABRIELが攻撃モーションに入ったら自動的に
  // ダメージ、ではない" and "DASHで回避可能" simultaneously without
  // removing DASH's own existing invincibility-based avoidance.
  if (e.kind === 'claw') {
    if (e.attackState === 'blink') {
      // First reaction window — GABRIEL/ADAM blinks in place at its
      // current (pre-approach) distance; renderEnemy() reads this state
      // to drive the blink visual. No movement yet.
      if (now >= e.attackUntil) {
        e.clawApproachStartZ = e.z;
        e.attackState = 'approach';
        e.attackUntil = now + CLAW_APPROACH_MS;
      }
    } else if (e.attackState === 'approach') {
      // Fast close-the-distance dash toward its own max-approach position
      // (GABRIEL_Z_MIN/ADAM_Z_MIN — UNCHANGED values, per spec item 8: this
      // round only changes the ATTACK, never the max-approach distance
      // itself). Same eased-interpolation shape the player's own DASH uses.
      const zMin = e.type === 'gabriel' ? GABRIEL_Z_MIN : ADAM_Z_MIN;
      const tNorm = clamp(1 - (e.attackUntil - now) / CLAW_APPROACH_MS, 0, 1);
      const eased = 1 - Math.pow(1 - tNorm, 2);
      e.z = e.clawApproachStartZ + (zMin - e.clawApproachStartZ) * eased;
      if (now >= e.attackUntil) {
        e.z = zMin; // land exactly on the max-approach position, no overshoot/undershoot
        e.attackState = 'telegraph'; // reuses the existing windup-art render state
        e.attackUntil = now + CLAW_WINDUP_MS;
      }
    } else if (e.attackState === 'telegraph') {
      // Second, SHORT reaction window — the real "point of no return" tell
      // (claw-raised windup pose) AFTER arrival, satisfying spec item 9's
      // explicit ban on an instant guaranteed hit the same frame the
      // approach lands. A player who saw the blink and DASHed clear of
      // CLAW_HIT_RANGE_PX during blink+approach+this window avoids it.
      if (now >= e.attackUntil) {
        e.attackState = 'impact'; // reuses the existing release/swing-art render state
        e.attackUntil = now + CLAW_SWING_MS;
        // The actual hit-test — fires exactly once, at the instant the
        // swing begins, against the player's ACTUAL current position.
        const rect = computeEnemyDrawRect();
        const playerScreenX = state.centerX + p.strafeOffset;
        const lateralDist = Math.abs(playerScreenX - rect.cx);
        const outOfRange = lateralDist > CLAW_HIT_RANGE_PX;
        const dashInvincible = now < p.invincibleUntil;
        if (!outOfRange && !dashInvincible) {
          p.hp = Math.max(0, p.hp - CLAW_DAMAGE);
          p.hitFlashUntil = now + PLAYER_HIT_FLASH_MS;
        } else {
          showCenterMsg(dashInvincible ? 'AVOIDED' : 'MISS', '#7fffb0');
        }
      }
    } else if (e.attackState === 'impact') {
      if (now >= e.attackUntil) { e.attackState = 'cooldown'; e.attackUntil = now + CLAW_COOLDOWN_MS; }
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

  if (e.type === 'gabriel' || e.type === 'adam') {
    // GABRIEL/ADAM: round-1's existing crop-toward-upper-body approach
    // shape is UNCHANGED (it already does "get close -> frame shifts to
    // the upper body" correctly) — PART 4 only retunes GABRIEL's OWN
    // zMin/world height (see GABRIEL_Z_MIN/GABRIEL_WORLD_HEIGHT), not this
    // formula. 5TH ROUND PART 7: ADAM reuses this SAME formula (its own
    // attack "family" in ACTION-GAME, same human scale) via its own
    // ADAM_Z_MIN/ADAM_WORLD_HEIGHT constants and real ASSETS.adam art,
    // rather than a second parallel implementation.
    const isGabriel = e.type === 'gabriel';
    const set = isGabriel ? ASSETS.gabriel : ASSETS.adam;
    const zMin = isGabriel ? GABRIEL_Z_MIN : ADAM_Z_MIN;
    const worldHeight = isGabriel ? GABRIEL_WORLD_HEIGHT : ADAM_WORLD_HEIGHT;
    const img = e.attackState === 'telegraph' ? set.windup : (e.attackState === 'impact' ? set.release : set.idle);
    const distNorm = 1 - (e.z - zMin) / (ENEMY_Z_MAX - zMin);
    const closeBoost = 1 + Math.max(0, distNorm - 0.55) * 2.6;
    const drawH = worldHeight * proj.scale * closeBoost;
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

// PART 7 (3rd round): short recoil haptics, once per real shot — feature-
// detected here at call time (Gamepad Haptics' vibrationActuator is the
// modern API; hapticActuators[0].pulse() is the older Chrome-only one),
// and wrapped in try/catch so an unsupported controller/browser can never
// throw — the game just continues normally with no vibration.
function triggerFireHaptics() {
  try {
    if (state.gamepadIndex === null) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads[state.gamepadIndex];
    if (!gp) return;
    if (gp.vibrationActuator && typeof gp.vibrationActuator.playEffect === 'function') {
      gp.vibrationActuator.playEffect('dual-rumble', {
        startDelay: 0,
        duration: FIRE_HAPTIC_DURATION_MS,
        weakMagnitude: FIRE_HAPTIC_WEAK,
        strongMagnitude: FIRE_HAPTIC_STRONG,
      });
    } else if (gp.hapticActuators && gp.hapticActuators[0] && typeof gp.hapticActuators[0].pulse === 'function') {
      gp.hapticActuators[0].pulse(FIRE_HAPTIC_WEAK, FIRE_HAPTIC_DURATION_MS);
    }
  } catch (e) {
    // Never let a haptics failure interrupt gameplay.
  }
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
  triggerFireHaptics();
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
  const e = state.enemy;
  for (const b of state.bullets) {
    if (!b.active) continue;
    if (now < b.resolveAt) continue;
    b.active = false;
    if (e.deathState !== 'alive') continue; // PART 27: no damage while already dying/gone
    const rect = computeEnemyDrawRect();
    const hitRadius = enemyHitRadius(rect);
    const dist = Math.hypot(b.x2 - rect.cx, b.y2 - rect.cy);
    if (dist <= hitRadius) {
      // ROOT CAUSE (PART 21/22): this hit-test always fired correctly, but
      // NOTHING here ever touched enemy.hp — a full-repo search before this
      // change confirmed enemy.hp had no writer anywhere in the codebase
      // (only its initial value). It was Case A: the underlying HP value
      // itself never decreased — not a gauge-only display bug (no gauge
      // existed at all yet either, see the new #enemy-hud markup/updateHud()
      // below). This is the actual fix: apply real damage here.
      e.hp = Math.max(0, e.hp - BULLET_DAMAGE);
      e.hitFlashUntil = now + 120;
      spawnPlayerImpact(b.x2, b.y2, now);
      if (e.hp <= 0) startEnemyDeath(now);
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

// PART 3 (3rd round): FLASHLIGHT is its own independent LEFT-STICK-driven
// point again (round 2's "merged view" is retired) — resting at the same
// default point it always has (screen-center-ish, slightly below horizon).
function getFlashlightCenter() {
  const lx = clampAxis(state.input.lightX) * LIGHT_RANGE;
  const ly = clampAxis(state.input.lightY) * LIGHT_RANGE;
  return { x: state.centerX + lx, y: state.horizonY + state.cssH * 0.06 + ly };
}
function clampAxis(v) { return Math.max(-1, Math.min(1, v)); }

// PART 5/6 (3rd round): AIM's own resting point is the player's own
// screen-space centerline (X, tracks strafeOffset as the player moves) at
// a fixed default look height (Y) — no longer flashlight-relative.
// p.aimLiveX/Y (updated once per frame in updatePlayer(), see its AIM
// section) supplies the RIGHT STICK's live offset from that resting point,
// smoothly relaxing to 0 when the stick is neutral; p.aimManualOffsetX/Y
// supplies the persistent LT/RT+D-PAD trim (PART 6) on top of that, which
// the recenter never touches.
function getAimPoint() {
  const p = state.player;
  const baseX = state.centerX + p.strafeOffset;
  const baseY = state.horizonY + state.cssH * 0.06;
  return {
    x: baseX + p.aimManualOffsetX + p.aimLiveX,
    y: baseY + p.aimManualOffsetY + p.aimLiveY,
  };
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
      // 5TH ROUND PART 16: ambient render-time-only crawl — see the
      // AMBIENT_FLOOR_CRAWL_* comment above structures[]. crawlZ wraps
      // within [0, spacing), so this is a bounded shift of the already-
      // repeating pattern, never an actual position change of s itself.
      const crawlZ = (state.timeSec * AMBIENT_FLOOR_CRAWL_SPEED) % AMBIENT_FLOOR_CRAWL_SPACING.floorSeam;
      const drawZ = s.z - crawlZ;
      const l = project(-half, CORRIDOR_FLOOR_Y, drawZ);
      const r = project(half, CORRIDOR_FLOOR_Y, drawZ);
      ctx.strokeStyle = theme.wallDark;
      ctx.lineWidth = Math.max(1, 2 * l.scale);
      ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.stroke();
      break;
    }
    case 'grating': {
      const crawlZg = (state.timeSec * AMBIENT_FLOOR_CRAWL_SPEED) % AMBIENT_FLOOR_CRAWL_SPACING.grating;
      const gz = s.z - crawlZg;
      const l = project(-half * 0.7, CORRIDOR_FLOOR_Y * 0.98, gz);
      const r = project(half * 0.7, CORRIDOR_FLOOR_Y * 0.98, gz);
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
// PART 10 (3rd round): the old ground-level COVER ZONE ellipse (black
// "reachable" shadow / green-fill "active" indicator) is removed entirely
// — it read as an artificial game-UI marker painted onto a dark, otherwise
// diegetic stage, which doesn't fit this game's world or its TPS framing.
// COVER feedback now lives ENTIRELY on the player's own sprite (PART 13,
// see renderPlayer()); the barrel here is just the physical object itself.
function renderBarrels() {
  const sorted = barrels.slice().sort((a, b) => b.z - a.z);
  for (const b of sorted) {
    const proj = project(b.lane, CORRIDOR_FLOOR_Y, b.z);
    const drawH = BARREL_DRAW_H * proj.scale;
    if (drawH < 1.5) continue;

    const img = ASSETS.barrel;
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
  // 5TH ROUND PART 12: short damage-blink — a brief brightness flash on the
  // player sprite the instant real damage lands (see PLAYER_HIT_FLASH_MS /
  // the three resolve*Impact() sites and the CLAW hit-test above). Mirrors
  // the SAME flashing pattern already used for enemy hit feedback
  // (renderEnemy()'s own hitFlashUntil check) — takes visual priority over
  // STEALTH/COVER for its brief duration so "you were just hit" is never
  // masked by another state's own dimming/tinting.
  if (nowTs < p.hitFlashUntil) {
    ctx.save();
    ctx.filter = 'brightness(2.2)';
    ctx.drawImage(img, dx, dy, drawW, drawH);
    ctx.restore();
    return;
  }
  if (strength > 0.001) {
    // STEALTH always wins visually over COVER (they must read as clearly
    // distinct states) — the heat-haze distortion effect is unchanged.
    drawPlayerStealthed(img, dx, dy, drawW, drawH, strength, nowTs);
  } else if (p.coverVisual > 0.001) {
    // PART 13 (3rd round): COVER is shown on the player's own sprite, not
    // a ground overlay — ~10% more transparent than normal plus a subtle
    // dark tint, both scaled by coverVisual (which itself is the smoothed
    // isPlayerInCover() target, see updatePlayer()) so entering/leaving
    // barrel range fades rather than snapping. Deliberately much milder
    // than STEALTH's alpha 0.35 + distortion, so the two never look alike.
    ctx.save();
    ctx.globalAlpha = 1 - COVER_ALPHA_DROP * p.coverVisual;
    ctx.filter = `brightness(${(1 - COVER_TINT_STRENGTH * p.coverVisual).toFixed(3)})`;
    ctx.drawImage(img, dx, dy, drawW, drawH);
    ctx.restore();
  } else {
    ctx.drawImage(img, dx, dy, drawW, drawH);
  }
}

function renderEnemy(theme) {
  const e = state.enemy;
  if (e.deathState === 'gone') return; // fully defeated — nothing left to draw
  const rect = computeEnemyDrawRect();
  const now = performance.now();

  // 4th round BUG FIX: GABRIEL used to be MIRRORED (ctx.scale(-1,1)) around
  // its own center whenever e.facing==='west', to fake "turning to face the
  // player". GABRIEL is an asymmetric character (wing on one side, an
  // enlarged/bulged arm on the other) — mirroring swaps which side each
  // feature is on, breaking the design. Investigated first: no
  // direction-specific (east/west) GABRIEL art exists in assets/gabriel/ at
  // all (only pose variants: idle/claw_windup/claw_release), so per spec
  // ("方向別assetが存在しない場合は、勝手にmirrorして補完せず、現在利用可能
  // な正しいassetの範囲で表示") the correct fix is simply: never mirror.
  // GABRIEL now always renders in its one available orientation for
  // whichever pose is active, for every state (idle/movement/attack/
  // damage/CLAW/death) — e.facing is still tracked (updateEnemyFacing())
  // for lane-drift bias math elsewhere, but no longer read here.
  const flashing = e.deathState === 'alive' && now < e.hitFlashUntil;
  ctx.save();
  if (flashing) ctx.filter = 'brightness(2.2)';

  // 5TH ROUND PART 8: CLAW's first reaction window ("GABRIELが点滅") — a
  // fast on/off flicker (alpha + brightness) while attackState==='blink',
  // purely visual, no new asset. Only ever active while alive (blink is
  // gated to deathState==='alive' by the state machine itself).
  if (e.deathState === 'alive' && e.attackState === 'blink') {
    const lit = Math.sin(now / 65) > 0;
    ctx.globalAlpha = lit ? 1 : 0.3;
    ctx.filter = lit ? 'brightness(2.0)' : 'brightness(0.75)';
  }

  if (e.deathState === 'exploding') {
    // PART 25: DRONE/ROID1/ROID2/ADAM SPHERE — reuses the exact same
    // explosionFlash/spark/smoke particle types resolveMissileImpact()/
    // resolveSniperImpact() already use elsewhere (no new asset/effect
    // invented) — see startEnemyDeath() for the actual particle burst.
    // The sprite itself fades out and flash-brightens rather than vanishing
    // instantly, so the moment of "defeated" reads clearly.
    const t = clamp((now - e.deathStartedAt) / Math.max(1, e.deathUntil - e.deathStartedAt), 0, 1);
    ctx.globalAlpha = 1 - t;
    ctx.filter = `brightness(${(1 + (1 - t) * 2.5).toFixed(2)})`;
  } else if (e.deathState === 'burning') {
    // PART 26: GABRIEL/ADAM — a "burn down / dissolve", never a simple
    // explosion. Built entirely from existing canvas primitives (progressive
    // bottom-up crop + a warm-to-dark brightness/saturation pulse) — no new
    // image asset, and NOT a copy of ACTION-GAME's own burn effect (that
    // repo is not reachable from here — see startEnemyDeath()'s comment).
    const t = clamp((now - e.deathStartedAt) / Math.max(1, e.deathUntil - e.deathStartedAt), 0, 1);
    const warm = t < 0.25 ? 1 : 0; // brief warm ignition flash at the very start
    const dark = 1 - t * 0.85;
    ctx.filter = warm
      ? 'brightness(1.8) saturate(1.6)'
      : `brightness(${dark.toFixed(2)}) saturate(${(1 + t * 1.2).toFixed(2)})`;
    ctx.globalAlpha = 1 - t;
    // crop progressively from the BOTTOM up (collapsing/dissolving downward)
    const keepH = rect.h * (1 - t);
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x - 4, rect.y, rect.w + 8, keepH);
    ctx.clip();
    if (imgReady(rect.img)) {
      ctx.drawImage(rect.img, rect.x, rect.y, rect.w, rect.h);
    } else {
      ctx.fillStyle = '#334';
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    ctx.restore();
    ctx.restore();
    return;
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

  // PART 23: enemy HP gauge — always reflects the CURRENT enemy's own
  // hp/maxHp (reset to 100% by spawnEnemy() on every switch, per spec), and
  // the name label switches with it. Clamped to 0 so a mid-death-effect
  // frame never shows a negative-width bar.
  const e = state.enemy;
  const ehpPct = Math.max(0, Math.round((e.hp / e.maxHp) * 100));
  if (ehpPct !== e.lastHpFillPct) { enemyHpFillEl.style.width = ehpPct + '%'; e.lastHpFillPct = ehpPct; }
  const enemyName = ENEMY_LABEL[e.type] || e.type.toUpperCase();
  if (enemyName !== e.lastNameText) { enemyNameEl.textContent = enemyName; e.lastNameText = enemyName; }

  // PART 17: FOCUS gauge.
  const focusPct = Math.round((p.focus / FOCUS_MAX) * 100);
  if (focusPct !== p.lastFocusFillPct) { focusFillEl.style.width = focusPct + '%'; p.lastFocusFillPct = focusPct; }
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

  // 5TH ROUND PART 17/18, 6TH ROUND PART 1/2: LOADING gate. While REQUIRED
  // images aren't genuinely ready yet, skip ALL input/gameplay/render
  // processing entirely — the opaque #loading-screen overlay covers the
  // canvas anyway, so there is nothing to draw yet regardless.
  // checkAssetsReady() is real per-frame polling of each asset's own
  // state, never a timer (see its own comment for the 98%-stall root
  // cause this round fixed: BGM no longer blocks this gate at all).
  if (!state.assetsReady) {
    if (checkAssetsReady(ts)) {
      state.assetsReady = true;
      loadingScreenEl.hidden = true;
      modeSelectScreenEl.hidden = false;
      // PART 18: explicit flush at the exact ready transition — any
      // gamepad button already held through loading must require a fresh
      // release+press before it can register as anything, never fire as a
      // stale edge the instant gating lifts (see GAMEPAD_SETTLE_MS/
      // pollGamepad()'s own settle-window, reused here for the same
      // purpose at this different trigger point).
      state.gamepadSettleUntil = ts + GAMEPAD_SETTLE_MS;
    }
    return;
  }

  const gpInput = pollGamepad(ts);
  // 6TH ROUND PART 7/13: still waiting for an explicit mode-select choice
  // (WIRELESS CONTROLLER / TOUCH CONTROLS, see handleModeSelect()) —
  // assets are ready and that screen is showing, but gameplay itself has
  // not begun, so no input is processed as gameplay yet either.
  if (!state.gameStarted) return;
  state.input.moveX = gpInput.move.x !== 0 ? gpInput.move.x : touchMove.x;
  state.input.moveY = gpInput.move.y !== 0 ? gpInput.move.y : touchMove.y;
  // PART 3/4 (3rd round): LEFT STICK drives FLASHLIGHT only, RIGHT STICK
  // drives AIM only — each has its own touch-pad fallback, independent of
  // the other, instead of the old merged single "view" axis.
  state.input.lightX = gpInput.light.x !== 0 ? gpInput.light.x : touchLight.x;
  state.input.lightY = gpInput.light.y !== 0 ? gpInput.light.y : touchLight.y;
  state.input.aimX = gpInput.aim.x !== 0 ? gpInput.aim.x : touchAim.x;
  state.input.aimY = gpInput.aim.y !== 0 ? gpInput.aim.y : touchAim.y;
  // PART 6: LT/RT + D-PAD manual AIM trim (height/horizontal).
  state.input.aimHeightAdjust = gpInput.aimAdjust.height;
  state.input.aimHorizAdjust = gpInput.aimAdjust.horiz;
  state.input.fireHeld = gpInput.fire || touchFireHeld;
  state.input.focusHeld = gpInput.focusHeld || touchFocusHeld;

  const actions = consumeActions();
  // 4th round: PAUSE (gamepad Start / touch PAUSE button) toggles the
  // overlay — see togglePauseMenu(). Checked before the paused-gate below
  // so the SAME frame that opens/closes PAUSE can still toggle it back.
  if (actions.pauseToggle) togglePauseMenu();

  if (!state.paused) {
    const forwardDelta = updatePlayer(dt, ts, state.input.moveX, state.input.moveY, actions);
    applyForwardDelta(clampForwardDeltaForBarrels(forwardDelta));
    updateEnemy(dt, ts);
    updateBullets(ts);
    updateParticles(dt);

    if (state.input.fireHeld) fireWeapon(ts);
  }

  const theme = THEMES[state.theme];
  renderCorridor(theme);
  renderBarrels();
  renderEnemy(theme);
  renderPlayer(theme);
  renderParticles();
  renderFlashlightMask();
  // PART 8 (3rd round): renderBullets() (the player's own tracer) must run
  // AFTER the darkness mask, same bug class as renderEnemyTelegraphs()
  // below — otherwise any tracer segment landing outside the lit circle
  // (i.e. away from wherever AIM/FLASHLIGHT currently points) is nearly
  // invisible against the 0.90-alpha overlay, which is why the tracer
  // used to appear to vanish depending on input state.
  renderBullets();
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

// 4th round: boot straight into AUTO MODE's first enemy via the SAME
// spawnEnemy() reset every other entry point uses, rather than relying on
// the state.enemy object literal's own initial field values staying in
// sync with spawnEnemy() by hand.
spawnEnemy(AUTO_SEQUENCE[0]);

// 6TH ROUND PART 3/14: the LOADING-screen walk animation starts
// immediately (the loading screen itself is visible from first paint) and
// is stopped the instant the player actually picks a mode — it never runs
// concurrently with real gameplay and never touches state.player/state.enemy.
startLoadingWalkAnimation();

start();

window.__darkoutTps = {
  state, THEMES, ASSETS,
  // pure read-only helpers, exposed for automated testing only
  getAimPoint, getFlashlightCenter, computeEnemyDrawRect,
  isPlayerInCover, getStealthStrength, applyAimCurve, playerMarkerPos, barrels,
  isAimOnEffectiveHit, enemyHitRadius, approachZMinForRoid, isRoidActivelyFiring,
  // added 3rd round (PART 3/4/6/9/11/12): new stick curve/collision helpers
  applyLightCurve, clampStrafeForBarrels, clampForwardDeltaForBarrels,
  triggerFireHaptics,
  // added 4th round: ENEMY SELECT/AUTO MODE, FOCUS/AUTO AIM, death effects,
  // PAUSE/touch-controls-visibility — exposed for automated testing only.
  selectEnemy, spawnEnemy, startEnemyDeath, advanceEnemyRotation,
  togglePauseMenu, setTouchControlsVisible,
  ENEMY_IMPLEMENTED, ENEMY_LABEL, ENEMY_DEATH_FAMILY, AUTO_SEQUENCE,
  // added 4th round follow-up: BGM lifecycle.
  tryStartBgm, bgmAudioEl,
  // added 6th round: LOADING gate diagnostics, mode-select, i18n, ETA —
  // exposed for automated testing only.
  checkAssetsReady, REQUIRED_IMAGES, handleModeSelect,
  get uiLang() { return uiLang; }, applyUiLang,
  CONTROLLER_STORE_URL,
  startLoadingWalkAnimation, stopLoadingWalkAnimation,
};
