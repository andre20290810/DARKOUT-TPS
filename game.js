'use strict';
/*
 * DARKOUT-TPS — pseudo-3D TPS prototype.
 * Reuses DARK OUT (ACTION-GAME) character art; corridor/lighting/enemy
 * distance are procedural (no 3D models, no new AI-generated images).
 * Standalone project — does not read or write ACTION-GAME in any way.
 */

// ---------------------------------------------------------------------
// 8TH ROUND: DEBUG MODE gate — ?debug=1 only. Read once at script load via
// URLSearchParams so it can never misparse/consume any OTHER existing query
// param (URLSearchParams parses the full string generically; presence of
// any other key/value is completely irrelevant to this single get('debug')
// lookup). Every debug-only behavior added this round (the on-screen panel,
// event-log ring buffer, console diagnostic logging, FIRE/enemy counters)
// is gated behind this ONE boolean, checked before any of that work runs —
// never merely hidden by CSS while still computing under the hood — so a
// normal URL (this flag false) is provably unchanged: zero extra DOM
// writes, zero extra console output, zero extra per-frame work, and the
// gate itself never reads/writes anything gameplay logic also reads, so it
// cannot affect gameplay either way.
// ---------------------------------------------------------------------
// 12TH ROUND (items 6-8): DEBUG COLLECTION is now ALWAYS ON, on every URL
// — the "?debug=1 only" gate above described the 8TH ROUND design; this
// round explicitly asks for background recording regardless of URL, with
// only the VISUAL PANEL staying opt-in (now via PAUSE MENU, not the URL).
// DEBUG_MODE itself (checked at ~100 call sites throughout this file —
// every r10DebugLog()/counter-increment site) is simply always true now,
// so every one of those sites keeps recording unconditionally with zero
// changes needed at each call site. DEBUG_URL_FLAG keeps the original
// ?debug=1 meaning ALIVE only for seeding the panel's initial visibility
// (a developer convenience — a debug URL still opens straight into the
// panel — see state.debugPanelVisible below), never for collection.
const DEBUG_URL_FLAG = new URLSearchParams(window.location.search).get('debug') === '1';
const DEBUG_MODE = true;

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

// 12TH ROUND (items 13-14): shared PLAYER PERSPECTIVE concept — a single
// bounded "depth position" (p.depthPos in COMBAT, es.depthPos in ESCAPE;
// [-1, +1], negative=SOUTH/near/bigger, positive=NORTH/far/smaller) that
// both modes independently accumulate from their own NORTH/SOUTH input,
// converted through this ONE shared formula into the visible body scale —
// so "WORLD DEPTH -> PERSPECTIVE SCALE" is the same concept everywhere,
// per the round's own closing "空間表現" section, without unifying the two
// modes' actual movement models (COMBAT's is a world-scrolls-under-a-
// fixed-camera model via forwardDelta/applyForwardDelta(); ESCAPE's is a
// real free-roam screen position — see updateEscapePlayer()). Nothing
// outside rendering reads player scale (no collision/hit-test radius is
// derived from it — confirmed true since the 2nd round), so this is purely
// visual and cannot affect AIM/DAMAGE/COVER geometry.
function perspectiveScaleFromDepth(depthPos, range) {
  return 1 - clamp(depthPos, -1, 1) * range;
}
const PLAYER_DEPTH_SCALE_RANGE = 0.12; // COMBAT: scale spans ~0.88 (far/NORTH) to ~1.12 (near/SOUTH)
const PLAYER_DEPTH_RECOVER_PER_SEC = 0.9; // COMBAT depthPos eases back toward 0 when idle (mirrors the old scaleTarget=1.0 rest state)

// ---------------------------------------------------------------------
// ESCAPE-EXCLUSIVE CONSTANTS — this whole block only ever affects the
// ESCAPE gameplay mode (state.gameMode === 'escape', see the STATE section
// below). LAB/ARMORED (state.gameMode === 'combat') never reads any of
// these; they keep using WALK_FORWARD_SPEED/WALK_BACK_SPEED/STRAFE_SPEED/
// DASH_*/etc. above completely unchanged. Deliberately NEW, independently-
// tunable constants rather than reusing LAB's own — per spec, ESCAPE's
// control scheme must not be a repurposing of LAB's.
// ---------------------------------------------------------------------
// Continuous, automatic south-heading world-scroll (no player input
// required) — "進行方向" (the direction of travel) for A SOUTH DASH/Y NORTH
// BACKSTEP below. Uses the SAME sign convention applyForwardDelta() already
// uses for LAB's own forward/north walk (positive forwardDelta -> structure
// z decreases -> world rushes toward/past the camera) because that is the
// only sign that actually reads as "advancing forward at speed" — the
// literal "reverse the direction of progression" in the spec is the
// SEMANTIC/story direction (north walk -> automatic south run), not a flip
// of this visual convention (flipping it would read as the player drifting
// backward, the opposite of a high-speed escape).
// 12TH ROUND (item 19): background/stage scroll roughly doubled again.
// This is the AUTOMATIC environmental scroll rate (fires every frame
// regardless of player input), not player-input-driven WALK_FORWARD_SPEED/
// ESCAPE_STRAFE_SPEED, so doubling it satisfies "faster background scroll"
// without doubling raw player input speed, per the explicit spec
// instruction. CLEAR SEQUENCE trigger stays purely on timeLeftSec (real
// elapsed seconds), so this doesn't touch SURVIVE MM:SS pacing.
const ESCAPE_AUTO_SCROLL_SPEED = 680; // NEXT ROUND PART A: was 340 (12TH ROUND doubled it from 170) — doubled again for real high-speed-getaway pacing
const ESCAPE_STRAFE_SPEED = 300;             // px/sec continuous lateral dodge (left stick + D-PAD, unified)
// 12TH ROUND (items 15-18): ESCAPE gains a genuine, sustained NORTH/SOUTH
// movement axis (es.depthPos, [-1, +1]) alongside the existing WEST/EAST
// strafe — "奥行きのあるフィールド内を移動可能に". Unlike COMBAT's
// depthPos (which eases back to 0 — see PLAYER_DEPTH_RECOVER_PER_SEC),
// this one has NO auto-recovery: it stays wherever the player leaves it,
// exactly mirroring how p.strafeOffset (WEST/EAST) already behaves — free
// 2-axis movement within a bounded field, not a spring-loaded lean.
// ESCAPE_DEPTH_SCALE_RANGE is wider than COMBAT's (0.12) since ESCAPE's
// whole framing is "run freely through a field", where a more dramatic
// near/far read is appropriate; ESCAPE_DEPTH_SCREEN_RANGE_PX additionally
// moves the player's own screen Y with depth (COMBAT's camera-fixed model
// has no equivalent — the world scrolls instead).
const ESCAPE_DEPTH_SPEED = 0.9; // depthPos units/sec at full stick deflection
const ESCAPE_DEPTH_SCALE_RANGE = 0.18;
const ESCAPE_DEPTH_SCREEN_RANGE_PX = 46;
const ESCAPE_DEPTH_DASH_NUDGE = 0.35; // brief depthPos push on NORTH/SOUTH instant DASH, on top of the world-z burst
// 13TH ROUND (item 1): decay rate for the NORTH/SOUTH DASH scale pulse
// (1/rate ~= the time constant) — ~120ms, short enough to read as a snap,
// never a residual offset from the normal depth-based perspective scale.
const ESCAPE_DASH_SCALE_PULSE_DECAY_RATE = 8;
// 10TH ROUND (items 33-36): investigated current value first, per spec —
// 8TH ROUND had cut this from 130 to 32.5 (~25%) after "dash travels too
// far" feedback, but real-device play now reports the opposite problem:
// 32.5px is too short to actually dodge an enemy attack. Target per this
// round's explicit instruction is "roughly half of the original 130px",
// i.e. ~65 — splitting the difference between the two real-device
// complaints rather than picking either extreme again. NORTH BACKSTEP/
// SOUTH DASH (Z-axis, separate constants below) are untouched, matching
// both the 8th and 10th round's own scoping.
// 12TH ROUND (item 45): was 65 (11th round) — increased so the emergency
// dodge reads as clearly distinct from normal continuous MOVE, per this
// round's explicit "通常MOVEとの差が明確な緊急回避に" instruction. Still
// well short of the STRAFE_MAX_OFFSET screen-edge clamp already applied in
// updateEscapePlayer(), so it can never fling the player off-screen.
const ESCAPE_STRAFE_DASH_DISTANCE_PX = 110; // was 65 (11th round), 32.5 (8th round), 130 originally
const ESCAPE_SOUTH_DASH_DISTANCE_Z = 340;    // was 260 (11th round) — A, accelerate further in the direction of travel
const ESCAPE_NORTH_BACKSTEP_DISTANCE_Z = 260; // was 200 (11th round) — Y, brief backstep against the direction of travel
// 11TH ROUND (items 6-8): DASH is now a true INSTANT teleport — the full
// ESCAPE_STRAFE_DASH_DISTANCE_PX / ESCAPE_SOUTH_DASH_DISTANCE_Z /
// ESCAPE_NORTH_BACKSTEP_DISTANCE_Z is applied in the single frame the
// input arrives (see updateEscapePlayer()), so the old ESCAPE_STRAFE_
// DASH_DURATION_MS/ESCAPE_FWD_DASH_DURATION_MS eased-travel window
// constants are gone — replaced by ESCAPE_DASH_BLINK_MS, a short
// post-teleport blink+invulnerability window (reuses state.player.
// invincibleUntil, the SAME i-frame field LAB's own DASH already sets —
// no second invulnerability system).
// 12TH ROUND (item 43-44): the previous 220ms window at a 60ms toggle
// period produced ~3-4 on/off flips ("細かい高速点滅" per real-device
// feedback) — too rapid to read as a deliberate, calm blink. Slowed to a
// 300ms window at a 75ms toggle period: 300/75=4 phase transitions
// (on->off->on->off->on), i.e. exactly 2 distinct "off" flashes, per the
// explicit "約2回程度の落ち着いたblink" request.
// 13TH ROUND (items 7-8, real-device re-test): 2 flashes still read as too
// much on a real device. Rather than shrinking ESCAPE_DASH_BLINK_MS itself
// (that would just shorten the SAME invincibility/blink window and could
// silently "hide" the flash count reduction inside a shorter duration,
// which item 8 explicitly rejects), the render-side blink algorithm below
// was redesigned to be DASH-START-ANCHORED (phase computed from p.
// invincibleUntil - ESCAPE_DASH_BLINK_MS, never raw wall-clock modulo) and
// driven by an explicit cycle COUNT — ESCAPE_DASH_BLINK_CYCLES=1 halves
// the previous 2 "off" flashes to exactly 1: DASH -> visible for the first
// half of the window -> one deliberate fade for the second half -> normal
// display resumes the instant invincibility ends. ESCAPE_DASH_BLINK_MS
// itself (the actual invincibility/blink WINDOW duration) is unchanged.
const ESCAPE_DASH_BLINK_MS = 300;
const ESCAPE_DASH_BLINK_TOGGLE_MS = 75; // legacy — no longer read by the blink render logic, kept only for the existing test-export
const ESCAPE_DASH_BLINK_CYCLES = 1; // exact number of "visible -> invisible" flashes per DASH, deterministic regardless of wall-clock phase
// NEXT ROUND PART M: how long a single lateral-DASH afterimage snapshot
// takes to fully fade — "afterimages fade quickly" per spec, never a long
// lingering trail.
const ESCAPE_AFTERIMAGE_MS = 220;
// NEXT ROUND PART N: normal (non-DASH) EAST/WEST movement leans the whole
// bike sprite up to this many degrees toward the travel direction, and
// ESCAPE_LEAN_SMOOTH_RATE controls how quickly it eases toward/away from
// that target (never instant, per spec) — an exponential per-second rate.
const ESCAPE_LEAN_MAX_RAD = 30 * Math.PI / 180;
const ESCAPE_LEAN_SMOOTH_RATE = 9;
const ESCAPE_ANIM_FRAME_MS = 45; // NEXT ROUND PART A: was 90 — halved to match ESCAPE_AUTO_SCROLL_SPEED's doubling so PLAYER anim and stage scroll read as the same speed (time-elapsed interval, drives the always-on 5-frame RUN LOOP)
// 11TH ROUND (item 5): investigated first — ESCAPE's continuous lateral
// move had NO separate smoothing/acceleration/interpolation layer at all;
// it applies raw input directly to strafeOffset every frame
// (updateEscapePlayer()). The ONE real lever between "stick pushed" and
// "player visibly reacts" turned out to be the shared applyLightCurve()
// helper the LEFT STICK path reused (pollGamepad()'s ESCAPE branch) —
// LIGHT_DEADZONE=0.16/LIGHT_CURVE_POWER=2.0 (tuned for flashlight aiming,
// not run-and-dodge) meaningfully compresses small/medium stick pushes
// (e.g. a 50% push only yielded ~16% effective output — see completion
// report for the exact before/after numbers). A SEPARATE, ESCAPE-only
// curve — never touching LIGHT_DEADZONE/LIGHT_CURVE_POWER themselves, so
// LAB's flashlight feel is completely unaffected — with a lower deadzone
// and gentler curve makes partial-stick input register meaningfully
// sooner, i.e. a genuinely quicker STICK RESPONSE, without touching
// ESCAPE_STRAFE_SPEED (the top-speed-once-fully-deflected value).
const ESCAPE_MOVE_DEADZONE = 0.12;
const ESCAPE_MOVE_CURVE_POWER = 1.7;
// 9TH ROUND (item 36-38): ESCAPE MODE had no time-limit clear condition at
// all before this round — investigated first, confirmed no existing
// constant of this kind anywhere in the file, so per spec introduced as its
// own new, independently-tunable value rather than a silently-decided
// balance number. Counts down real elapsed seconds (state.escape.timeLeftSec,
// reset by setGameMode() whenever ESCAPE MODE is (re-)entered), reaching 0
// triggers the shared CLEAR SEQUENCE (see triggerClearSequence()).
const ESCAPE_TIME_LIMIT_SEC = 90;
// 9TH ROUND (item 37): ESCAPE-exclusive enemy pursuit. Round 8 already
// diagnosed WHY plain enemy z never becomes attack-eligible in ESCAPE: its
// reversed background-scroll direction feeds applyForwardDelta() a negative
// forwardDelta, which (per the SAME unconditional zMin-floor math COMBAT
// relies on) only ever pushes enemy z UP toward ENEMY_Z_MAX, away from the
// z<900 attack-eligibility gate updateEnemy() shares with COMBAT. Rather
// than touch that shared gate or applyForwardDelta() (both must stay exactly
// as COMBAT needs them), ESCAPE gets its own separate, additive pursuit
// oscillation (see updateEscapeEnemyPursuit()) that only ever runs when
// state.gameMode==='escape' and only while the enemy's own attack sequence
// isn't already driving z itself (attackState==='idle') — a real
// pursue-closer / fall-back cycle, not a raw "always close" hack, so the
// player genuinely gets alternating danger/breathing-room windows to dodge.
const ESCAPE_ENEMY_PURSUIT_MIN_Z = 500;
const ESCAPE_ENEMY_PURSUIT_MAX_Z = 1100;
const ESCAPE_ENEMY_PURSUIT_PERIOD_MS = 6000;
// 9TH ROUND (item 30-35): CLEAR SEQUENCE phase durations — real elapsed-time
// budgets, not frame counts (see updateClearSequence()). Named/tunable
// rather than inline magic numbers, same convention as every other timing
// constant in this file.
const CLEAR_GATE_APPEAR_MS = 900;
const CLEAR_GATE_OPEN_MS = 1100;
const CLEAR_PLAYER_RUN_MS = 1400;
const CLEAR_LIGHT_EXPAND_MS = 900;
const CLEAR_WHITEOUT_MS = 700;
const CLEAR_HOLD_WHITE_MS = 400; // brief full-white hold before fading back, so the cut never feels like a single-frame flash
// 8TH ROUND (item 16): SOUTH's single-static-image "breathing" pulse — see renderEscapePlayer().
const SOUTH_PULSE_PERIOD_MS = 420;
const SOUTH_PULSE_AMPLITUDE = 0.03; // scale ranges [1.0, 1.03] — spec cap "must never exceed ~103%"

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
// 7TH ROUND PART 9 ("GABRIELが通常時に近づきすぎる"): GABRIEL_Z_MIN (145)
// used to be the SAME floor for both normal player-driven approach
// (applyForwardDelta()) AND the CLAW attack's own fast-approach target
// (updateEnemy()'s 'claw' branch) — meaning normal walking could already
// push GABRIEL all the way to its closest possible distance, leaving the
// attack's "fast close-the-distance dash" with nothing left to actually
// close. GABRIEL_NORMAL_Z_MIN is a SEPARATE, larger floor used only for
// the normal-state approach clamp; GABRIEL_Z_MIN itself is UNCHANGED and
// still governs the CLAW attack's own approach target/closeBoost render
// math, so "攻撃時は現在の接近距離でよい" holds exactly as before.
const GABRIEL_NORMAL_Z_MIN = 260;
// 5TH ROUND PART 7: ADAM shares GABRIEL's own crop-toward-upper-body
// approach formula (same "family" boss in ACTION-GAME, same human scale) —
// given its own, independently-tunable constant rather than literally
// reusing GABRIEL_Z_MIN, but seeded at the identical value since there is
// no real signal it should differ and this project's rule is never to
// invent numbers without a reason.
const ADAM_Z_MIN = 145;
// 9TH ROUND (item 26): ADAM previously had NO normal-state floor of its own
// (applyForwardDelta() fell through to ADAM_Z_MIN=145 for type==='adam'),
// so ADAM never recovered to a mid "stalking" distance after an attack and
// stayed pinned at its closest possible range permanently — the real-device
// "ADAMが近づいたまま戻らない" complaint. Given its own floor at parity with
// GABRIEL_NORMAL_Z_MIN per the user's "可能なら同じ基準値を" guidance (an
// explicit judgment call, noted honestly since no exact number was mandated).
const ADAM_NORMAL_Z_MIN = 260;
// 9TH ROUND (item 33): eases GABRIEL/ADAM's z back from their close
// CLAW_Z_MIN out to their own NORMAL_Z_MIN after an attack completes, instead
// of instantly snapping (the old bug: applyForwardDelta()'s per-frame floor
// used to yank GABRIEL back to 260 the instant 'approach' ended, mid-swing).
const CLAW_RECOVERY_MS = 900;
// 10TH ROUND (items 19-21): 9TH ROUND's SOUTH WALK LOOP only ever changed
// which IMAGE was shown during idle — it never touched e.z, so GABRIEL/ADAM
// spawned (and recovered) already sitting exactly at their own
// *_NORMAL_Z_MIN floor, leaving zero room to visibly "walk closer": the
// walk-frames cycled but the boss never actually got nearer, reading as
// marching in place on real devices. STALK_Z is a second, slightly farther
// floor bosses now spawn at AND ease back out to after RECOVERY; idle-state
// autonomous creep (see updateEnemy()) then closes that gap down to
// *_NORMAL_Z_MIN on its own, at CLAW_STALK_SPEED, independent of the
// player's own forward movement — giving the walk loop real ground to
// cover. *_NORMAL_Z_MIN itself is UNCHANGED and still the hard floor
// (idle-state creep and the player's own applyForwardDelta() push both
// still stop there) — only ATTACK's own 'approach' sub-state still goes
// closer than this, exactly as 9TH ROUND left it.
const GABRIEL_STALK_Z = GABRIEL_NORMAL_Z_MIN + 180;
const ADAM_STALK_Z = ADAM_NORMAL_Z_MIN + 180;
const CLAW_STALK_SPEED = 40; // world-z units/sec of autonomous idle approach
// 14TH ROUND (items 9-11): DRONE/ROID1/ROID2/ADAM SPHERE (non-claw types)
// spawn at e.z===900 (spawnEnemy()) and, unlike GABRIEL/ADAM (CLAW_STALK_SPEED
// above, added 10TH ROUND), had no autonomous way to ever close that gap —
// only the player's OWN forward walk ever decreased e.z, and the idle->attack
// gate requires e.z < 900 STRICTLY. A player who doesn't walk forward left
// e.z pinned at exactly 900 forever, so the enemy could never even begin an
// attack roll (confirmed via live measurement: z stayed at 900 for 3+
// straight seconds of idle play with zero drift, in COMBAT). Same
// autonomous-creep pattern as CLAW_STALK_SPEED, applied to non-claw types.
const ENEMY_IDLE_APPROACH_SPEED = 40; // world-z units/sec, COMBAT-mode only (see updateEnemy())
// 14TH ROUND (items 5-8): compressed chain-explosion, ported from ACTION-
// GAME's (DARKOUT 1's) own boss-death explosion pattern — updateRoidDeath()/
// updateAdamSphereCombat()'s "targetCount = min(COUNT, floor(elapsed/WINDOW*
// COUNT)+1), spawn while spawned<targetCount, scatter around a center" time-
// driven progressive-spawn algorithm — the SAME shape, reused rather than
// inventing a new effect from scratch, but compressed from that codebase's
// ~1300-5000ms boss-death chains down to ~900ms for a normal attack impact
// (spec: "バババババッ", read instantly, not a spectacle). Reuses this
// game's OWN existing particle types (explosionFlash/spark/smoke/shockwave)
// rather than porting ACTION-GAME's separate particle engine literally.
const EXPLOSION_CHAIN_COUNT = 6;
const EXPLOSION_CHAIN_WINDOW_MS = 900;
const EXPLOSION_CHAIN_SCATTER_PX = 30; // base scatter radius, scaled by e.explosionChainScale
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
// 9TH ROUND (item 29): was 480 (identical to GABRIEL_WORLD_HEIGHT), which
// read as "ADAM looks the same size as GABRIEL" on real devices — bumped
// ~15% larger. computeEnemyDrawRect() derives drawH directly from this
// constant via proj.scale (screen-anchored to the shared proj.y ground
// point, with the same anchorFrac foot-correction GABRIEL already uses), so
// this is real anchor-aware scaling, not a raw canvas magnification hack —
// ADAM's foot/attack position does not drift from this change.
const ADAM_WORLD_HEIGHT = 560;
// 7TH ROUND PART 5 ("ADAM SPHEREが約2.5倍大きすぎる"): ADAM SPHERE went
// through the SAME ROID-style render branch as ROID1/ROID2 in
// computeEnemyDrawRect(), which used to target ROID_WORLD_HEIGHT (700) for
// EVERY enemy on that code path — i.e. ADAM SPHERE was drawn at the same
// on-screen size as a giant ROID mech. Given its own target height
// (=ROID_WORLD_HEIGHT/2.5, per spec's own "現在サイズ÷2.5" guidance),
// ROID1/ROID2 themselves are completely untouched (they still read
// ROID_WORLD_HEIGHT directly). Aspect ratio is preserved automatically —
// computeBodyVisualScale()/the ROID-style branch derive width from the
// SAME uniform scale factor as height, for whichever real source image is
// actually drawn.
const ADAM_SPHERE_WORLD_HEIGHT = ROID_WORLD_HEIGHT / 2.5; // = 280
// 10TH ROUND (items 37-39): DRONE's real on-screen size relative to other
// enemies, derived from ACTION-GAME's own real constants rather than
// guessed — its SECURITY_ROBOT_DRAW_D (DRONE diameter) is exactly HALF of
// ADAM_SPHERE_TARGET_DIAMETER there (`SECURITY_ROBOT_DRAW_D * 2`), so DRONE
// here is sized at half of this project's own ADAM_SPHERE_WORLD_HEIGHT.
const DRONE_WORLD_HEIGHT = ADAM_SPHERE_WORLD_HEIGHT / 2; // = 140
// 7TH ROUND PART 7 ("常時回転しているように見せる"): continuous rotation
// cadence for ADAM SPHERE's own 4 real frames (adam_sphere_01..04.png) —
// independent of ROID_FIRE_FRAME_MS (which only ever applies to ROID1/
// ROID2's attack-only FIRE ping-pong). Slower than ROID_FIRE_FRAME_MS
// (110ms) since this plays constantly, not just during a brief attack
// flourish — reads as a steady rotation, not a flicker.
const ADAM_SPHERE_ROTATE_FRAME_MS = 220;
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
// 9TH ROUND (item 21): was 150 — reported per the user's "state current value
// before changing" requirement. Shrunk ~30% so a boss's whole body is never
// trivially visible without aiming the light at it (verified against
// GABRIEL/ADAM draw sizes at NORMAL distance during this round's testing).
// 11TH ROUND (item 23): was 105 — shrunk a further ~10% (105 * 0.90 = 94.5).
// Center position and AIM-follow speed are untouched, only this radius.
// 12TH ROUND (item 50): was 94.5 — shrunk a further ~50% (94.5 * 0.50 =
// 47.25) per explicit spec instruction. Center position and AIM-follow
// speed remain untouched; AIM is now additionally CLAMPED to stay inside
// this circle (see getAimPoint()) so the crosshair can never leave the lit
// area at all, not just visually — see item 52's own comment there.
const FLASHLIGHT_BASE_RADIUS = 47.25;
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
// 7TH ROUND PART 10 ("AIMの反応が悪い" investigation): 2.9 heavily
// suppressed small/medium stick deflections (output ~0.134 at half
// deflection per the old comment below) — a real, deliberate cause of
// "細かな操作に反応しない". Eased to 2.2 (between round 1's original 2.2
// and round 2/3's steeper 2.6/2.9) so low/medium input produces
// proportionally more output while full deflection still reaches the same
// max range — a moderate curve change, not a blanket sensitivity hike
// (AIM_DEADZONE/AIM_RANGE are both unchanged, still the same anti-drift/
// max-reach bounds as before).
const AIM_CURVE_POWER = 2.2; // was 2.9 (3rd round), 2.6 (2nd round), 2.2 (1st round)

// PART 5/6 (3rd round): AIM is no longer "flashlight-relative" — it has its
// own resting point (the player's own screen-space centerline, PART 5) plus
// a persistent manual offset (PART 6, LT/RT+D-PAD) plus a live offset.
// 4th round: the live offset is now purely velocity-integrated and NEVER
// auto-recenters (see AIM_MOVE_SPEED_PX_S above and updatePlayer()'s own
// AIM section) — the old "relaxes back to 0 on release" behavior this
// comment used to describe was exactly the bug this round was asked to fix.
const AIM_MANUAL_SPEED = 140; // px/sec, D-PAD-driven height/horizontal trim while LT/RT is held alone
const AIM_MANUAL_MAX_OFFSET = 70; // px, clamp on each manual-offset axis

// 7TH ROUND PART 12 ("画面端でAIM可動範囲が変わる" investigation): the
// underlying AIM INPUT (aimLiveX/Y, ±AIM_RANGE) was already confirmed to
// be completely independent of the player's own screen position/
// strafeOffset — nothing clamps it against cssW/cssH anywhere. What
// genuinely does need edge-safety is the FINAL resolved screen point
// (getAimPoint()'s return value — the same point the crosshair renders at
// AND fire()/AUTO AIM/hit-testing all read), since baseX itself shifts
// with strafeOffset and can otherwise carry the reticle very close to (or
// past) the canvas edge when the player is strafed to an extreme. This
// margin bounds ONLY that final exported point — never aimLiveX/Y, never
// AIM_RANGE — so the input range itself is never shrunk, exactly per spec
// ("入力レンジそのものを縮めることではありません").
const AIM_SCREEN_SAFE_MARGIN_PX = 26;
// 12TH ROUND (item 52): small inward margin for the AIM-inside-LIGHT clamp
// (see getAimPoint()) so the crosshair visibly sits inside the lit disc's
// edge rather than exactly riding its boundary line.
const AIM_LIGHT_CLAMP_MARGIN_PX = 6;

// 7TH ROUND PART 11: CONTROLLER-only AIM sensitivity, adjustable from
// PAUSE (see #aim-sens-row in index.html / the click handlers below).
// Applied ONLY to the gamepad's own curved aim axis before it's written
// into state.input.aimX/Y — TOUCH AIM's contribution is read completely
// unaffected by this, per spec ("TOUCH側とは必要に応じて別管理").
// 15TH ROUND (items 35-39): re-investigated the existing 3-tier system —
// it was LOW(0.7)/NORMAL(1.0)/HIGH(1.4), defaulting to NORMAL. Per this
// round's explicit instruction, whichever tier was SLOWEST becomes the new
// STANDARD/default going forward (LOW's own 0.7 value, unchanged), with
// the other two tiers reconstructed around it as SLOW (finer than
// STANDARD) and FAST (quicker than STANDARD, reusing the old NORMAL value
// so a player who liked the old default keeps that exact feel under its
// new FAST label). Scoped to RIGHT STICK AIM only — see
// controllerAimSensitivity's own read site (state.input.aimX/Y) below;
// LEFT STICK LIGHT (applyLightCurve()) and player MOVE never read this at
// all, so neither is affected by this change (item 38).
const AIM_SENSITIVITY_PRESETS = { slow: 0.5, standard: 0.7, fast: 1.0 };
let controllerAimSensitivity = AIM_SENSITIVITY_PRESETS.standard;

const FIRE_COOLDOWN_MS = 130;
// 12TH ROUND (item 9): MAG_SIZE 12->30. RESERVE_MAX scaled by the SAME
// ratio it always had to MAG_SIZE (48/12 = 4x) rather than picking an
// arbitrary new number, so the number of full reloads available before
// the reserve-refill safety net (see updatePlayer()'s RELOAD block) kicks
// in stays consistent with the pre-round balance.
const MAG_SIZE = 30;
const RESERVE_MAX = 120;
const RELOAD_MS = 950;
// 9TH ROUND (items 3-5): real-device DEBUG log showed a genuine
// permanent-lock bug — investigation of updatePlayer()'s RELOAD block
// confirmed there was NO existing "AUTO RELOAD" trigger anywhere in the
// codebase at all (only `actions.reload`, the manual RELOAD button, ever
// started a reload). Once ammo hit 0 without the player pressing RELOAD
// themselves, nothing ever started a reload again — this is the actual
// root cause of the observed calls:1043/success:12/reject:1031 NO AMMO
// lock. Since no prior "AUTO RELOAD = 5s" constant existed anywhere in
// code (contrary to the assumption in this round's request), this is a
// NEW, explicitly-named, independently-tunable constant — never silently
// reusing RELOAD_MS's identity for a different, undocumented meaning.
// Currently equal to RELOAD_MS (950ms) since the manual reload's own
// duration was already tuned and nothing suggested it should differ; kept
// as its own constant so it CAN be tuned independently later.
const AUTO_RELOAD_MS = RELOAD_MS;
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
// 12TH ROUND (item 10): current value (500) read and doubled, per spec —
// not a guessed replacement number.
const PLAYER_MAX_HP = 100 * 5 * 2;
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
// 7TH ROUND PART 14/15/16: FIRE no longer swaps to the separate
// player_north_fire.png art (which has its own baked-in flash drawn at a
// DIFFERENT screen position than the procedural muzzle particle, and read
// as a jarring pose-jump when it stayed on-screen for the whole button
// hold regardless of the real ~130ms shot cadence). Firing now reuses the
// SAME north-facing aim image, briefly enlarged, synced to each REAL shot
// (see fireWeapon()'s p.lastShotAt) instead of the raw held-button state —
// a held FIRE now visibly pulses normal->enlarged once per actual shot.
// FIRE_POSE_HOLD_MS is shorter than FIRE_COOLDOWN_MS (130ms) so consecutive
// shots read as distinct pulses rather than one continuous enlarged pose.
const FIRE_POSE_HOLD_MS = 90;
// 11TH ROUND (item 14): was 1.03 (8TH ROUND). Investigated the FINAL
// visible size, not just this constant in isolation: player_north_aim.png
// and player_north_fire.png measure to nearly identical real alpha bounds
// (topFrac 0.0147 vs 0.0176, bottomFrac both 0.9882 — Python/Pillow
// row-coverage measurement), so this factor translates almost 1:1 into
// visible body-height change, with essentially no padding difference
// absorbing any of it. 1.03 was a genuine ~3% visible growth, over spec's
// ±2% cap — reduced to 1.02. Anchor/centering math untouched.
const FIRE_POSE_SCALE_BOOST = 1.02;
// 7TH ROUND PART 17: the fraction down from the TOP of the player's own
// drawn sprite rect where the raised-arm/gun sits — read directly off
// player_north_aim.png/player_north_fire.png (both share the same raised-
// arm pose), not a guessed absolute pixel offset. Used by
// computePlayerDrawRect()/fireWeapon() so the muzzle flash/bullet origin
// tracks the player's ACTUAL on-screen size instead of a fixed formula.
const MUZZLE_HEIGHT_FRAC = 0.27;
// 11TH ROUND (items 24-27, 44-48): SOUTH WALK re-fix (SUPERSEDED — see
// 15TH ROUND note below). Round 10's continuous sin-based body-bob (a
// single real image sliding smoothly up/down) was judged on real devices
// as still reading like "a static image sliding," not walking. At the
// time there was still only ONE real south-facing image on disk
// (player_dash_south.png), so a DISCRETE Canvas-transform trick
// (SOUTH_WALK_FRAME_OFFSETS, formerly defined here) simulated 3 distinct
// poses from that single source image via small per-frame lean/bob/scale
// offsets, stepped through in lockstep with the SAME p.walkFrame index
// NORTH's own 3-frame walk[] cycle already uses.
// 15TH ROUND (items 4-9, 40-41): the user supplied 3 genuine south-facing
// walking photographs — SOUTH_WALK_FRAME_OFFSETS' pseudo-walk trick is no
// longer needed and has been removed; ASSETS.player.southWalkFrames[] (3
// real coverSpriteFrame()-measured images) plus renderPlayer()'s
// usingSouthWalkPose branch (reusing computeBodyVisualScale(), the SAME
// alpha-bounds normalization COVER/ROID/ESCAPE already use) replace it.

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
// 15TH ROUND (items 29-34): FOCUS's activation moved off LB (which was
// double-booked with RELOAD — see edge(4)'s own comment below) onto a
// RIGHT-STICK-CLICK (R3, standard-mapping button 11) HOLD, so a quick tap
// never triggers it (avoiding an accidental FOCUS toggle from a player just
// resting a finger on R3) while a deliberate hold still feels responsive.
// 500ms sits in the middle of the ~400-600ms guideline range — short enough
// that a real hold doesn't feel laggy, long enough that a reflexive/
// accidental tap (well under 300ms on a real controller) never fires it.
const FOCUS_R3_HOLD_MS = 500;

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
// 7TH ROUND PART 10: raised from 460 (still a deliberate, bounded sweep —
// AIM_RANGE itself is unchanged — not an "extreme sensitivity" jump) so a
// held full-deflection input catches up to the target noticeably faster,
// addressing "遅れてついてくる感覚" for BOTH gamepad and touch AIM (touch's
// own raw -1..1 drag feeds this exact same velocity integration — see
// updatePlayer()'s AIM section).
const AIM_MOVE_SPEED_PX_S = 620;
// 13TH ROUND (items 9-19): LIGHT's own persistent-position move speed —
// same role as AIM_MOVE_SPEED_PX_S, deliberately a bit slower since
// sweeping the flashlight is a broader gesture than fine AIM adjustment.
const LIGHT_MOVE_SPEED_PX_S = 520;

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
// 7TH ROUND PART 20 ("ボスHPを現在の3倍へ"): this prototype has exactly
// one enemy-HP concept — ENEMY_MAX_HP — shared by every selectable
// identity (ROID1/ROID2/GABRIEL/ADAM/ADAM SPHERE). Investigated first:
// there is no separate "regular enemy"/mob tier anywhere in this repo
// (DRONE, the only non-boss-scale identity in ENEMY_SELECT_ORDER, has no
// asset/AI/HP of its own at all — see ENEMY_IMPLEMENTED) — every single
// entity this constant applies to IS a boss fight, so tripling it here
// cannot accidentally also triple some other, non-boss enemy's HP.
const ENEMY_MAX_HP = 100 * 3; // was 100
// 10TH ROUND (item 40): ROID1/ROID2 specifically doubled (300->600) — real-
// device feedback said they were "too weak" compared to GABRIEL/ADAM/ADAM
// SPHERE, which all keep the shared ENEMY_MAX_HP (300) unchanged.
const ROID_MAX_HP = ENEMY_MAX_HP * 2;
// 10TH ROUND (items 41-48): ROID1/ROID2 counter-phase system. Crossing each
// of these remaining-HP fractions (checked high-to-low, descending) once
// triggers ONE invulnerable counter-phase — e.triggeredThresholds tracks
// which have already fired so straddling/multi-hit frames can never
// double-trigger the same threshold (item 43's explicit requirement).
const ROID_COUNTER_THRESHOLDS = [0.8, 0.6, 0.4, 0.2];
const ROID_COUNTER_PHASE_MS = 5000; // invulnerable window — long enough for ~1-2 real attack cycles via the EXISTING sniper/missile attack machinery, reused unchanged
const ROID_COUNTER_BLINK_MS = 700; // reuses the existing hit-flash brightness pulse, not a new visual system

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
// COVER ACTION (drum-can hiding pose): the crouched COVER sprite's target
// visual body height, as a fraction of the player's OWN current standing
// body height (ASSETS.player.aim.naturalHeight at the same baseScale/
// p.scale renderPlayer() already uses) — so the crouch reads as genuinely
// lower than standing rather than a re-scaled stand-in. 0.62 is a
// moderate crouch reduction (a real crouch/kneel is roughly 55-70% of
// standing height); verified visually via screenshot, adjustable here if
// a different depth is wanted later.
const COVER_HEIGHT_RATIO = 0.62;

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
// 12TH ROUND (items 20-24): world-space TARGET AREA base depth for the
// MISSILE impact point (WORLD X / WORLD DEPTH(Z) -> project() -> screen),
// shared with the shadow work items 60-75 build on top of. Offset by the
// player's own current depthPos the same way PLAYER_DEPTH_SCALE_RANGE
// scales the player sprite, so the target ellipse's apparent size responds
// to the same shared depth state as the player and BARREL/structures.
const MISSILE_TARGET_BASE_WORLD_Z = 130;
const MISSILE_TARGET_WORLD_Z_RANGE = 40;
// 12TH ROUND (items 60-75): the falling PROJECTILE's starting WORLD HEIGHT
// above its locked impact point, and the fixed screen-space radius its
// midair intercept hit-test uses (see updateBullets()) — a generous, easy-
// to-hit target befitting "shoot it down" being a real, viable counter.
const MISSILE_PROJECTILE_START_HEIGHT = 240;
const MISSILE_PROJECTILE_HIT_RADIUS_PX = 26;
const MISSILE_DAMAGE = 24;

// ---------------------------------------------------------------------
// 16TH ROUND PART S: ROID1/ROID2 "attack like the enemy would really
// attack" rebuild — replaces the old "lock -> one shot -> long wait ->
// one shot" monotony with two sustained-pressure patterns, scoped to
// roid1/roid2 ONLY (drone/adamSphere keep their existing missile/sniper
// pool untouched — out of this part's scope). Investigated ASSETS.roid1/
// ASSETS.roid2 first (item 159): both share the exact same generic
// search[]/fire[] frame naming with no rifle-vs-missile-launcher visual
// distinction anywhere in the asset filenames, so no real basis exists to
// invent a stronger ROID1-is-rifle / ROID2-is-missile personality split —
// both types draw from the SAME sweep/barrage/sniper pool (see item 159's
// explicit "no fabricated lore" instruction).
// ---------------------------------------------------------------------

// SWEEP FIRE (RIFLE/MINIGUN horizontal burst) — a single LOCK of the
// player's WORLD X/Z at attack start, then a fast horizontal line of
// impact points sweeping across that locked position in WORLD SPACE
// (never re-tracking the player mid-burst — item 127/135), rendered via
// project() through the same perspective pipeline as everything else.
const SWEEP_TELEGRAPH_MS = 260; // brief charge (FIRE-pose swap only, no LOCK ON UI — item 137/138)
const SWEEP_BULLET_COUNT_MIN = 7;
const SWEEP_BULLET_COUNT_MAX = 10; // item 132: "PLAYERが横方向へ掃射されていると認識できる弾数"
const SWEEP_BULLET_COUNT_ENHANCED_BONUS = 3; // 40%-threshold counter gets a longer, wider burst (item 156 "SWEEP FIRE強化")
const SWEEP_BULLET_INTERVAL_MS = 85; // "ババババババッ" — fast, never one-shot-then-long-wait
const SWEEP_HALF_WIDTH_WORLD = 95; // world-X half-span of the sweep from the locked center point
const SWEEP_HIT_RADIUS_PX = 42; // screen-space per-bullet hit test radius, real distance check (item 136)
const SWEEP_DAMAGE = 9; // lower per-hit than a single SNIPER shot since several can land in one burst
const SWEEP_TRACER_LIFE_MS = 90; // short tracer only (item 139) — never a long white line
const SWEEP_COOLDOWN_MS = 1200;

// MULTI MISSILE BARRAGE — one LOCK of the player's WORLD X/Z, then 3-4
// missiles with impact points scattered AROUND that single locked point
// (never independently re-locked per missile — item 143), launched with a
// short stagger so impacts read as BOOM->BOOM->BOOM->BOOM rather than one
// single blast. Each impact reuses the 16TH ROUND PART A/B/C spawnBlast()
// pipeline directly (never the old asterisk-style effect — item 153).
const BARRAGE_LOCKON_MS = 550;
const BARRAGE_LAUNCH_INTERVAL_MS = 200; // NEXT ROUND PART G: was 320 — tightened so impacts read as "piling on" while still leaving each blast individually visible (not simultaneous)
const BARRAGE_FALL_MS = 850; // each missile's own fall duration, reuses MISSILE_PROJECTILE_START_HEIGHT
const BARRAGE_IMPACT_TAIL_MS = 260; // grace after the LAST impact before cooldown begins
const BARRAGE_COOLDOWN_MS = 1900;
// item 144: intentional (never fully random — item 145) scatter pattern
// around the single locked point — CENTER, RIGHT, LEFT, NEAR/FAR, in that
// priority order (a 3-missile barrage uses the first 3, 4-missile uses all
// 4); a small jitter is layered on top so repeated barrages don't look
// identical, without losing the "aimed around the lock point" read.
const BARRAGE_OFFSET_PATTERN = [
  { dx: 0, dz: 0 },
  { dx: 72, dz: -10 },
  { dx: -72, dz: -10 },
  { dx: 8, dz: 34 },
];
const BARRAGE_OFFSET_JITTER = 14;

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
// 15TH ROUND (items 14-17): real-device play read the 220ms close-the-
// distance dash as "abnormally fast," close to an instant teleport to melee
// range. Slowed to a genuinely visible closing run (still a purposeful
// approach, not a slow walk) — CLAW_APPROACH_MS alone controls this; the
// eased-tween code that consumes it (updateEnemy()'s 'approach' sub-state)
// is untouched, so the approach simply takes longer to cover the same
// distance instead of gaining a new curve/overshoot.
const CLAW_APPROACH_MS = 480;
// 15TH ROUND (items 15-16): CLAW_WINDUP_MS is now long enough to hold a
// genuine "decelerate/stop -> 2 SLOW, clearly-countable blinks -> attack"
// telegraph (see renderEnemy()'s own inSlowTelegraph block below) instead
// of the old single 280ms brief flicker — explicitly NOT a fast/strobing
// flicker (item 16). Reused verbatim by 'counterAttack' (item 17: the
// 5-HIT COUNTER's own close-range attack gets the SAME telegraph, not a
// separate/parallel one).
const CLAW_WINDUP_MS = 640;
const CLAW_SWING_MS = 140;      // unchanged from the old single impact duration
const CLAW_COOLDOWN_MS = 1200;  // unchanged from the old cooldown duration
const CLAW_DAMAGE = 20;         // unchanged value, now a named constant
// Real lateral reach at the swing instant — a bit under STRAFE_DASH_DISTANCE_PX
// (100px) so a single, well-timed DASH reliably clears it, matching spec
// item 9's "DASHで回避可能" requirement without making it trivial to avoid
// by accident (deadzone/idle drift alone won't clear 95px).
const CLAW_HIT_RANGE_PX = 95;

// 14TH ROUND (items 22-43): GABRIEL/ADAM-only DEFENSE/re-aim/COUNTER system.
// Investigated first (see ASSETS.adam's own 5TH-round comment: "ACTION-
// GAME's fuller DEFENSE/counter-attack system for ADAM is NOT ported — out
// of this round's scope"): ACTION-GAME's GABRIEL/ADAM boss has a real
// DEFENSE state (boss.state==='defense') and a forced COUNTER at
// WEAKPOINT_FORCED_COUNTER_HITS=5 total weak-point hits — this round adapts
// that SAME design pattern (accumulate real hits -> forced counter at a
// hit total) rather than inventing an unrelated mechanic, scaled down to
// this game's simpler single-hitbox CLAW system (no separate weak point/
// guard-break/ARC-CLAW/DARK-PHASE machinery — out of scope here). ROID1/
// ROID2's own, completely separate 80/60/40/20 counter-phase system
// (ROID_COUNTER_THRESHOLDS et al.) is NEVER touched by any of this — see
// item 42 / the isClawBoss guards throughout.
const GABRIEL_ADAM_DEFENSE_HIT_CYCLE = 2; // real hits accepted before DEFENSE begins (3rd+ within the same cycle deals 0)
const GABRIEL_ADAM_COUNTER_TOTAL_HITS = 5; // total real (re-armed) hits -> forced COUNTER, mirrors ACTION-GAME's WEAKPOINT_FORCED_COUNTER_HITS
const GABRIEL_ADAM_DAMAGE_INTERVAL_MS = 300; // minimum ms between damage-eligible hits — item 27
// item 39: horizontal re-aim threshold, chosen relative to FLASHLIGHT_BASE_
// RADIUS/AIM's own reachable range inside LIGHT (see getAimPoint()) — half
// the LIGHT radius is a deliberate, clearly-not-jitter move that still stays
// reachable without also having to reposition LIGHT itself.
const GABRIEL_ADAM_REAIM_THRESHOLD_PX = FLASHLIGHT_BASE_RADIUS * 0.5;
const GABRIEL_ADAM_DEFENSE_MS = 1100; // item 36: bounded, non-permanent — always exits back to normal battle (or into COUNTER at 5 hits)
// 15TH ROUND (item 17): kept deliberately FASTER than the normal
// CLAW_APPROACH_MS (480ms) — the user explicitly allows the 5-HIT COUNTER's
// own approach to stay quicker than a normal attack's — but bumped up from
// the original 260ms so it still reads as a fast lunge rather than an
// instant teleport, matching item 38's own requirement.
const GABRIEL_ADAM_COUNTER_APPROACH_MS = 340; // fast, visibly-tweened lunge — never an instant teleport (item 38)

const ENEMY_TURN_COOLDOWN_MS = 850; // "heavy mech" — can't re-flip facing more often than this
const ENEMY_TURN_HYSTERESIS_PX = 36; // player must cross this far past center before a flip is even considered

// 12TH ROUND (items 36-40): per-type PLAYER-X-axis tracking speed
// multiplier, applied to updateEnemyFacing()'s existing lane-follow rate —
// DRONE/ADAM SPHERE (fast, small flying/floating) track quickly, ROID1/
// ROID2 (giant mechs) stay at the original 1x baseline, GABRIEL/ADAM
// (heavy melee humanoid) track slowly.
const ENEMY_LANE_TRACK_MULT = {
  drone: 1.8,
  adamSphere: 1.8,
  roid1: 1.0,
  roid2: 1.0,
  gabriel: 0.55,
  adam: 0.55,
};

// 11TH ROUND (items 15-16, 34): investigated first — before this round,
// EVERY non-claw type (roid1/roid2/adamSphere/drone) shared byte-identical
// idle-recheck timing (the ONLY thing that actually controls "how often a
// new attack cycle starts" — see updateEnemy()'s idle-state
// nextIdleCheckAt assignments below), so there was no per-type
// differentiation to begin with, and all 6 types read as attacking too
// rarely on real devices. Rather than "halve every cooldown" (explicitly
// banned by item 16 — that would also compress CLAW_COOLDOWN_MS/
// SNIPER_COOLDOWN_MS/MISSILE_COOLDOWN_MS, i.e. the attack's OWN recovery
// state timing, risking the telegraph/impact/counter-phase state machines
// item 16 says not to break), this scales ONLY the idle-wait windows
// (first-attack delay + the random wait rolled after each attack's own
// cooldown ends) — never the attack sequence itself. Each type gets its
// own multiplier so the round's own "各敵の個性を維持" requirement holds:
// DRONE (a real ACTION-GAME "SECURITY DRONE" scout) is tuned most
// aggressive; ADAM SPHERE (a slow-rotating stationary turret in its own
// source material) stays the most patient of the group.
// 15TH ROUND (items 24-28): real-device play still showed ROID1/ROID2/
// DRONE/ADAM SPHERE leaving the player "一方的に撃っている" for too long,
// even after the 14TH ROUND's own tuning — explicitly NOT to be judged by
// the 30-second attack-COUNT numbers alone (item 24); the metric that
// actually matters is the MAXIMUM IDLE GAP (longest real elapsed time from
// one attack ending to the next beginning, item 27). Reuses the SAME
// architecture (enemyAttackFreqMult()/idle-wait-window scaling) rather than
// a new timer system (item 26) — only the 4 in-scope types' multipliers are
// lowered here (roughly 30-40% further), further shrinking the random
// idle-wait window that directly drives max idle gap, while the attack's
// OWN telegraph/impact/recovery/cooldown timing is completely untouched
// (item 28 — still no overlapping/unavoidable judgment windows). GABRIEL/
// ADAM are explicitly OUT of scope this round (items 24-25 name only
// ROID1/ROID2/DRONE/ADAM SPHERE) and are left at their 14TH ROUND values.
// Relative ordering preserved: DRONE stays most aggressive, ADAM SPHERE
// stays the most patient of the 4.
const ENEMY_ATTACK_FREQ_MULT = {
  drone: 0.35, roid1: 0.50, roid2: 0.48, gabriel: 0.65, adamSphere: 0.55, adam: 0.70,
};
// 13TH ROUND (item 4): ESCAPE keeps continuous attack pressure (SURVIVE +
// dodge, not a quiet run) — reuses the SAME ENEMY_ATTACK_FREQ_MULT/
// enemyAttackFreqMult() every idle-recheck/cooldown site already calls
// (no parallel frequency system), just with this extra ESCAPE-only
// multiplier stacked on top. <1 = shorter wait = more frequent attacks.
const ESCAPE_ATTACK_FREQ_MULT = 0.55;
// NEXT ROUND PART L: ROID1/ROID2/DRONE/ADAM SPHERE (GABRIEL/ADAM explicitly
// excluded per spec) get their OWN much more aggressive ESCAPE-only
// multiplier on top of the same idle-wait-window mechanism above — divides
// the wait window by ~5x (targeting a new attack arriving roughly every
// ~3s), while leaving the attack's own telegraph/impact/cooldown timing
// (and GABRIEL/ADAM's own ESCAPE pacing) completely untouched.
const ESCAPE_ATTACK_FREQ_MULT_BY_TYPE = {
  drone: ESCAPE_ATTACK_FREQ_MULT / 5, roid1: ESCAPE_ATTACK_FREQ_MULT / 5,
  roid2: ESCAPE_ATTACK_FREQ_MULT / 5, adamSphere: ESCAPE_ATTACK_FREQ_MULT / 5,
};
function enemyAttackFreqMult(type) {
  const base = ENEMY_ATTACK_FREQ_MULT[type] || 1;
  if (state.gameMode !== 'escape') return base;
  const escapeMult = ESCAPE_ATTACK_FREQ_MULT_BY_TYPE[type] !== undefined ? ESCAPE_ATTACK_FREQ_MULT_BY_TYPE[type] : ESCAPE_ATTACK_FREQ_MULT;
  return base * escapeMult;
}

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
    // 10TH ROUND item 12: ARMORED's warning lights must read as RED
    // ("赤色警告灯") — was orange (#ff8a3b), which is what the shared
    // warningLight structure kind (below) was drawing them as. warningLight
    // already does everything item 12 asks for structurally (small lights
    // at the left/right edges, blinking randomly/periodically via a
    // per-instance phase offset) — the only thing wrong was the color.
    warn: '#ff3b3b',
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
// 10TH ROUND (items 25-27): AMMO consolidated to ONE readout, #ammo-hud
// (below #focus-hud) — the old top-right #ammo-readout (current/RESERVE)
// and the 9TH ROUND under-HP readout (current/MAGAZINE) both duplicated
// this same information in two other places; both DOM nodes are gone from
// index.html now, replaced by this single set.
const ammoHudReadoutEl = document.getElementById('ammo-hud-readout');
const ammoHudCountEl = document.getElementById('ammo-hud-count');
const ammoHudMagEl = document.getElementById('ammo-hud-mag');
const ammoHudReloadingEl = document.getElementById('ammo-hud-reloading');
const escapeTimeLeftValueEl = document.getElementById('escape-timeleft-value');
ammoHudMagEl.textContent = MAG_SIZE; // static — magazine capacity never changes mid-game
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
// 8TH ROUND: DEBUG MODE panel + FIRE/enemy diagnostics (?debug=1 only —
// see DEBUG_MODE at the very top of this file). r10DebugState is null on
// a normal URL — every read/write below is gated on `DEBUG_MODE` (never
// on r10DebugState's own truthiness) so there is exactly one flag
// controlling all of this, and no normal-URL code path allocates or
// touches it at all.
// ---------------------------------------------------------------------
const r10DebugPanelEl = document.getElementById('r10-debug-panel');
const r10DbgGameEl = document.getElementById('r10-dbg-game');
const r10DbgPlayerEl = document.getElementById('r10-dbg-player');
const r10DbgAmmoEl = document.getElementById('r10-dbg-ammo');
const r10DbgFireEl = document.getElementById('r10-dbg-fire');
const r10DbgShotEl = document.getElementById('r10-dbg-shot');
const r10DbgEnemyEl = document.getElementById('r10-dbg-enemy');
const r10DbgInputEl = document.getElementById('r10-dbg-input');
const r10DbgLogEl = document.getElementById('r10-dbg-log');
// ADDENDUM (COPY DEBUG): the button + its transient success/failure label.
// Both live inside #r10-debug-panel, which only ever exists/shows when
// DEBUG_MODE is true (see index.html) — nothing here is reachable on a
// normal URL.
const r10DbgCopyBtnEl = document.getElementById('r10-dbg-copy-btn');
const r10DbgCopyStatusEl = document.getElementById('r10-dbg-copy-status');

const r10DebugState = DEBUG_MODE ? {
  fireCallCount: 0,     // every real fireWeapon() invocation, success or reject
  fireSuccessCount: 0,  // shots that actually passed both guards and were created
  fireRejectCount: 0,
  fireRejectReason: '-',
  lastFireAt: 0,
  nextFireAllowedAt: 0,
  shotCreatedCount: 0,
  lastShotDir: null,
  lastTarget: null,
  lastHitTestResult: '-',
  hitCount: 0,
  missCount: 0,
  lastDamage: 0,
  lastDamageAt: 0,
  inputMode: 'controller', // set from handleModeSelect()
  log: [], // capped ring buffer of {t, text}
  // 14TH ROUND (items 43-44): edge-triggered FIRE INPUT/FIRE BLOCKED logging
  // state — see fireWeapon()'s own comment. null = nothing currently logged
  // for this held-FIRE press (reset on release); otherwise the last reason
  // actually written to the log ('INPUT', 'COVER', 'RELOADING', 'NO AMMO',
  // 'COOLDOWN', or 'FIRED').
  lastFireLogReason: null,
} : null;

// Event-driven only (FIRE input, shot created/rejected, hit, miss, damage
// applied) — never called per-rAF-frame, so this can never become
// per-frame console spam. Silent no-op on a normal URL.
function r10DebugLog(text) {
  if (!DEBUG_MODE) return;
  const t = performance.now();
  r10DebugState.log.push({ t, text });
  if (r10DebugState.log.length > 60) r10DebugState.log.shift();
  // 12TH ROUND (item 6): collection (the ring-buffer push above) is now
  // always-on regardless of URL, but console.log itself stays gated on the
  // VISUAL PANEL's own on/off state — a normal player who never opens
  // PAUSE -> DEBUG DISPLAY should never see this game's internals flooding
  // their browser console.
  if (state.debugPanelVisible) console.log('[DEBUG ' + t.toFixed(0) + ']', text);
}

// ADDENDUM (COPY DEBUG): single source of truth for every field the panel
// shows AND every field COPY DEBUG copies, so the two can never drift out
// of sync with each other. Pure read — computes and returns a plain object
// from the CURRENT live state at the moment it's called; never reads back
// from the DOM. Called both from the throttled r10UpdateDebugPanel() below
// and, independently and un-throttled, at the exact instant COPY DEBUG is
// pressed (see r10CopyDebugSnapshot()) — that second call is what makes
// the copy a true snapshot of the moment of the tap, not whatever the
// panel happened to last redraw up to 150ms earlier.
function r10CollectSnapshot(ts) {
  const p = state.player, e = state.enemy, es = state.escape, d = r10DebugState;
  const activeBullets = state.bullets.filter((b) => b.active).length;
  const activeParticles = state.particles.filter((pt) => pt.active).length;
  const dashActive = ts < p.dashUntil || ts < p.fwdDashUntil || ts < es.strafeDashUntil || ts < es.fwdDashUntil;
  return {
    ts,
    game: { mode: state.gameMode, theme: state.theme, started: state.gameStarted, paused: state.paused },
    // 9TH ROUND (item 36): ESCAPE MODE's own TIME LIMIT state.
    escapeTimer: { timeLeftSec: Math.max(0, Math.ceil(state.escape.timeLeftSec)), limitSec: ESCAPE_TIME_LIMIT_SEC },
    clearSeq: { active: state.clearSequence.active, phase: state.clearSequence.phase, reason: state.clearSequence.reason || '-' },
    player: { x: Math.round(p.strafeOffset), facing: p.facing, hp: p.hp, maxHp: PLAYER_MAX_HP,
      cover: isPlayerInCover(), coverFacing: p.coverFacing, dash: dashActive,
      // 10TH ROUND (item 56): move direction/walk frame/dash direction + which
      // BARREL CLUSTER (if any) is providing COVER right now.
      moveDirSouth: !!p.moveDirSouth, walkFrame: p.walkFrame,
      dashDir: dashActive && ts < p.fwdDashUntil ? (p.fwdDashSign > 0 ? 'north' : 'south') : '-',
      coverCluster: r10DebugCoverClusterId().clusterId,
      // 11TH ROUND (items 7, 47): DASH blink/invulnerability window — now
      // shared verbatim between LAB's own DASH and ESCAPE's instant DASH
      // (both write p.invincibleUntil), so a single field covers either.
      blinking: ts < p.invincibleUntil,
      invincibleRemainMs: Math.max(0, Math.round(p.invincibleUntil - ts)) },
    // 11TH ROUND (items 45-46): ESCAPE run-loop frame index (always-on
    // 5-frame loop, never direction-selected — see updateEscapePlayer()/
    // renderEscapePlayer()).
    escapeRun: { frame: es.runFrame, total: ASSETS_PLAYER_ESCAPE_RUN.length },
    // 9TH ROUND (item 5): AMMO/RELOAD diagnostics.
    ammo: { current: p.ammo, magazine: MAG_SIZE, reserve: p.reserve,
      reloading: p.reloading, reloadType: p.reloadType || '-',
      reloadRemainingMs: p.reloading ? Math.max(0, Math.round(p.reloadUntil - ts)) : 0 },
    fire: { held: state.input.fireHeld, calls: d.fireCallCount, ok: d.fireSuccessCount,
      rej: d.fireRejectCount, rejReason: d.fireRejectReason, lastAt: Math.round(d.lastFireAt),
      cdLeft: Math.max(0, Math.round(p.fireCooldownUntil - ts)), nextOk: Math.round(d.nextFireAllowedAt) },
    shot: { active: activeBullets, fx: activeParticles, created: d.shotCreatedCount,
      lastDir: d.lastShotDir ? d.lastShotDir.x.toFixed(0) + ',' + d.lastShotDir.y.toFixed(0) : '-',
      lastTgt: d.lastTarget ? d.lastTarget.x.toFixed(0) + ',' + d.lastTarget.y.toFixed(0) : '-',
      lastTest: d.lastHitTestResult },
    enemy: { type: e.type, hp: e.hp, maxHp: e.maxHp, lastDmg: d.lastDamage,
      lastDmgAt: Math.round(d.lastDamageAt), hits: d.hitCount, miss: d.missCount,
      invulnerable: !!e.invulnerable, counterPhaseRemainMs: e.invulnerable ? Math.max(0, Math.round(e.counterPhaseUntil - ts)) : 0,
      triggeredThresholds: (e.triggeredThresholds || []).map((t) => Math.round(t * 100)).join(','),
      // 10TH ROUND (item 56): real world z + normal/stalking state — only
      // meaningful for GABRIEL/ADAM's two-tier approach (see STALK_Z/
      // NORMAL_Z_MIN); '-' for every other type rather than a misleading 0.
      z: Math.round(e.z),
      approachState: (e.type === 'gabriel' || e.type === 'adam')
        ? (e.z > (e.type === 'gabriel' ? GABRIEL_NORMAL_Z_MIN : ADAM_NORMAL_Z_MIN) ? 'stalking' : 'normal')
        : '-',
      // 11TH ROUND (item 48): per-type attack-frequency multiplier actually
      // applied to this enemy's idle-recheck wait window (see
      // ENEMY_ATTACK_FREQ_MULT/enemyAttackFreqMult()) — lower = more
      // frequent attacks; 1 = unchanged from pre-Round-11 baseline.
      freqMult: enemyAttackFreqMult(e.type) },
    input: { mode: d.inputMode, fireBtn: state.input.fireHeld,
      stickR: state.input.aimX.toFixed(2) + ',' + state.input.aimY.toFixed(2),
      aim: p.aimLiveX.toFixed(0) + ',' + p.aimLiveY.toFixed(0) },
    // 12TH ROUND (item 76): new field groups for the always-on background
    // DEBUG collection — PLAYER/AIM/FOCUS/ENEMY/ATTACK/PROJECTILE. Built
    // from the SAME functions the real gameplay logic already calls
    // (getAimPoint(), getFlashlightCenter(), isAimOnEffectiveHit(),
    // getEffectiveHitPoint(), getMissileProjectileVisual()) rather than
    // re-deriving anything separately, so this can never drift from what
    // actually happens on screen. Event-based collection cadence is
    // unchanged (this whole snapshot fires on r10DebugLog()'s existing
    // schedule, never a new per-rAF-frame hook).
    r12: (() => {
      const aim = getAimPoint();
      const light = getFlashlightCenter();
      // 15TH ROUND (items 18-23): DEBUG panel's own "effectiveHit"/"aimColor"
      // fields now read the SAME unified isEffectiveDamageNow() the real
      // crosshair uses (not the older geometry-only isAimOnEffectiveHit()),
      // so COPY DEBUG output always matches what's actually on screen.
      const hot = isEffectiveDamageNow();
      const rect = computeEnemyDrawRect();
      const hitPt = getEffectiveHitPoint(rect);
      const isRoidType = e.type === 'roid1' || e.type === 'roid2';
      const projLive = e.kind === 'missile' && e.attackState === 'target' && !e.missileDestroyed && e.missileHeight > 0.5;
      const pv = projLive ? getMissileProjectileVisual(e) : null;
      return {
        player: { x: Math.round(p.strafeOffset), worldDepth: Number((p.depthPos || 0).toFixed(2)),
          screenY: state.gameMode === 'escape' ? Math.round(state.cssH * 1.02 - (es.depthPos || 0) * ESCAPE_DEPTH_SCREEN_RANGE_PX) : Math.round(state.cssH * 1.02),
          perspectiveScale: Number((state.gameMode === 'escape' ? perspectiveScaleFromDepth(es.depthPos || 0, ESCAPE_DEPTH_SCALE_RANGE) : (p.scale || 1)).toFixed(3)),
          hp: p.hp, dashDirection: dashActive && ts < p.fwdDashUntil ? (p.fwdDashSign > 0 ? 'north' : 'south') : '-' },
        aim: { x: Math.round(aim.x), y: Math.round(aim.y),
          lightCenterX: Math.round(light.x), lightCenterY: Math.round(light.y),
          lightRadius: FLASHLIGHT_BASE_RADIUS, effectiveHit: hot, aimColor: hot ? 'yellow' : 'white' },
        focus: { targetType: isRoidType && rect.headX != null ? 'head' : 'body',
          targetX: Math.round(hitPt.x), targetY: Math.round(hitPt.y),
          effectiveDamagePoint: hitPt.x.toFixed(0) + ',' + hitPt.y.toFixed(0) },
        enemy12: { type: e.type, x: Math.round(e.lane), z: Math.round(e.z),
          tracking: Math.round(e.laneTarget || 0), facing: e.facing || e.zone || '-',
          attackState: e.attackState, flyByState: '-', burstState: '-' },
        attack: { targetWorldX: Math.round(e.missileTargetWorldX || 0), targetWorldZ: Math.round(e.missileTargetWorldZ || 0),
          projectedX: Math.round(e.missileTargetX || 0), projectedY: Math.round(e.missileTargetY || 0), impactRadius: 62 },
        projectile: { active: projLive, worldX: Math.round(e.missileTargetWorldX || 0),
          worldZ: Math.round(e.missileTargetWorldZ || 0), height: Math.round(e.missileHeight || 0),
          impactWorldX: Math.round(e.missileTargetWorldX || 0), impactWorldZ: Math.round(e.missileTargetWorldZ || 0),
          projectedX: pv ? Math.round(pv.x) : 0, projectedY: pv ? Math.round(pv.y) : 0,
          shadowX: pv ? Math.round(pv.shadowX) : 0, shadowY: pv ? Math.round(pv.shadowY) : 0,
          interceptable: projLive, destroyed: !!e.missileDestroyed, impactState: e.attackState },
      };
    })(),
    // 9TH ROUND (item 39-43): CONTROLLER-only startup diagnostics.
    gamepad: {
      connected: state.gamepadConnected, index: state.gamepadIndex,
      id: (() => { const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        const g = state.gamepadIndex !== null ? pads[state.gamepadIndex] : null;
        return g && g.id ? g.id.slice(0, 30) : '-'; })(),
      pollingActive: state.assetsReady, uiInputEnabled: !state.gameStarted && state.assetsReady,
      gameplayInputEnabled: state.gameStarted,
      settleActive: ts < state.gamepadSettleUntil,
      lastButton: state.lastGamepadButtonIndex, lastInputAt: Math.round(state.lastGamepadInputAt),
      touchGestureAt: Math.round(state.touchGestureReceivedAt), audioUnlockedAt: Math.round(state.audioUnlockedAt),
    },
    // ADDENDUM item 9: the FULL ring buffer (up to 60 entries), oldest
    // first — COPY DEBUG must never truncate this, unlike the on-screen
    // panel's own last-16 display slice below.
    log: d.log.slice(),
  };
}

let r10DbgLastRenderAt = 0;
function r10UpdateDebugPanel(ts) {
  if (ts - r10DbgLastRenderAt < 150) return; // throttled DOM writes, debug-only
  r10DbgLastRenderAt = ts;
  const s = r10CollectSnapshot(ts);

  r10DbgGameEl.textContent = 'GAME mode=' + s.game.mode + ' theme=' + s.game.theme +
    ' started=' + s.game.started + ' paused=' + s.game.paused +
    (s.game.mode === 'escape' ? ' escT=' + s.escapeTimer.timeLeftSec + '/' + s.escapeTimer.limitSec : '') +
    (s.clearSeq.active ? ' CLEAR=' + s.clearSeq.phase : '');

  r10DbgPlayerEl.textContent = 'PLAYER x=' + s.player.x + ' facing=' + s.player.facing +
    ' hp=' + s.player.hp + '/' + s.player.maxHp +
    ' cover=' + s.player.cover + '(' + s.player.coverFacing + ')' +
    ' dash=' + s.player.dash +
    '\n moveDirSouth=' + s.player.moveDirSouth + ' walkFrame=' + s.player.walkFrame +
    ' dashDir=' + s.player.dashDir + ' coverCluster=' + s.player.coverCluster +
    '\n blinking=' + s.player.blinking + ' invincibleRemain=' + s.player.invincibleRemainMs +
    (s.game.mode === 'escape' ? ' escRunFrame=' + s.escapeRun.frame + '/' + s.escapeRun.total : '');

  r10DbgAmmoEl.textContent = 'AMMO ' + s.ammo.current + '/' + s.ammo.magazine + ' reserve=' + s.ammo.reserve +
    '\n reloading=' + s.ammo.reloading + '(' + s.ammo.reloadType + ')' +
    ' remain=' + s.ammo.reloadRemainingMs + 'ms';

  r10DbgFireEl.textContent = 'FIRE held=' + s.fire.held +
    ' calls=' + s.fire.calls + ' ok=' + s.fire.ok +
    ' rej=' + s.fire.rej + '(' + s.fire.rejReason + ')' +
    '\n lastAt=' + s.fire.lastAt + ' cdLeft=' + s.fire.cdLeft + ' nextOk=' + s.fire.nextOk;

  r10DbgShotEl.textContent = 'SHOT active=' + s.shot.active + ' fx=' + s.shot.fx +
    ' created=' + s.shot.created +
    '\n lastDir=' + s.shot.lastDir + ' lastTgt=' + s.shot.lastTgt +
    '\n lastTest=' + s.shot.lastTest;

  r10DbgEnemyEl.textContent = 'ENEMY ' + s.enemy.type + ' hp=' + s.enemy.hp + '/' + s.enemy.maxHp +
    '\n lastDmg=' + s.enemy.lastDmg + '@' + s.enemy.lastDmgAt +
    ' hits=' + s.enemy.hits + ' miss=' + s.enemy.miss +
    '\n invuln=' + s.enemy.invulnerable + ' counterRemain=' + s.enemy.counterPhaseRemainMs +
    ' thresholds=' + (s.enemy.triggeredThresholds || '-') +
    '\n z=' + s.enemy.z + ' approach=' + s.enemy.approachState + ' freqMult=' + s.enemy.freqMult;

  r10DbgInputEl.textContent = 'INPUT mode=' + s.input.mode + ' fireBtn=' + s.input.fireBtn +
    '\n stickR=' + s.input.stickR + ' aimLive=' + s.input.aim +
    '\nGAMEPAD conn=' + s.gamepad.connected + ' idx=' + s.gamepad.index + ' id=' + s.gamepad.id +
    '\n poll=' + s.gamepad.pollingActive + ' uiIn=' + s.gamepad.uiInputEnabled + ' playIn=' + s.gamepad.gameplayInputEnabled +
    ' settle=' + s.gamepad.settleActive +
    '\n lastBtn=' + s.gamepad.lastButton + '@' + s.gamepad.lastInputAt +
    ' touch@' + s.gamepad.touchGestureAt + ' audio@' + s.gamepad.audioUnlockedAt;

  const lines = s.log.slice(-16).reverse().map((en) => en.t.toFixed(0) + ' ' + en.text);
  r10DbgLogEl.textContent = lines.join('\n');
}

// ADDENDUM: renders a r10CollectSnapshot() result as plain, ChatGPT-
// pasteable text — every section the panel shows, plus the FULL event log
// (not the panel's last-16 slice).
function r10FormatDebugText(s) {
  const lines = [];
  lines.push('=== DARKOUT 2 DEBUG ===');
  lines.push('');
  lines.push('GAME');
  lines.push('mode: ' + s.game.mode);
  lines.push('theme: ' + s.game.theme);
  lines.push('started: ' + s.game.started);
  lines.push('paused: ' + s.game.paused);
  if (s.game.mode === 'escape') lines.push('escapeTimeLeftSec: ' + s.escapeTimer.timeLeftSec + '/' + s.escapeTimer.limitSec);
  lines.push('clearSequence: active=' + s.clearSeq.active + ' phase=' + s.clearSeq.phase + ' reason=' + s.clearSeq.reason);
  lines.push('');
  lines.push('PLAYER');
  lines.push('position: x=' + s.player.x);
  lines.push('facing: ' + s.player.facing);
  lines.push('hp: ' + s.player.hp + '/' + s.player.maxHp);
  lines.push('cover: ' + s.player.cover + ' (' + s.player.coverFacing + ')');
  lines.push('dash: ' + s.player.dash);
  lines.push('moveDirSouth: ' + s.player.moveDirSouth);
  lines.push('walkFrame: ' + s.player.walkFrame);
  lines.push('dashDir: ' + s.player.dashDir);
  lines.push('coverCluster: ' + s.player.coverCluster);
  lines.push('blinking: ' + s.player.blinking);
  lines.push('invincibleRemainMs: ' + s.player.invincibleRemainMs);
  if (s.game.mode === 'escape') lines.push('escapeRunFrame: ' + s.escapeRun.frame + '/' + s.escapeRun.total);
  lines.push('');
  lines.push('AMMO');
  lines.push('current: ' + s.ammo.current);
  lines.push('magazine: ' + s.ammo.magazine);
  lines.push('reserve: ' + s.ammo.reserve);
  lines.push('reloading: ' + s.ammo.reloading);
  lines.push('reloadType: ' + s.ammo.reloadType);
  lines.push('reloadRemainingMs: ' + s.ammo.reloadRemainingMs);
  lines.push('');
  lines.push('FIRE');
  lines.push('input: ' + s.fire.held);
  lines.push('calls: ' + s.fire.calls);
  lines.push('success: ' + s.fire.ok);
  lines.push('reject: ' + s.fire.rej);
  lines.push('rejectReason: ' + s.fire.rejReason);
  lines.push('lastFireTime: ' + s.fire.lastAt);
  lines.push('cooldown: ' + s.fire.cdLeft);
  lines.push('nextFireTime: ' + s.fire.nextOk);
  lines.push('');
  lines.push('SHOT');
  lines.push('active: ' + s.shot.active);
  lines.push('effects: ' + s.shot.fx);
  lines.push('created: ' + s.shot.created);
  lines.push('lastDirection: ' + s.shot.lastDir);
  lines.push('lastTarget: ' + s.shot.lastTgt);
  lines.push('lastHitResult: ' + s.shot.lastTest);
  lines.push('');
  lines.push('ENEMY');
  lines.push('type: ' + s.enemy.type);
  lines.push('hp: ' + s.enemy.hp + '/' + s.enemy.maxHp);
  lines.push('lastDamage: ' + s.enemy.lastDmg);
  lines.push('lastDamageTime: ' + s.enemy.lastDmgAt);
  lines.push('hitCount: ' + s.enemy.hits);
  lines.push('missCount: ' + s.enemy.miss);
  lines.push('invulnerable: ' + s.enemy.invulnerable);
  lines.push('counterPhaseRemainingMs: ' + s.enemy.counterPhaseRemainMs);
  lines.push('triggeredThresholds: ' + (s.enemy.triggeredThresholds || '-'));
  lines.push('z: ' + s.enemy.z);
  lines.push('approachState: ' + s.enemy.approachState);
  lines.push('attackFreqMult: ' + s.enemy.freqMult);
  lines.push('');
  lines.push('INPUT');
  lines.push('mode: ' + s.input.mode);
  lines.push('fireButton: ' + s.input.fireBtn);
  lines.push('rightStick: ' + s.input.stickR);
  lines.push('aim: ' + s.input.aim);
  lines.push('');
  lines.push('GAMEPAD');
  lines.push('connected: ' + s.gamepad.connected);
  lines.push('index: ' + s.gamepad.index);
  lines.push('id: ' + s.gamepad.id);
  lines.push('pollingActive: ' + s.gamepad.pollingActive);
  lines.push('uiInputEnabled: ' + s.gamepad.uiInputEnabled);
  lines.push('gameplayInputEnabled: ' + s.gamepad.gameplayInputEnabled);
  lines.push('settleActive: ' + s.gamepad.settleActive);
  lines.push('lastButton: ' + s.gamepad.lastButton);
  lines.push('lastInputAt: ' + s.gamepad.lastInputAt);
  lines.push('touchGestureAt: ' + s.gamepad.touchGestureAt);
  lines.push('audioUnlockedAt: ' + s.gamepad.audioUnlockedAt);
  lines.push('');
  lines.push('=== EVENT LOG (' + s.log.length + ' entries) ===');
  if (s.log.length === 0) {
    lines.push('(empty)');
  } else {
    for (const en of s.log) lines.push('[' + en.t.toFixed(0) + '] ' + en.text);
  }
  lines.push('');
  lines.push('=== END DEBUG ===');
  return lines.join('\n');
}

// ADDENDUM: Clipboard write with an iOS/Safari-safe fallback.
// navigator.clipboard.writeText() requires a secure context + (on some
// Safari versions) a same-tick user-activation path that an awaited
// promise chain can lose — so on any rejection/absence we fall back to
// the classic hidden-textarea + select() + document.execCommand('copy')
// path, which has been reliable on Safari/iOS for this exact use case for
// years. Returns a Promise<boolean> (true = copied).
function r10CopyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => r10FallbackCopy(text));
  }
  return Promise.resolve(r10FallbackCopy(text));
}
function r10FallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Keep it on-screen (0-size, transparent) rather than off-screen —
    // some iOS Safari versions refuse to focus/select an element
    // positioned far outside the viewport.
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.opacity = '0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS Safari needs this explicit range
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    return false;
  }
}

let r10CopyStatusClearTimer = null;
function r10CopyDebugSnapshot() {
  if (!DEBUG_MODE) return; // defense-in-depth; the button itself only exists in the DEBUG_MODE DOM tree
  const snapshot = r10CollectSnapshot(performance.now()); // fresh read, taken at the exact instant of the tap
  const text = r10FormatDebugText(snapshot);
  r10DebugLog('COPY DEBUG pressed (' + snapshot.log.length + ' log entries in snapshot)');
  r10CopyTextToClipboard(text).then((ok) => {
    if (r10CopyStatusClearTimer) clearTimeout(r10CopyStatusClearTimer);
    r10DbgCopyStatusEl.textContent = ok ? 'COPIED!' : 'COPY FAILED';
    r10DbgCopyStatusEl.style.color = ok ? '#8fffb0' : '#ff8f8f';
    r10CopyStatusClearTimer = setTimeout(() => { r10DbgCopyStatusEl.textContent = ''; }, 2000);
  });
}
if (DEBUG_MODE && r10DbgCopyBtnEl) {
  // pointerdown (not click) so this reads as a direct user-activation
  // gesture for Clipboard API purposes on touch devices; preventDefault
  // stops it from also being interpreted as a stray game touch (the
  // button sits inside the otherwise pointer-events:none debug panel —
  // see style.css — so this is the ONLY tappable element in that area).
  r10DbgCopyBtnEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    r10CopyDebugSnapshot();
  });
}

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

// 11TH ROUND (items 17-19): extends spriteFrame() with the frame's own
// HEAD WEAK POINT, alpha-channel-measured the same way bodyTopFrac/
// bodyBottomFrac are (never guessed/centered-on-sprite) — for each of
// ROID1/ROID2's 9 real frames, measured via Python/Pillow as the alpha-
// weighted centroid of the top 16% of the body's own alpha bounds (the
// head sits at the top of a bipedal silhouette), with headRadiusFrac from
// that band's own pixel width. headCenterXFrac/headCenterYFrac are
// fractions of the RAW image (same space bodyTopFrac/bodyBottomFrac use),
// converted to screen space in computeEnemyDrawRect() below.
function roidSpriteFrame(src, bodyTopFrac, bodyBottomFrac, headCenterXFrac, headCenterYFrac, headRadiusFrac) {
  return Object.assign(spriteFrame(src, bodyTopFrac, bodyBottomFrac), { headCenterXFrac, headCenterYFrac, headRadiusFrac });
}

// ESCAPE-exclusive: extends spriteFrame() with a per-frame stable-anchor
// point (wheelBottomFrac/wheelCenterXFrac), alpha-channel-measured the same
// row-coverage-threshold way bodyTopFrac/bodyBottomFrac are (thin
// semi-transparent hair-wisp pixels touch every canvas edge on all 9 source
// PNGs, so a naive full-alpha bbox is useless — each frame's own row was
// scored by opaque-pixel coverage, and "core mass" rows/wheel-bottom rows
// were isolated by a coverage-percentage-of-max threshold; wheelCenterXFrac
// is the opaque-pixel-weighted horizontal center-of-mass of the bottom 15%
// of that core band, i.e. the front-wheel/bike-body area). Measured
// directly from the real files in assets/player_escape/ — not guessed.
// renderEscapePlayer() pins this exact point to a fixed screen position on
// every frame, which is what keeps the bike from bouncing/drifting/
// rescaling when the sprite switches (spec: 3).
function escapeSpriteFrame(src, bodyTopFrac, bodyBottomFrac, wheelBottomFrac, wheelCenterXFrac) {
  return Object.assign(spriteFrame(src, bodyTopFrac, bodyBottomFrac), { wheelBottomFrac, wheelCenterXFrac });
}

// COVER ACTION (drum-can hiding pose): extends spriteFrame() with the
// body's own horizontal-center fraction (bodyCenterXFrac), alpha-channel-
// measured the same column-coverage-threshold way bodyTopFrac/
// bodyBottomFrac are (row coverage). Used as the stable anchor point in
// renderPlayer() so switching COVER direction never shifts the player's
// on-screen position — mirrors escapeSpriteFrame()'s own wheelCenterXFrac
// idea for the same reason.
function coverSpriteFrame(src, bodyTopFrac, bodyBottomFrac, bodyCenterXFrac) {
  return Object.assign(spriteFrame(src, bodyTopFrac, bodyBottomFrac), { bodyCenterXFrac });
}

// 9 real, user-supplied ESCAPE player sprites (assets/player_escape/) — a
// SEPARATE asset set from ASSETS.player (LAB/ARMORED combat player); never
// overwrites or aliases it. south[]/west[]/east[] are each a 3-frame loop
// (see updateEscapePlayer()'s facing/animFrame). No north frames exist in
// the supplied set — see the completion report for how that gap is
// handled (not fabricated/flipped/substituted).
const ASSETS_PLAYER_ESCAPE = {
  south: [
    escapeSpriteFrame('assets/player_escape/escape_south_01.png', 0.0226, 0.9878, 0.8743, 0.5022),
    escapeSpriteFrame('assets/player_escape/escape_south_02.png', 0.0235, 0.9869, 0.8786, 0.4917),
    escapeSpriteFrame('assets/player_escape/escape_south_03.png', 0.0247, 0.9863, 0.8805, 0.4958),
  ],
  west: [
    escapeSpriteFrame('assets/player_escape/escape_west_01.png', 0.0209, 0.9876, 0.8758, 0.4904),
    escapeSpriteFrame('assets/player_escape/escape_west_02.png', 0.0259, 0.9865, 0.8745, 0.5079),
    escapeSpriteFrame('assets/player_escape/escape_west_03.png', 0.0192, 0.9870, 0.8746, 0.5053),
  ],
  east: [
    escapeSpriteFrame('assets/player_escape/escape_east_01.png', 0.0269, 0.9866, 0.8747, 0.5664),
    escapeSpriteFrame('assets/player_escape/escape_east_02.png', 0.0236, 0.9870, 0.8739, 0.5864),
    escapeSpriteFrame('assets/player_escape/escape_east_03.png', 0.0248, 0.9865, 0.8738, 0.5882),
  ],
};

// 11TH ROUND (items 1-4, 28): the 5 user-attached motorcycle-front images
// used as ESCAPE's ONLY run-loop art now, in strict attachment order
// (1->2->3->4->5->1...) — saved verbatim (no recompression/edits to the
// person/bike artwork itself) as escape_bike_run_01..05.png, matching the
// order Claude Code confirmed against the actual uploaded file paths, not
// guessed. bodyTopFrac/bodyBottomFrac and wheelCenterXFrac are this
// project's own real alpha-channel measurement (Python/Pillow, same
// row/column-coverage method as every other *SpriteFrame() table in this
// file) of the 5 real files — wheelBottomFrac uses bodyBottomFrac itself
// (the lowest opaque row IS the front tire's bottom edge on these
// particular renders, no separate shadow layer beneath it, unlike the old
// escape_south/west/east set). The OLD ASSETS_PLAYER_ESCAPE above is left
// completely untouched/still loaded (item 28: no asset deletion required),
// simply no longer referenced by renderEscapePlayer() (item 2).
const ASSETS_PLAYER_ESCAPE_RUN = [
  escapeSpriteFrame('assets/player_escape/escape_bike_run_01.png', 0.0089, 0.9975, 0.9975, 0.4825),
  escapeSpriteFrame('assets/player_escape/escape_bike_run_02.png', 0.0077, 0.9968, 0.9968, 0.5086),
  escapeSpriteFrame('assets/player_escape/escape_bike_run_03.png', 0.0077, 0.9968, 0.9968, 0.5127),
  escapeSpriteFrame('assets/player_escape/escape_bike_run_04.png', 0.0076, 0.9968, 0.9968, 0.5130),
  escapeSpriteFrame('assets/player_escape/escape_bike_run_05.png', 0.0089, 0.9962, 0.9962, 0.4932),
];

const ROID1_SPRITES = {
  search: [
    roidSpriteFrame('assets/roid1/roid1_search_01.png', 0.0016, 0.9984, 0.4132, 0.0975, 0.2070),
    roidSpriteFrame('assets/roid1/roid1_search_02.png', 0.0016, 0.9984, 0.4594, 0.1090, 0.2500),
    roidSpriteFrame('assets/roid1/roid1_search_03.png', 0.0011, 0.9977, 0.4962, 0.1117, 0.2466),
    roidSpriteFrame('assets/roid1/roid1_search_04.png', 0.0023, 0.9977, 0.4926, 0.1031, 0.2047),
    roidSpriteFrame('assets/roid1/roid1_search_05.png', 0.0012, 0.9979, 0.4925, 0.0974, 0.1714),
  ],
  fire: [
    roidSpriteFrame('assets/roid1/roid1_fire_01.png', 0.0023, 0.9984, 0.5336, 0.1070, 0.2109),
    roidSpriteFrame('assets/roid1/roid1_fire_02.png', 0.0023, 0.9984, 0.5314, 0.1070, 0.2109),
    roidSpriteFrame('assets/roid1/roid1_fire_03.png', 0.0023, 0.9984, 0.5342, 0.1070, 0.2109),
    roidSpriteFrame('assets/roid1/roid1_fire_04.png', 0.0023, 0.9984, 0.5334, 0.1070, 0.2109),
  ],
};
const ROID2_SPRITES = {
  search: [
    roidSpriteFrame('assets/roid2/roid2_search_01.png', 0.0031, 0.9984, 0.5500, 0.0984, 0.2445),
    roidSpriteFrame('assets/roid2/roid2_search_02.png', 0.0031, 0.9977, 0.4339, 0.0980, 0.2664),
    roidSpriteFrame('assets/roid2/roid2_search_03.png', 0.0023, 0.9977, 0.3774, 0.0991, 0.2953),
    roidSpriteFrame('assets/roid2/roid2_search_04.png', 0.0031, 0.9984, 0.5481, 0.0953, 0.2180),
    roidSpriteFrame('assets/roid2/roid2_search_05.png', 0.0031, 0.9969, 0.4826, 0.0988, 0.2109),
  ],
  fire: [
    roidSpriteFrame('assets/roid2/roid2_fire_01.png', 0.0556, 0.9802, 0.5476, 0.1460, 0.1088),
    roidSpriteFrame('assets/roid2/roid2_fire_02.png', 0.1091, 0.9286, 0.5283, 0.1892, 0.1550),
    roidSpriteFrame('assets/roid2/roid2_fire_03.png', 0.0734, 0.9593, 0.4044, 0.1657, 0.2355),
    roidSpriteFrame('assets/roid2/roid2_fire_04.png', 0.0853, 0.9831, 0.3930, 0.1727, 0.1367),
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
// 10TH ROUND (items 37-39): DRONE investigated directly in
// andre20290810/ACTION-GAME (available locally at /home/user/action-game).
// Real implementation found there under the "SECURITY DRONE"/`securityRobot`
// identifiers (buildSecurityDrone(), ~5500 lines of PATROL/SCAN/SNIPER attack
// logic) with 3 REAL directional images — assets/security/security_robot_
// {south,west,east}.png — copied read-only into assets/drone/, same as every
// other enemy's art in this file. No north-facing DRONE asset exists in
// ACTION-GAME either (the security camera/corridor framing never needs one),
// so none is fabricated here. bodyTopFrac/bodyBottomFrac below are this
// project's OWN alpha-channel row-coverage measurement of the 3 real PNGs
// (same coverage-threshold method the ROID1_SPRITES comment describes —
// verified with Python/Pillow, not guessed): all 3 are near-full-bleed
// (topFrac≈0.003-0.004, bottomFrac≈0.996).
//
// ACTION-GAME's DRONE has no dedicated "firing" pose art either (its SNIPER
// attack — red box -> yellow box -> fast bolt -> impact — is a HUD/telegraph
// effect drawn separately from the body, not a body-pose change); DARKOUT-
// TPS already has that exact telegraph sequence built for ROID1/ROID2's own
// sniper attack (see isRoidActivelyFiring()/resolveSniperImpact()), so DRONE
// reuses it as-is via the shared e.kind='sniper' state machine (see
// spawnEnemy()) rather than inventing a new attack. search[] mirrors
// ROID_FACE_FRAME's {right:1, center:2, left:3} index layout so
// computeEnemyDrawRect()'s existing zone-based selection needs no DRONE-
// specific branch; center->south (facing the player), right->east,
// left->west — the 3 real directional frames, used honestly instead of a
// single reused image. fire[] reuses the same south frame (no animation —
// there is no second real "fire" pose to ping-pong between).
const DRONE_SPRITES = {
  search: [
    spriteFrame('assets/drone/security_robot_south.png', 0.0039, 0.9961),
    spriteFrame('assets/drone/security_robot_east.png', 0.0039, 0.9961),  // 1 = right
    spriteFrame('assets/drone/security_robot_south.png', 0.0039, 0.9961), // 2 = center
    spriteFrame('assets/drone/security_robot_west.png', 0.0031, 0.9961),  // 3 = left
    spriteFrame('assets/drone/security_robot_south.png', 0.0039, 0.9961),
  ],
  fire: [
    spriteFrame('assets/drone/security_robot_south.png', 0.0039, 0.9961),
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
// ported.
// 10TH ROUND (items 37-39): DRONE flips to TRUE — this repo's own prior
// "no asset/AI/code for it exists anywhere" note was true only of THIS
// repo; ACTION-GAME (now available locally, not checked in prior rounds)
// has a real, working "SECURITY DRONE" (`securityRobot`/`buildSecurityDrone`)
// implementation with 3 real directional images (see DRONE_SPRITES). It
// reuses the SAME sniper state machine ROID1/ROID2 already use (e.kind
// defaults to 'sniper' for every non-claw type — see spawnEnemy()) rather
// than a new one, matching ACTION-GAME's own DRONE having no unique attack
// beyond the ranged sniper telegraph DARKOUT-TPS already ported.
const ENEMY_IMPLEMENTED = {
  drone: true, roid1: true, roid2: true, gabriel: true, adamSphere: true, adam: true,
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
// 7TH ROUND PART 22: which enemy types get the attack-time flicker (see
// renderEnemy()'s inAttackFlashWindow) — explicitly ADAM/GABRIEL/ADAM
// SPHERE only, per spec. ROID1/ROID2 are deliberately excluded (out of
// this round's scope) and keep their existing, completely unrelated
// FIRE-pose visual with no added flicker.
const ATTACK_FLASH_TYPES = new Set(['adam', 'gabriel', 'adamSphere']);

const ASSETS = {
  player: {
    fire: loadImg('assets/player/player_north_fire.png'),
    aim: loadImg('assets/player/player_north_aim.png'),
    walk: [
      loadImg('assets/player/player_north_walk_1.png'),
      loadImg('assets/player/player_north_walk_2.png'),
      loadImg('assets/player/player_north_walk_3.png'),
    ],
    // 9TH ROUND (items 7-8): real-device testing found normal SOUTH
    // movement (D-PAD DOWN / LEFT STICK DOWN) kept showing the north-facing
    // walk frames. Investigation found this was actually a DELIBERATE
    // decision from a much earlier round (see dashN's own comment: "the
    // protagonist never turns to face south in this game") — but per this
    // round's explicit instruction, normal SOUTH movement now gets a real
    // south-facing sprite. Scoped to NORMAL walk only — BACKSTEP (the
    // special south-facing-camera-away lunge action) is untouched and
    // still uses dashN/dashS below (the old single player_dash_south.png).
    // 15TH ROUND (items 4-9, 40-41): the 11TH ROUND's single-image
    // Canvas-transform pseudo-walk (SOUTH_WALK_FRAME_OFFSETS, now removed)
    // is replaced by 3 genuine user-supplied south-walk photos, used
    // EXACTLY as provided (no
    // regeneration/recropping of the source files) — 01→02→03→01... in
    // lockstep with the SAME p.walkFrame index NORTH's own walk[] cycle
    // already uses. bodyTopFrac/bodyBottomFrac/bodyCenterXFrac below are
    // real alpha-channel measurements (Python/Pillow: bodyTop/Bottom = the
    // first/last row with any alpha>10 pixel; bodyCenterXFrac = the alpha-
    // weighted column centroid) of each of the 3 actual source PNGs — never
    // guessed — reusing coverSpriteFrame() (the SAME helper COVER's own 3
    // south/north/east poses already use for this exact "differently-
    // padded source photos must read as one consistent on-screen body
    // size/foot position" problem, see computeBodyVisualScale()).
    southWalkFrames: [
      coverSpriteFrame('assets/player/player_walk_south_01.png', 0.0113, 0.9452, 0.5067),
      coverSpriteFrame('assets/player/player_walk_south_02.png', 0.0207, 0.9900, 0.5062),
      coverSpriteFrame('assets/player/player_walk_south_03.png', 0.0000, 0.9735, 0.4999),
    ],
    // 10TH ROUND (items 1-2): re-investigated assets/player/ — there is
    // still only ONE south-facing player image on disk
    // (player_dash_south.png). Per this round's explicit instruction, a
    // south DASH must now show the player FACING south, not the old
    // north-facing "BACKSTEP" lunge — so it reuses the SAME south asset
    // southWalk already uses (this is the only real south art that
    // exists; nothing was fabricated). dashN is kept for NORTH dash only.
    dashS: loadImg('assets/player/player_dash_south.png'),
    dashN: loadImg('assets/player/player_dash_north.png'),
    // EAST/WEST DASH: real direction-specific ACTION-GAME art
    // (right_dash.png / left_dash.png), copied read-only — PART 1.
    dashE: loadImg('assets/player/player_dash_east.png'),
    dashW: loadImg('assets/player/player_dash_west.png'),
    // COVER ACTION (drum-can hiding pose): 3 user-supplied crouched poses,
    // kept as their own player.cover.* sub-object — never overwrites or
    // aliases the standing fire/aim/walk/dash art above, and separate from
    // ASSETS.playerEscape too (COVER only exists in LAB/ARMORED combat;
    // ESCAPE never reads this). No 'west' key: the user explicitly asked
    // for no separate west file — WEST reuses 'east', mirrored at render
    // time only (see renderPlayer()/getFlippedCoverEastImage()), never a
    // duplicated/pre-flipped image file.
    cover: {
      south: coverSpriteFrame('assets/player/player_cover_south.png', 0.0851, 0.8594, 0.4944),
      north: coverSpriteFrame('assets/player/player_cover_north.png', 0.1441, 0.8414, 0.5191),
      east: coverSpriteFrame('assets/player/player_cover_east.png', 0.0103, 0.9934, 0.3661),
    },
  },
  roid1: ROID1_SPRITES,
  roid2: ROID2_SPRITES,
  drone: DRONE_SPRITES, // 10TH ROUND items 37-39 — see DRONE_SPRITES comment
  gabriel: {
    idle: loadImg('assets/gabriel/gabriel_idle.png'),
    windup: loadImg('assets/gabriel/gabriel_claw_windup.png'),
    release: loadImg('assets/gabriel/gabriel_claw_release.png'),
    // 9TH ROUND (item 30): a real 3-frame walk cycle already existed on disk
    // but was never wired into ASSETS — used for the new continuous
    // south-facing WALK LOOP during NORMAL/STALKING (see renderEnemy()).
    walk: [
      loadImg('assets/gabriel/gabriel_walk_1.png'),
      loadImg('assets/gabriel/gabriel_walk_2.png'),
      loadImg('assets/gabriel/gabriel_walk_3.png'),
    ],
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
    // 7TH ROUND PART 21: the two user-supplied attack images, copied
    // read-only into assets/adam/ (adam_attack_variant1/2.png). Used ONLY
    // during ADAM's own telegraph/impact attack frames (see
    // computeEnemyDrawRect()) in place of windup/release — GABRIEL is
    // completely untouched and still uses its own gabriel_claw_windup/
    // release art.
    attackVariants: [
      loadImg('assets/adam/adam_attack_variant1.png'),
      loadImg('assets/adam/adam_attack_variant2.png'),
    ],
  },
  adamSphere: ADAM_SPHERE_SPRITES,
  barrel: loadImg('assets/objects/barrel.png'),
  // ESCAPE-exclusive player art — SEPARATE from ASSETS.player above (see
  // ASSETS_PLAYER_ESCAPE's own comment). Registering it here means it's
  // automatically picked up by collectImages()/REQUIRED_IMAGES below, so
  // the existing LOADING gate blocks on these 9 real files the same way it
  // already does for every other character's art — real load-failure
  // reporting for free, no separate gate needed.
  playerEscape: ASSETS_PLAYER_ESCAPE,
  // 11TH ROUND (items 1-4): registered the same way, so the 5 new real
  // files are covered by the existing LOADING gate/REQUIRED_IMAGES scan
  // too — no separate preload path invented for them.
  playerEscapeRun: ASSETS_PLAYER_ESCAPE_RUN,
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
// 7TH ROUND PART 2 ("歩行アニメーションが速すぎる"): the old 140ms cadence
// directly copied the real player's own IN-GAME walk-frame speed
// (updatePlayer()'s p.walkTimer > 0.14) — appropriate for actual combat
// movement, but far too brisk for "暗闇の中を慎重に、警戒しながらゆっくり
// 歩いている" on the LOADING screen. LOADING_WALK_FRAME_MS is now its own,
// independent, much slower base cadence (3x), and each step's actual delay
// is jittered by up to ±LOADING_WALK_JITTER_MS so the tempo reads as
// deliberate/cautious rather than a perfectly metronomic slow-motion loop
// — a real setTimeout recursion (not setInterval) so each step can vary.
const LOADING_WALK_FRAME_MS = 462; // 8TH ROUND: was 420 (x1.1, ~10% slower) — real-device feedback said the walk-in-darkness cadence was still too brisk
const LOADING_WALK_JITTER_MS = 70;
let loadingWalkTimerHandle = null;
let loadingWalkFrameIndex = 0;
function startLoadingWalkAnimation() {
  if (loadingWalkTimerHandle !== null) return;
  const step = () => {
    loadingWalkFrameIndex = (loadingWalkFrameIndex + 1) % ASSETS.player.walk.length;
    loadingWalkSpriteEl.src = ASSETS.player.walk[loadingWalkFrameIndex].src;
    const delay = LOADING_WALK_FRAME_MS + (Math.random() * 2 - 1) * LOADING_WALK_JITTER_MS;
    loadingWalkTimerHandle = setTimeout(step, delay);
  };
  loadingWalkTimerHandle = setTimeout(step, LOADING_WALK_FRAME_MS);
}
function stopLoadingWalkAnimation() {
  if (loadingWalkTimerHandle !== null) { clearTimeout(loadingWalkTimerHandle); loadingWalkTimerHandle = null; }
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
// 8TH ROUND: real-device feedback said "CALCULATING..." could sit on screen
// indefinitely whenever the ETA never becomes computable (e.g. load finishes
// too fast/uniformly for ETA_MIN_SAMPLES/ETA_MIN_SPAN_MS to be satisfied).
// loadingFirstCheckAt marks the first checkAssetsReady() call so the display
// logic (see below) can give up and hide the text after a short grace
// window instead of showing a stalled, meaningless "CALCULATING..." for the
// rest of the load.
let loadingFirstCheckAt = null;
const ETA_CALCULATING_GRACE_MS = 900;

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
  if (loadingFirstCheckAt === null) loadingFirstCheckAt = now;
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
    // 8TH ROUND: only show "CALCULATING..." for a brief grace window right
    // at the start of loading. If it's still not computable after that
    // (load too fast/uniform for real samples to accumulate), hide the
    // text entirely instead of leaving a stalled, meaningless message up —
    // never show a fabricated number either.
    loadingEtaEl.textContent = (now - loadingFirstCheckAt < ETA_CALCULATING_GRACE_MS) ? 'CALCULATING...' : '';
  } else {
    const secDisplay = Math.max(1, Math.ceil(etaSec));
    loadingEtaEl.textContent = secDisplay + ' SEC REMAINING';
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
  // ESCAPE-exclusive GAMEPLAY mode, entirely separate from state.theme
  // above: theme is ONLY the visual corridor palette/decor (LAB/ARMORED/
  // ESCAPE — see THEMES/STRUCTURE_KINDS), it never selected any gameplay
  // behavior before this. gameMode is what actually switches PLAYER
  // rendering/update/input between LAB combat and ESCAPE (see frame()).
  // Defaults to 'combat' so LAB/ARMORED are 100% unaffected by anything in
  // this round; only wired true by the ESCAPE theme button (see the
  // .theme-btn click handler) so the existing UI needs no new control.
  gameMode: 'combat', // 'combat' | 'escape'
  timeSec: 0,

  player: {
    hp: PLAYER_MAX_HP,
    strafeOffset: 0,      // px from screen center, +east/-west
    scale: 1,              // depth pulse scale (north/south sync)
    scaleTarget: 1,         // 12TH ROUND: no longer written (see perspectiveScaleFromDepth()/depthPos below) — left in place, harmless, in case anything still reads it
    depthPos: 0,            // 12TH ROUND (items 13-14): persistent PLAYER PERSPECTIVE lean, [-1,+1]
    facing: 'idle',        // 'idle' | 'walk' | 'fire' | 'aim'
    moveDirSouth: false,   // 9TH ROUND: true while the current WALK is a real south move (D-PAD/stick DOWN)
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
    reloadType: null, // 9TH ROUND: 'auto' | 'manual' | null — which RELOAD trigger is currently active, for HUD/DEBUG
    lastAmmoBelowHpCount: -1, lastAmmoBelowHpReloading: false, // dirty-check state for the new below-HP AMMO HUD
    fireCooldownUntil: 0,
    lastShotAt: -Infinity, // 7TH ROUND PART 15 — timestamp of the last REAL shot, drives the enlarged fire pose window (see FIRE_POSE_HOLD_MS)
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
    // 13TH ROUND (items 9-19): LIGHT's own persistent position — see
    // getFlashlightCenter()/updatePlayer(). Replaces Round 12's
    // lightFocusOffsetX/Y (a separate additive offset on top of a raw,
    // non-persistent stick read, which was the root cause of LIGHT
    // snapping back to center on stick release).
    lightPersistX: 0, lightPersistY: 0,
    // PART 12/13 (3rd round): 0..1 smoothed "how deep in a barrel's touch
    // radius" state, driving the COVER visual (see renderPlayer()) —
    // smoothed the same dt-based way p.scale already is, so leaving cover
    // fades out over a short interval rather than snapping.
    coverVisual: 0,
    // COVER ACTION: which crouched-behind-barrel pose to show
    // ('south'|'north'|'east'|'west'), tracked continuously from the
    // player's own moveX/moveY input (see updatePlayer()'s own facing-
    // tracker) — only ever CONSUMED by renderPlayer() while
    // isPlayerInCover() is true. Defaults to 'north', matching this game's
    // existing baseline orientation (every other PLAYER pose — walk/aim/
    // fire/north-dash — already faces north/away-from-camera).
    coverFacing: 'north',
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
    // 9TH ROUND (item 30-31): GABRIEL/ADAM's own continuous "walking toward
    // camera" loop while in NORMAL/STALKING (attackState==='idle'). GABRIEL
    // reuses a real, previously-unused 3-frame walk cycle already on disk
    // (gabriel_walk_1/2/3.png); ADAM has no such asset (confirmed via a
    // fresh `ls assets/adam/` this round — only idle/attack art exists), so
    // ADAM instead gets a Canvas-only body-bob (see renderEnemy()) rather
    // than a fabricated or unnaturally-alternating frame swap.
    clawWalkFrame: 0,
    clawWalkElapsedMs: 0,
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

  // ESCAPE-exclusive player state — deliberately its OWN object, never
  // reusing state.player's dashUntil/dashDir/fwdDashUntil/fwdDashSign
  // fields (those are LAB's own DASH bookkeeping, with LAB's own
  // cooldown/pose rules) so the two modes' dash systems can never collide
  // or leak into each other. state.player.strafeOffset (screen position)
  // IS still reused — it is a generic on-screen-position field, not
  // LAB-specific behavior, and both modes need "current lateral offset".
  escape: {
    facing: 'south',      // 'south' | 'west' | 'east' — UNUSED for rendering as of 11TH ROUND (see
    animFrame: 0,          // renderEscapePlayer()'s comment) but left populated/harmless — item 28
    animElapsedMs: 0,      // says not to delete the old asset/state, only stop using it for the sprite.
    // 11TH ROUND (items 1-4): the new always-on 5-frame RUN LOOP — cycles
    // continuously while ESCAPE is running, completely independent of
    // facing/moveX (see updateEscapePlayer()).
    runFrame: 0, runElapsedMs: 0,
    // 12TH ROUND (items 15-18): free NORTH/SOUTH movement — see
    // ESCAPE_DEPTH_SPEED's own comment for why this has NO auto-recovery,
    // unlike COMBAT's p.depthPos.
    depthPos: 0,
    // 13TH ROUND (item 1): short multiplicative DASH scale pulse, layered
    // ON TOP of (never replacing) the existing depth-based perspective
    // scale — see renderEscapePlayer()'s targetBodyHeightPx and the decay
    // tick in updateEscapePlayer(). Always decays back to exactly 1 (no
    // residual +2%/-2%).
    dashScalePulse: 1,
    // 11TH ROUND (items 6-8): DASH is now INSTANT (the full distance is
    // applied in the single frame the input arrives — no eased travel), so
    // strafeDashUntil/fwdDashUntil no longer drive any interpolation; kept
    // only as harmless legacy fields nothing reads anymore.
    strafeDashUntil: 0, strafeDashDir: 0, strafeDashStart: 0, // LB/X WEST, RB/B EAST
    fwdDashUntil: 0, fwdDashSign: 0, fwdDashCoveredZ: 0,       // A SOUTH DASH (+1) / Y NORTH BACKSTEP (-1)
    // NEXT ROUND PART M: live lateral-DASH afterimage snapshots (real
    // PLAYER sprite ghosts, never white lines) — see updateEscapePlayer()/
    // renderEscapePlayer(). lateralDashBlinkSuppressUntil stops the old
    // strobe blink from also running during a lateral DASH's afterimage
    // window (the two effects must never stack).
    afterimages: [], lateralDashBlinkSuppressUntil: 0,
    // NEXT ROUND PART N: smoothed lean angle (radians) for normal (non-DASH)
    // EAST/WEST movement — see updateEscapePlayer()/renderEscapePlayer().
    leanAngle: 0,
    // edge-triggered ESCAPE-exclusive actions, consumed each frame by
    // consumeEscapeActions() — separate from state.actions above so an
    // ESCAPE dash can never be misread as a LAB dash or vice versa.
    actions: { westDash: false, eastDash: false, northBackstep: false, southDash: false },
    // 9TH ROUND (item 36): counts down from ESCAPE_TIME_LIMIT_SEC in real
    // elapsed seconds (see frame()'s ESCAPE branch); reset by setGameMode()
    // whenever ESCAPE MODE is (re-)entered so a stale value from a previous
    // run can never leak into a fresh one.
    timeLeftSec: ESCAPE_TIME_LIMIT_SEC,
    lastTimeLeftDisplayedSec: -1,
  },

  gamepadConnected: false,
  gamepadIndex: null,
  prevButtons: [],
  // 5TH ROUND: settle window state — see GAMEPAD_SETTLE_MS above.
  // gamepadSettleUntil is a timestamp; while now < this, pollGamepad()
  // returns neutral input but keeps re-syncing prevButtons so no stale/
  // noisy pre-settle state can leak in as a real input once settle ends.
  gamepadSettleUntil: 0,
  // 15TH ROUND (items 29-34): R3 (right-stick click)-HOLD FOCUS. Timestamp
  // of R3's own most recent rising edge (button 11), or null while R3 is
  // not held — pollGamepad() compares `now - r3HoldStartAt` against
  // FOCUS_R3_HOLD_MS each frame to decide whether FOCUS is actually active
  // yet (see gpFocusHeldLocal below). A single top-level field (not nested
  // under state.input) since it tracks raw HOLD DURATION, not a per-frame
  // input value.
  r3HoldStartAt: null,
  // 9TH ROUND (item 39-43): pure diagnostic fields for the CONTROLLER-only
  // startup investigation — never read by any gameplay/control-flow logic,
  // only written for ?debug=1 visibility. lastGamepadButtonIndex/-At track
  // the most recent raw button edge pollGamepad() saw (any state, including
  // pre-gameStarted); touchGestureReceivedAt/audioUnlockedAt are stamped by
  // their own unrelated code paths (see the new 'pointerdown' listener and
  // tryStartBgm()) so the DEBUG panel can show, side by side, whether a
  // gamepad or a touch gesture happened first on a real device.
  lastGamepadButtonIndex: -1,
  lastGamepadInputAt: 0,
  touchGestureReceivedAt: 0,
  audioUnlockedAt: 0,

  // 4th round: touch UI is OFF by default (spec item 6 — Gamepad play
  // shouldn't have the screen full of sticks/buttons); PAUSE toggles it.
  touchControlsVisible: false,
  paused: false,
  // 12TH ROUND (items 6-9): the DEBUG VISUAL PANEL's own on/off state —
  // decoupled from DEBUG_MODE (collection, now always-on) and from the
  // URL. Seeded from the ORIGINAL ?debug=1 meaning (DEBUG_URL_FLAG) purely
  // as a developer convenience; toggled from PAUSE MENU on ANY URL from
  // here on (see the DEBUG DISPLAY button's handler).
  debugPanelVisible: DEBUG_URL_FLAG,
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

  // 9TH ROUND (item 30-35): the shared "escape the darkness" CLEAR
  // SEQUENCE — gate appears -> opens -> player runs through -> light
  // expands -> WHITE OUT -> complete. Driven by real elapsed time
  // (phaseStartedAt), never raw frame counts, so it plays at the same
  // speed regardless of device refresh rate. Reachable from BOTH COMBAT
  // (boss defeated) and ESCAPE (TIME LIMIT hit 0) — see triggerClearSequence().
  clearSequence: {
    active: false,
    phase: 'idle', // 'idle'|'gateAppear'|'gateOpen'|'playerRun'|'lightExpand'|'whiteOut'|'complete'
    phaseStartedAt: 0,
    reason: null, // 'combat' | 'escape' — which mode triggered it, for the completion handler
  },

  particles: [], // muzzle flash / tracer / hit spark, fixed pool

  // 16TH ROUND (Part A-C): a genuine destructive BLAST — CORE FLASH + MAIN
  // BLAST (layered radial-gradient fire blobs) + SPARKS/DEBRIS/SHOCKWAVE/
  // SMOKE — as its own dedicated array/render path, deliberately separate
  // from the generic `particles` pool above (a blast needs its own baked
  // spark/debris sub-particle set per instance, plus multi-phase gradient
  // draws neither `particles`' simple type switch nor its pool slot model
  // are shaped for). Replaces the old asterisk-style 'spark' (6 static rays
  // from one point) used at every explosion site — see spawnBlast().
  blasts: [],

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

// 16TH ROUND (Part A/B): spawns ONE real traveling ember/spark — random
// angle+speed baked in at spawn (never redrawn as fixed rays from a static
// point), decelerating via updateParticles()'s existing vx/vy*0.92 damping,
// exactly like 'ishard' debris already does. Shared by every remaining
// 'spark' call site (SNIPER impact, GABRIEL/ADAM burn-death embers) so none
// of them can regress back into the old asterisk shape.
function spawnSparkEmber(x, y, now, lifeMs) {
  const ang = Math.random() * Math.PI * 2;
  const speed = 50 + Math.random() * 90;
  spawnParticle({
    type: 'spark', x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
    born: now, until: now + lifeMs,
  });
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
  // 7TH ROUND PART 19 ("LAB/ARMORED/ESCAPEが色違いにしか見えない"): these
  // 6 kinds are added to the SAME shared pool (recycle/space exactly like
  // the 8 above via applyForwardDelta()) but renderStructure() only ever
  // actually draws a given one while state.theme matches its own theme
  // (see each case's own guard) — real per-theme equipment/signage
  // silhouettes layered onto the shared corridor skeleton, not a second
  // color filter over the same 8 generic shapes.
  // 10TH ROUND items 6-9: labTank redesigned from a thin thin/flat ellipse
  // into a real CAP/GLASS-CYLINDER-LIQUID/BASE structure (see the case
  // below) — spacing tightened 340->240 so multiple large tanks are
  // visibly lined up down the corridor at once, per item 8.
  { kind: 'labTank', spacing: 240 },     // LAB only: cylindrical culture tank along the wall
  { kind: 'labConsole', spacing: 260 },  // LAB only: wall-mounted monitor/console glow
  // 10TH ROUND items 10-12: the old 'armorPlate' (a horizontal bar spanning
  // the full corridor width at every spacing — the "bridge cross-bar"
  // clutter from item 11) and 'armorHatch' (a square-with-an-X badge — the
  // unwanted object from item 10) are REMOVED and replaced by a single new
  // 'armorGate' kind: a lattice/grid-pattern GATE frame receding into the
  // distance, per item 12's "暗い回廊 + 格子状GATE" spec. The existing
  // shared 'warningLight' kind above already provides the "small red
  // warning lights at the left/right edges, blinking randomly/periodically"
  // part of item 12 — see THEMES.armored.warn (now red) for the fix there.
  { kind: 'armorGate', spacing: 330 },   // ARMORED only: lattice GATE/FRAME receding into the corridor
  { kind: 'escapeArrow', spacing: 190 }, // ESCAPE only: floor directional chevron toward the exit
  { kind: 'escapeStrip', spacing: 130 }, // ESCAPE only: emergency edge-lighting strip
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
// 7TH ROUND PART 13 ("スクロール速度が遅い"): raised from 70. Purely
// cosmetic and render-time-only by construction (see the comment above —
// it NEVER touches structures[].z/applyForwardDelta()/enemy z/barrel z),
// so this can never affect actual gameplay pacing or collision no matter
// how high it's set; kept comfortably under WALK_FORWARD_SPEED (150) so it
// still doesn't read as literal player walking, while being clearly faster
// than before.
// 12TH ROUND (item 19): background/stage scroll roughly doubled again.
// Still purely cosmetic/render-time-only (see comment above) — never
// touches structures[].z/applyForwardDelta()/enemy z/barrel z, so this is
// the correct lever for "faster background flow" that does NOT touch
// WALK_FORWARD_SPEED (raw player input speed), per the explicit spec
// instruction not to simply double player input speed.
const AMBIENT_FLOOR_CRAWL_SPEED = 230; // was 115

// ---------------------------------------------------------------------
// BARRELS (drum-can COVER ZONE objects — PART 4). Alternating left/right
// of center so the corridor is never fully blocked and only every other
// spacing gets one, so the stage isn't wall-to-wall safe zones (PART 4:
// "ステージ全体を安全地帯だらけにしないでください"). Recycled the exact
// same way structures are (see applyForwardDelta), so they keep appearing
// as the player advances instead of being a one-time, exhaustible set.
//
// 10TH ROUND (items 14-18): a single lone barrel never read as convincing
// physical cover on real devices ("影に入っただけ" — visually weak even
// after 9TH ROUND's shadow-sync work). Redesigned as a BARREL CLUSTER: each
// anchor point below now spawns 2-3 real drum-can entries (own z/lane,
// close together) instead of one. Every existing per-barrel system —
// isPlayerInCover(), clampStrafeForBarrels(), clampForwardDeltaForBarrels(),
// drawOneBarrel()/renderBarrels()/renderBarrelForeground() — is reused
// completely UNCHANGED and just iterates a few more entries: this is
// deliberate, so the visual cluster and the COVER judgment can never drift
// apart (item 17's explicit requirement) — there is no separate "cluster"
// concept for logic to disagree with, only more of the exact same barrel
// objects the whole COVER system already trusted before this round.
const BARREL_CLUSTER_OFFSETS = [
  { dLane: 0, dZ: 0 },
  { dLane: 34, dZ: 6 },
  { dLane: 14, dZ: 52 }, // "少し奥に1本"
];
const barrels = [];
{
  let side = -1;
  for (let z = Z_NEAR + BARREL_SPACING_Z * 0.5; z < Z_FAR; z += BARREL_SPACING_Z) {
    for (const off of BARREL_CLUSTER_OFFSETS) {
      barrels.push({ z: z + off.dZ, lane: side * BARREL_LANE_OFFSET + off.dLane * side });
    }
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

window.addEventListener('gamepadconnected', () => {
  // poll handles actual adoption; this is just a hint/diagnostic.
  if (DEBUG_MODE) r10DebugLog('GAMEPAD CONNECTED (browser event)');
});
// 9TH ROUND (item 39-43): pure diagnostic — stamps the first real touch
// anywhere on the page, completely independent of any gamepad/audio logic
// (never read by pollGamepad()/handleModeSelect()/tryStartBgm() themselves).
// Exists so a real-device DEBUG session can show, side by side, whether
// gpInput ever went non-empty BEFORE this timestamp — the concrete way to
// confirm/deny the suspected root cause: some mobile browsers (notably
// Safari) do not report ANY connected gamepad via navigator.getGamepads()
// until the page has received a user gesture, a platform-level restriction
// this app cannot bypass from script.
window.addEventListener('pointerdown', () => {
  if (state.touchGestureReceivedAt) return;
  state.touchGestureReceivedAt = performance.now();
  if (DEBUG_MODE) r10DebugLog('TOUCH GESTURE (first pointerdown)');
}, { once: true, passive: true });
window.addEventListener('gamepaddisconnected', (e) => {
  if (e.gamepad && e.gamepad.index === state.gamepadIndex) {
    state.gamepadIndex = null;
    state.gamepadConnected = false;
    state.prevButtons = [];
    state.gamepadSettleUntil = 0;
    state.r3HoldStartAt = null; // 15TH ROUND: never let a stale hold-start timestamp survive a disconnect/reconnect
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
// 11TH ROUND (item 5) — see ESCAPE_MOVE_DEADZONE/ESCAPE_MOVE_CURVE_POWER's
// own comment for why this is separate from applyLightCurve().
function applyEscapeMoveCurve(raw) { return applyStickCurve(raw, ESCAPE_MOVE_DEADZONE, ESCAPE_MOVE_CURVE_POWER); }

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
      if (DEBUG_MODE) r10DebugLog('GAMEPAD DETECTED: idx=' + candidateIndex + ' id=' + (candidate.id || '?').slice(0, 24));
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
    // 9TH ROUND (item 39-43): cheap diagnostic-only field writes (no
    // console/log spam) — records the most recent raw button edge for the
    // DEBUG panel, regardless of gameStarted/mode. Never read by any
    // control-flow logic.
    for (let i = 0; i < b.length; i++) {
      if (pressed(i) && !prev[i]) {
        state.lastGamepadButtonIndex = i; state.lastGamepadInputAt = now || 0;
        // 14TH ROUND (items 12-14): root cause — tryStartBgm() was only ever
        // called from ONE place (handleModeSelect(), on the very first mode-
        // select click), despite its own comment describing a "first genuine
        // input" design meant to retry from ANY subsequent pointerdown/
        // keydown/gamepad-button press. That retry wiring never actually
        // existed in code, so if the single mode-select attempt's play()
        // didn't stick (a real-device-only timing/autoplay-policy race this
        // headless test environment could not reproduce — Playwright/
        // Chromium played BGM correctly on the very first attempt every
        // time), BGM stayed permanently silent for the whole session, since
        // nothing ever called tryStartBgm() again. This restores that missing
        // retry path for CONTROLLER players (who may never touch the
        // screen). tryStartBgm() itself is unconditionally safe to call
        // repeatedly (the existing bgmStarted guard makes every call after
        // the real first successful start a no-op) — never reverts the
        // non-blocking BGM loading, never risks a second overlapping
        // instance.
        if (!bgmStarted) tryStartBgm();
        break;
      }
    }

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
        if (DEBUG_MODE) r10DebugLog('GAMEPAD UI INPUT -> CONTROL MODE SELECTED (controller)');
        handleModeSelect('controller');
        state.gamepadSettleUntil = (now || 0) + GAMEPAD_SETTLE_MS;
        if (DEBUG_MODE) r10DebugLog('GAMEPLAY INPUT ENABLED');
        return { move: gpMove, light: gpLight, aim: gpAim, aimAdjust: gpAimAdjust, fire: gpFire, focusHeld: gpFocusHeld };
      }
    }

    // ESCAPE-EXCLUSIVE CONTROL SCHEME. This mode has its own fixed mapping
    // (LB/X=WEST dash, RB/B=EAST dash, Y=NORTH backstep, A=SOUTH dash,
    // D-PAD+LEFT STICK unified for lateral dodge) and NO combat input
    // exists in it at all — so this branch returns BEFORE any of LAB's own
    // STEALTH(LT+RT)/D-PAD-AIM-trim/gpFire(RB)/FOCUS(LB)/DASH(X/Y/B/A)/
    // RELOAD(L3) code below ever runs. That is what guarantees a single
    // button press can never produce both an ESCAPE action AND a LAB
    // combat action (e.g. RB must never both EAST-dash and FIRE) — the LAB
    // lines simply never execute while state.gameMode === 'escape', rather
    // than being individually suppressed after the fact.
    if (state.gameMode === 'escape') {
      const dpadLeft = pressed(14), dpadRight = pressed(15);
      let lateral;
      if (dpadLeft && !dpadRight) lateral = -1;
      else if (dpadRight && !dpadLeft) lateral = 1;
      else lateral = applyEscapeMoveCurve(gp.axes[0] || 0); // LEFT STICK — 11TH ROUND item 5: was applyLightCurve() (flashlight-tuned, too compressed for run/dodge); D-PAD above is unaffected either way (already binary)
      gpMove.x = lateral;
      // 12TH ROUND (item 15): a continuous NORTH/SOUTH axis for ESCAPE's
      // new free-roam depth movement — previously this branch left
      // gpMove.y permanently at 0 (Y/N/S input only ever fired the DASH
      // actions below). D-PAD UP(12)/DOWN(13) are binary like X's D-PAD
      // pair above; LEFT STICK vertical otherwise, same curve as X.
      const dpadUp = pressed(12), dpadDown = pressed(13);
      let depthAxis;
      if (dpadUp && !dpadDown) depthAxis = -1;
      else if (dpadDown && !dpadUp) depthAxis = 1;
      else depthAxis = applyEscapeMoveCurve(gp.axes[1] || 0);
      gpMove.y = depthAxis;

      if (edge(4) || edge(2)) state.escape.actions.westDash = true;      // LB or X = WEST DASH
      if (edge(5) || edge(1)) state.escape.actions.eastDash = true;      // RB or B = EAST DASH
      if (edge(3)) state.escape.actions.northBackstep = true;             // Y = NORTH BACKSTEP
      if (edge(0)) state.escape.actions.southDash = true;                 // A = SOUTH DASH
      if (edge(9)) state.actions.pauseToggle = true;                      // Start/Menu — generic UI, shared with LAB, not combat

      const nextPrevEscape = new Array(b.length);
      for (let i = 0; i < b.length; i++) nextPrevEscape[i] = pressed(i);
      state.prevButtons = nextPrevEscape;

      return { move: gpMove, light: gpLight, aim: gpAim, aimAdjust: gpAimAdjust, fire: false, focusHeld: false };
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
    // 15TH ROUND (items 29-34): FOCUS is now a RIGHT-STICK-CLICK (R3,
    // button 11) HOLD — pressed(11) alone is a raw instantaneous read, so
    // r3HoldStartAt tracks the REAL wall-clock moment R3 was first pressed
    // (set once on its own rising edge, cleared the instant it releases)
    // and gpFocusHeldLocal only goes true once that duration crosses
    // FOCUS_R3_HOLD_MS — a short tap never reaches the threshold and so
    // never activates FOCUS at all (item 30). LB is FULLY freed of FOCUS
    // duty here (see edge(4) below — LB is RELOAD only now), resolving the
    // double-booking the 10TH ROUND's own comment used to describe.
    const r3Pressed = pressed(11);
    if (r3Pressed && state.r3HoldStartAt == null) state.r3HoldStartAt = now || 0;
    else if (!r3Pressed) state.r3HoldStartAt = null;
    const gpFocusHeldLocal = r3Pressed && state.r3HoldStartAt != null && (now || 0) - state.r3HoldStartAt >= FOCUS_R3_HOLD_MS;
    if (edge(3)) state.actions.northDash = true;      // Y = NORTH DASH
    if (edge(2)) state.actions.westDash = true;       // X = WEST DASH
    if (edge(1)) state.actions.eastDash = true;       // B = EAST DASH
    if (edge(0)) state.actions.southDash = true;      // A = SOUTH DASH / BACKSTEP
    // 10TH ROUND (items 28-29) / 15TH ROUND (items 29, 34): LB is the
    // PRIMARY controller RELOAD in COMBAT MODE, confirmed unchanged this
    // round — and since FOCUS moved off LB onto R3-HOLD above, LB is now
    // PURELY a RELOAD trigger with no second duty at all (the 10TH ROUND's
    // "LB is held for FOCUS but an edge for RELOAD, not mutually exclusive"
    // note no longer applies — there is nothing left to be exclusive with).
    if (edge(4)) state.actions.reload = true;         // LB = RELOAD (primary)
    if (edge(10)) state.actions.reload = true;        // L3 = RELOAD (legacy, kept working)
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
// ESCAPE-exclusive routing: these two buttons already existed for LAB's
// NORTH DASH/SOUTH BACKSTEP — reused (same touch slot, same label meaning
// direction-wise) for ESCAPE's Y NORTH BACKSTEP/A SOUTH DASH, but written
// into the SEPARATE state.escape.actions bucket, never LAB's state.actions,
// so the two modes' dash bookkeeping can never collide.
wireButton('touch-dash-n', () => {
  if (state.gameMode === 'escape') state.escape.actions.northBackstep = true;
  else state.actions.northDash = true;
});
wireButton('touch-dash-s', () => {
  if (state.gameMode === 'escape') state.escape.actions.southDash = true;
  else state.actions.southDash = true;
});
// ESCAPE-exclusive: LB/X WEST DASH and RB/B EAST DASH have no gamepad-button
// touch equivalent anywhere in LAB (LAB's touch bar has no west/east dash
// button at all), so two new buttons are added (index.html #touch-dash-w/
// #touch-dash-e, class touch-escape-only — hidden unless body.escape-mode,
// see style.css) rather than leaving WEST/EAST dash touch-inaccessible.
wireButton('touch-dash-w', () => { if (state.gameMode === 'escape') state.escape.actions.westDash = true; });
wireButton('touch-dash-e', () => { if (state.gameMode === 'escape') state.escape.actions.eastDash = true; });

// 9TH ROUND (item 0-2): STAGE TYPE (state.theme — cosmetic world/background
// only) and GAME MODE (state.gameMode — control scheme + win condition)
// are now set from two SEPARATE button rows, each touching only its own
// field. Neither handler infers the other's value anymore — the old
// `state.gameMode = state.theme === 'escape' ? 'escape' : 'combat'` hard
// coupling in the STAGE TYPE handler is gone. setGameMode() below is the
// one shared place that applies a GAME MODE change's side effects (the
// escape-mode body class LIGHT/HUD CSS reads), called from both the new
// #gamemode-switch buttons AND (for backward compatibility with anyone
// still driving mode purely via the old ESCAPE stage button in existing
// test scripts) nowhere else — the two are now genuinely independent.
function setGameMode(mode) {
  state.gameMode = mode;
  document.body.classList.toggle('escape-mode', mode === 'escape');
  document.querySelectorAll('.gamemode-btn').forEach((b) => b.classList.toggle('active', b.dataset.gamemode === mode));
  // 9TH ROUND (item 36): fresh TIME LIMIT every time ESCAPE MODE is
  // (re-)entered, so a stale countdown from a previous run never carries
  // over. Never touches state.player/state.enemy — LAB's own RELOAD/HP/etc.
  // are completely unaffected by switching GAME MODE.
  if (mode === 'escape') {
    state.escape.timeLeftSec = ESCAPE_TIME_LIMIT_SEC;
    state.clearSequence.active = false;
    state.clearSequence.phase = 'idle';
  }
}

document.querySelectorAll('.theme-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.theme-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.theme = btn.dataset.theme;
    themeLabelEl.textContent = THEMES[state.theme].label;
    // STAGE TYPE no longer touches state.gameMode at all (see setGameMode()).
  });
});
document.querySelectorAll('.gamemode-btn').forEach((btn) => {
  btn.addEventListener('click', () => setGameMode(btn.dataset.gamemode));
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

// 12TH ROUND (items 6-9): DEBUG DISPLAY ON/OFF — toggles the VISUAL panels
// (#debug-panel FPS bar + #r10-debug-panel) only; DEBUG COLLECTION
// (DEBUG_MODE, r10DebugState) is always on regardless of this. Reachable
// from PAUSE MENU on ANY URL now, not just ?debug=1 (see DEBUG_URL_FLAG).
const pauseDebugToggleBtnEl = document.getElementById('pause-debug-toggle');
const debugPanelEl = document.getElementById('debug-panel');
function setDebugPanelVisible(visible) {
  state.debugPanelVisible = visible;
  debugPanelEl.hidden = !visible;
  r10DebugPanelEl.hidden = !visible;
  pauseDebugToggleBtnEl.textContent = 'DEBUG DISPLAY : ' + (visible ? 'ON' : 'OFF');
  if (visible) r10DebugLog('DEBUG PANEL ACTIVE');
}
setDebugPanelVisible(state.debugPanelVisible);
pauseDebugToggleBtnEl.addEventListener('pointerdown', (e) => { e.preventDefault(); setDebugPanelVisible(!state.debugPanelVisible); });

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
  if (!bgmAudioEl.paused) {
    bgmStarted = true;
    // 9TH ROUND (item 39-43): stamped only on a REAL successful play() —
    // diagnostic-only, deliberately separate from any gamepad-input gating
    // (see the pointerdown/gamepadconnected comments above) so the DEBUG
    // panel can show audio-unlock timing without ever conflating "audio
    // needs a gesture" with "gamepad input needs a gesture."
    if (!state.audioUnlockedAt) {
      state.audioUnlockedAt = performance.now();
      if (DEBUG_MODE) r10DebugLog('AUDIO UNLOCKED');
    }
  }
}

// 14TH ROUND (items 12-14): the comment above has always described
// tryStartBgm() as retrying from "a touch/mouse pointerdown, a keydown, or
// the first detected gamepad button press" — but until this round, the ONLY
// real call site was the single tryStartBgm() inside handleModeSelect()
// (the gamepad-button retry was added to pollGamepad() above this round;
// these two listeners are the touch/mouse/keyboard half of the same fix).
// Root cause of "実機で音が全く鳴らない": if that one mode-select-click
// attempt's play() didn't result in genuinely-started playback (a real-
// device-only autoplay-policy/timing race — this could not be reproduced in
// headless Chromium/Playwright testing, where BGM played correctly on the
// very first attempt every time), NOTHING ever called tryStartBgm() again
// for the rest of the session, leaving it permanently silent despite
// bgmAudioEl itself being perfectly valid. tryStartBgm() is safe to call
// repeatedly (bgmStarted guards every call after the real first success into
// a no-op — never a second overlapping instance, never reverts the non-
// blocking BGM loading), so these listeners simply keep giving it more
// chances until one sticks, then remove themselves.
function bgmRetryOnGesture() {
  if (bgmStarted) {
    window.removeEventListener('pointerdown', bgmRetryOnGesture);
    window.removeEventListener('keydown', bgmRetryOnGesture);
    return;
  }
  tryStartBgm();
}
window.addEventListener('pointerdown', bgmRetryOnGesture, { passive: true });
window.addEventListener('keydown', bgmRetryOnGesture);

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
  if (DEBUG_MODE) { r10DebugState.inputMode = mode; r10DebugLog('MODE SELECTED: ' + mode); }
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

// 7TH ROUND PART 11: CONTROLLER AIM SENSITIVITY (LOW/NORMAL/HIGH) — takes
// effect immediately (controllerAimSensitivity is read fresh every frame
// in frame()'s own input section), no separate "apply" step. TOUCH AIM is
// never affected — see controllerAimSensitivity's own comment.
document.querySelectorAll('.aim-sens-btn').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    document.querySelectorAll('.aim-sens-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    controllerAimSensitivity = AIM_SENSITIVITY_PRESETS[btn.dataset.sens] || AIM_SENSITIVITY_PRESETS.standard;
  });
});

// ---------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------

function consumeActions() {
  const a = state.actions;
  const out = { ...a };
  a.reload = a.stealth = a.northDash = a.southDash = a.eastDash = a.westDash = a.pauseToggle = false;
  return out;
}

// ESCAPE-exclusive mirror of consumeActions() above, operating on the
// separate state.escape.actions bucket — kept as its own function (not a
// parameter added to consumeActions()) so LAB's own action-consumption
// logic is untouched.
function consumeEscapeActions() {
  const a = state.escape.actions;
  const out = { ...a };
  a.westDash = a.eastDash = a.northBackstep = a.southDash = false;
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
  if (actions.westDash) { p.dashDir = -1; p.dashUntil = now + DASH_DURATION_MS; p.dashStrafeStart = p.strafeOffset; p.invincibleUntil = now + DASH_INVINCIBLE_MS; const m = playerMarkerPos(); spawnDashStreak(m.x, m.y, -1, 0, now); }
  if (actions.eastDash) { p.dashDir = 1; p.dashUntil = now + DASH_DURATION_MS; p.dashStrafeStart = p.strafeOffset; p.invincibleUntil = now + DASH_INVINCIBLE_MS; const m = playerMarkerPos(); spawnDashStreak(m.x, m.y, 1, 0, now); }
  if (now < p.dashUntil) {
    const tNorm = 1 - (p.dashUntil - now) / DASH_DURATION_MS;
    const eased = 1 - Math.pow(1 - tNorm, 2);
    p.strafeOffset = Math.max(-maxOff, Math.min(maxOff, p.dashStrafeStart + p.dashDir * STRAFE_DASH_DISTANCE_PX * eased));
  }

  // 12TH ROUND (items 12, 28-30): BARREL no longer blocks PLAYER movement
  // at all — clampStrafeForBarrels() (kept defined, just unused for
  // movement below per item 30's explicit "撤去" instruction) used to
  // clamp strafeOffset to whichever barrel edge was closest, which is
  // exactly the "特定X座標に引っかかる" complaint. isPlayerInCover() is a
  // SEPARATE, still-fully-intact check (its own BARREL_TOUCH_RADIUS_PX/
  // BARREL_TOUCH_Z_MAX proximity test, not this clamp) — see item 29's
  // "通過可能 + COVER可能" requirement.

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

  // NORTH/SOUTH world scroll (unchanged — the world still scrolls past a
  // screen-fixed player, see applyForwardDelta()) + PLAYER PERSPECTIVE
  // (12TH ROUND items 13-14): p.depthPos is now a genuinely PERSISTENT,
  // continuously-driven lean position (was: an instant scaleTarget=
  // 0.94/1.06/1.0 snap with no memory between frames) — moveY pushes it
  // toward ±1 while held, and it eases back toward 0 on release (see
  // PLAYER_DEPTH_RECOVER_PER_SEC) instead of the render-layer p.scale
  // itself snapping straight to a fixed target. p.scale then eases toward
  // perspectiveScaleFromDepth(p.depthPos) exactly as it always eased
  // toward p.scaleTarget — same damping, smoother underlying source.
  let forwardDelta = 0;
  if (moveY < 0) { forwardDelta += WALK_FORWARD_SPEED * dt; p.depthPos = Math.min(1, p.depthPos + PLAYER_DEPTH_RECOVER_PER_SEC * dt); }
  else if (moveY > 0) { forwardDelta -= WALK_BACK_SPEED * dt; p.depthPos = Math.max(-1, p.depthPos - PLAYER_DEPTH_RECOVER_PER_SEC * dt); }
  else { p.depthPos += (0 - p.depthPos) * Math.min(1, dt * PLAYER_DEPTH_RECOVER_PER_SEC); }

  // PART 1 fix: forward/back DASH now covers a fixed TOTAL world-z
  // distance over DASH_DURATION_MS, using the same "recompute absolute
  // progress each frame, apply only the incremental delta" pattern as the
  // strafe dash above (fwdDashCoveredZ tracks how much of the total has
  // already been applied) — framerate-independent, and no more coupled to
  // an arbitrary "*3.2" burst multiplier that let the old numbers balloon.
  if (actions.northDash) { p.fwdDashSign = 1; p.fwdDashUntil = now + DASH_DURATION_MS; p.fwdDashCoveredZ = 0; p.invincibleUntil = now + DASH_INVINCIBLE_MS; const m = playerMarkerPos(); spawnDashStreak(m.x, m.y, 0, -1, now); }
  if (actions.southDash) { p.fwdDashSign = -1; p.fwdDashUntil = now + DASH_DURATION_MS; p.fwdDashCoveredZ = 0; p.invincibleUntil = now + DASH_INVINCIBLE_MS; const m = playerMarkerPos(); spawnDashStreak(m.x, m.y, 0, 1, now); }
  if (now < p.fwdDashUntil) {
    const tNorm = 1 - (p.fwdDashUntil - now) / DASH_DURATION_MS;
    const eased = 1 - Math.pow(1 - tNorm, 2);
    const totalDist = p.fwdDashSign > 0 ? DASH_FORWARD_DISTANCE_Z : DASH_BACK_DISTANCE_Z;
    const coveredNow = totalDist * eased;
    forwardDelta += p.fwdDashSign * (coveredNow - p.fwdDashCoveredZ);
    p.fwdDashCoveredZ = coveredNow;
    p.depthPos = p.fwdDashSign > 0 ? 1 : -1;
  }

  p.scale += (perspectiveScaleFromDepth(p.depthPos, PLAYER_DEPTH_SCALE_RANGE) - p.scale) * Math.min(1, dt * 10);

  // toggle STEALTH — stealthToggledAt drives the enter/exit fade (PART 5)
  if (actions.stealth) { p.stealth = !p.stealth; p.stealthToggledAt = now; }

  // RELOAD — 9TH ROUND (items 3-5): AMMO=0 now starts an AUTO RELOAD on its
  // own, in addition to the existing manual RELOAD button. 10TH ROUND
  // (items 28/30/31) real-device report: after several magazines the
  // player permanently stopped being able to fire again, and MANUAL RELOAD
  // appeared to do nothing. Root-caused by tracing the FULL input->refill
  // path: both trigger conditions here required `p.reserve > 0` — once
  // p.reserve (finite, RESERVE_MAX=48) hit exactly 0, NEITHER AUTO nor
  // MANUAL reload could ever START again (the gate itself excluded it), so
  // the magazine could never be topped up again — a genuine permanent
  // lockout, not a one-off fluke. Per this round's explicit "MAGAZINEは
  // 有限だが弾薬総量が尽きて永久に撃てなくなる状態は避けたい" requirement:
  // the reserve>0 gate is removed from both triggers (a reload can always
  // at least attempt to start), and the completion step below resupplies
  // p.reserve back to RESERVE_MAX BEFORE computing this reload's own
  // refill amount whenever it would otherwise be empty — so the magazine
  // loop (fire -> empty -> reload -> full again) can never permanently
  // break, while reserve still ticks down and matters during normal play.
  if (actions.reload && DEBUG_MODE) r10DebugLog('RELOAD INPUT');
  if (p.ammo <= 0 && !p.reloading) {
    p.reloading = true;
    p.reloadType = 'auto';
    p.reloadUntil = now + AUTO_RELOAD_MS;
    if (DEBUG_MODE) r10DebugLog('AUTO RELOAD START (ammo=0 reserve=' + p.reserve + ')');
  } else if (actions.reload && !p.reloading && p.ammo < MAG_SIZE) {
    p.reloading = true;
    p.reloadType = 'manual';
    p.reloadUntil = now + RELOAD_MS;
    if (DEBUG_MODE) r10DebugLog('MANUAL RELOAD START (ammo=' + p.ammo + ' reserve=' + p.reserve + ')');
  } else if (actions.reload && DEBUG_MODE) {
    r10DebugLog('RELOAD BLOCKED: ' + (p.reloading ? 'ALREADY RELOADING' : 'MAGAZINE FULL'));
  }
  if (p.reloading && now >= p.reloadUntil) {
    if (p.reserve <= 0) p.reserve = RESERVE_MAX; // auto-resupply — see comment above
    const ammoBefore = p.ammo, reserveBefore = p.reserve;
    const need = MAG_SIZE - p.ammo;
    const take = Math.min(need, p.reserve);
    p.ammo += take;
    p.reserve -= take;
    p.reloading = false;
    if (DEBUG_MODE) r10DebugLog((p.reloadType === 'auto' ? 'AUTO' : 'MANUAL') + ' RELOAD COMPLETE (ammo ' +
      ammoBefore + '->' + p.ammo + ', reserve ' + reserveBefore + '->' + p.reserve + ')');
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
    // 12TH ROUND (items 54-59): snap to getEffectiveHitPoint() — the SAME
    // real damage point isAimOnEffectiveHit()/updateBullets() use (the HEAD
    // circle for roid1/roid2, never the raw sprite/body center) — so FOCUS
    // can never pull AIM onto a spot that wouldn't actually register as a
    // hit.
    const rect = computeEnemyDrawRect();
    const hitPt = getEffectiveHitPoint(rect);
    const baseX = state.centerX + p.strafeOffset;
    const baseY = state.horizonY + state.cssH * 0.06;
    const targetLiveX = clamp(hitPt.x - baseX - p.aimManualOffsetX, -AIM_RANGE, AIM_RANGE);
    const targetLiveY = clamp(hitPt.y - baseY - p.aimManualOffsetY, -AIM_RANGE, AIM_RANGE);
    const approachT = Math.min(1, dt * AUTO_AIM_APPROACH_RATE);
    p.aimLiveX += (targetLiveX - p.aimLiveX) * approachT;
    p.aimLiveY += (targetLiveY - p.aimLiveY) * approachT;
    // 13TH ROUND (items 9-19, real-device fix): LIGHT's own center follows
    // the SAME hit point while FOCUS is active, by moving p.lightPersistX/Y
    // DIRECTLY — the SAME single persistent-position field manual LEFT
    // STICK input drives below (see the else-branch and getFlashlightCenter()).
    // Round 12 used a SEPARATE additive p.lightFocusOffsetX/Y layered on top
    // of a raw (non-persistent) stick read — that was the root cause of two
    // real-device bugs: (1) LIGHT snapping back to the base center the
    // instant the stick returned to neutral (state.input.lightX/Y is an
    // absolute per-frame stick deflection, not a delta — reading it directly
    // as "the base position" meant releasing the stick always recomputed
    // base=center), and (2) AIM then reading as permanently stuck to the
    // LIGHT circle's outer edge, because getAimPoint()'s own clamp (which is
    // otherwise correct) was clamping AIM's stable absolute position against
    // a LIGHT that snapped back to center every single frame. Using ONE
    // persistent LIGHT position field — exactly the architecture aimLiveX/Y
    // already used successfully — removes both the recenter bug and the
    // "two variables competing" risk in one fix.
    const targetLightPersistX = clamp(hitPt.x - state.centerX, -LIGHT_RANGE, LIGHT_RANGE);
    const targetLightPersistY = clamp(hitPt.y - (state.horizonY + state.cssH * 0.06), -LIGHT_RANGE, LIGHT_RANGE);
    p.lightPersistX += (targetLightPersistX - p.lightPersistX) * approachT;
    p.lightPersistY += (targetLightPersistY - p.lightPersistY) * approachT;
  } else {
    // Manual AIM: stick input (already deadzoned/curved upstream by
    // applyAimCurve()) drives VELOCITY, not absolute position. Deadzone
    // means state.input.aimX/Y is exactly 0 while the stick is neutral, so
    // this is naturally a no-op (position frozen) without any special-case
    // branch for "stick released".
    p.aimLiveX = clamp(p.aimLiveX + state.input.aimX * AIM_MOVE_SPEED_PX_S * dt, -AIM_RANGE, AIM_RANGE);
    p.aimLiveY = clamp(p.aimLiveY + state.input.aimY * AIM_MOVE_SPEED_PX_S * dt, -AIM_RANGE, AIM_RANGE);
    // 13TH ROUND (items 9-19): manual LEFT STICK LIGHT control — the SAME
    // persistent-position pattern as AIM directly above (velocity input,
    // deadzone already zeroes state.input.lightX/Y at neutral so this is a
    // natural no-op when the stick is released — LIGHT simply stays exactly
    // where it was, never recentering). Only runs outside FOCUS — FOCUS
    // owns p.lightPersistX/Y exclusively above, the identical mutual-
    // exclusion rule aimLiveX/Y already uses.
    p.lightPersistX = clamp(p.lightPersistX + state.input.lightX * LIGHT_MOVE_SPEED_PX_S * dt, -LIGHT_RANGE, LIGHT_RANGE);
    p.lightPersistY = clamp(p.lightPersistY + state.input.lightY * LIGHT_MOVE_SPEED_PX_S * dt, -LIGHT_RANGE, LIGHT_RANGE);
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
    // 9TH ROUND (items 7-8): track REAL south movement (D-PAD DOWN/LEFT
    // STICK DOWN, moveY>0 per the same sign convention applyForwardDelta()
    // uses) separately from the pose-state `p.facing` above — this is
    // ONLY consulted by renderPlayer() for the normal WALK sprite choice,
    // never by BACKSTEP (which keeps using dashN unconditionally, see its
    // own comment) or any other special action.
    p.moveDirSouth = moveY > 0.05;
  } else {
    p.facing = 'idle';
  }

  // COVER ACTION: facing tracker (NEW) — monitors the SAME moveX/moveY
  // this function already receives, continuously, regardless of whether
  // COVER is currently active (renderPlayer() is the only thing that ever
  // reads p.coverFacing, and only while isPlayerInCover() is true — see
  // its own comment). Whichever axis has the larger held deflection wins;
  // with no input held at all, p.coverFacing simply keeps its last value
  // rather than resetting to a default, so ducking behind a barrel with
  // no further input keeps showing whichever direction was last faced.
  if (Math.abs(moveY) >= Math.abs(moveX)) {
    if (moveY < -0.15) p.coverFacing = 'north';
    else if (moveY > 0.15) p.coverFacing = 'south';
  } else {
    if (moveX < -0.15) p.coverFacing = 'west';
    else if (moveX > 0.15) p.coverFacing = 'east';
  }

  return forwardDelta;
}

// ---------------------------------------------------------------------
// ESCAPE-EXCLUSIVE PLAYER UPDATE. A dedicated function, not a branch bolted
// onto updatePlayer() above — updatePlayer() is LAB's own AIM/FIRE/RELOAD/
// STEALTH/FOCUS/walk-animation/DASH logic end to end, and per spec this
// mode must not repurpose or partially share that pipeline. Only called
// from frame() while state.gameMode === 'escape' (updatePlayer() itself is
// simply never called in that case). Returns a forwardDelta the same way
// updatePlayer() does, so it can be handed to the SAME existing
// applyForwardDelta()/clampForwardDeltaForBarrels() (a real, deliberate
// reuse: those two are generic world-scroll/collision math, not "LAB
// control scheme").
// ---------------------------------------------------------------------
function updateEscapePlayer(dt, now, moveX, moveY, actions) {
  const p = state.player; // strafeOffset is a generic on-screen-position field, reused as-is (see state.escape's own comment)
  const es = state.escape;

  // Continuous lateral dodge — moveX already unifies D-PAD + LEFT STICK
  // upstream (see pollGamepad()'s ESCAPE-exclusive branch, now using
  // applyEscapeMoveCurve() — item 5), so this single read satisfies
  // "D-PAD and LEFT STICK must drive the SAME movement logic" without any
  // extra plumbing here.
  p.strafeOffset += moveX * ESCAPE_STRAFE_SPEED * dt;
  const maxOff = state.cssW * STRAFE_MAX_OFFSET; // reused: a generic screen-fraction clamp bound, not LAB-specific behavior
  p.strafeOffset = Math.max(-maxOff, Math.min(maxOff, p.strafeOffset));

  // NEXT ROUND PART N: normal (non-DASH) lateral movement leans the whole
  // bike sprite up to ESCAPE_LEAN_MAX_RAD toward the travel direction —
  // smoothed toward the target AND back to 0 on neutral input (never an
  // instant snap either way). Driven by raw moveX (not strafeOffset), so it
  // reads as "leaning because I'm steering", independent of clamp state.
  const targetLean = Math.max(-1, Math.min(1, moveX)) * ESCAPE_LEAN_MAX_RAD;
  es.leanAngle += (targetLean - es.leanAngle) * Math.min(1, dt * ESCAPE_LEAN_SMOOTH_RATE);

  // 12TH ROUND (items 15-17): continuous NORTH/SOUTH — the SECOND free axis
  // ("横一直線移動から解放"), read from the SAME moveY the shared MOVE
  // pipeline already produces for touch (touchMove.y) and now also for
  // gamepad (see pollGamepad()'s ESCAPE branch, which previously left
  // gpMove.y at 0 always). moveY<0 (stick/D-PAD UP) = NORTH = away =
  // es.depthPos toward +1; moveY>0 = SOUTH = toward -1. No auto-recovery —
  // see ESCAPE_DEPTH_SPEED's own comment.
  es.depthPos = Math.max(-1, Math.min(1, es.depthPos - moveY * ESCAPE_DEPTH_SPEED * dt));

  // 11TH ROUND (items 6-8, 32): DASH is now a true INSTANT teleport — the
  // full distance is applied in THIS single frame (no eased travel window
  // to accumulate across), and a short blink+invulnerability window starts
  // at the same instant, reusing p.invincibleUntil (the SAME i-frame field
  // LAB's own DASH already sets — no second invulnerability system, per
  // item 7's explicit "reuse existing" instruction). All 4 directions
  // funnel through the same two lines of logic (item 8's "統一") — only
  // WHICH value (screen-x vs world-z) and WHICH distance constant differs.
  // NEXT ROUND PART M/O: lateral (WEST/EAST) DASH no longer spawns the old
  // spawnDashStreak() white-stick/line-bundle trail (PART O — the repeated
  // "tire white line" complaint) and no longer strobes the live sprite
  // (PART M — banned as eye-straining). Instead it snapshots the REAL
  // current PLAYER run-frame at its pre-dash screen position (a genuine
  // afterimage, start point) plus one interpolated mid-point snapshot,
  // BEFORE strafeOffset actually moves — see computeEscapePlayerDrawRect()/
  // renderEscapePlayer() for how these are drawn and faded out.
  if (actions.westDash || actions.eastDash) {
    const dashDirSign = actions.westDash ? -1 : 1;
    const oldCx = state.centerX + p.strafeOffset;
    const bottomYNow = state.cssH * 1.02 - es.depthPos * ESCAPE_DEPTH_SCREEN_RANGE_PX;
    const frameNow = ASSETS_PLAYER_ESCAPE_RUN[es.runFrame];
    if (imgReady(frameNow.img)) {
      const startRect = computeEscapePlayerDrawRect(oldCx, bottomYNow, frameNow, es.depthPos, es.dashScalePulse);
      es.afterimages.push({ img: frameNow.img, dx: startRect.dx, dy: startRect.dy, drawW: startRect.drawW, drawH: startRect.drawH, until: now + ESCAPE_AFTERIMAGE_MS });
      const midCx = oldCx + dashDirSign * ESCAPE_STRAFE_DASH_DISTANCE_PX * 0.5;
      const midRect = computeEscapePlayerDrawRect(midCx, bottomYNow, frameNow, es.depthPos, es.dashScalePulse);
      es.afterimages.push({ img: frameNow.img, dx: midRect.dx, dy: midRect.dy, drawW: midRect.drawW, drawH: midRect.drawH, until: now + ESCAPE_AFTERIMAGE_MS * 0.7 });
    }
    p.strafeOffset = Math.max(-maxOff, Math.min(maxOff, p.strafeOffset + dashDirSign * ESCAPE_STRAFE_DASH_DISTANCE_PX));
    p.invincibleUntil = now + ESCAPE_DASH_BLINK_MS;
    es.lateralDashBlinkSuppressUntil = now + ESCAPE_DASH_BLINK_MS;
  }

  // Continuous, automatic SOUTH-heading auto-scroll. 8TH ROUND (item 13,
  // real-device feedback): ESCAPE's background must scroll the OPPOSITE
  // direction from LAB/ARMORED's own forward-walk convention —
  // ESCAPE_DIR_SIGN flips the whole travel axis (base auto-scroll AND both
  // dash terms), a genuine background-scroll reversal, never an input
  // remap. LAB/ARMORED's own applyForwardDelta()/updatePlayer() north-walk
  // code is untouched — this sign lives only in this function.
  const ESCAPE_DIR_SIGN = -1;
  let forwardDelta = ESCAPE_DIR_SIGN * ESCAPE_AUTO_SCROLL_SPEED * dt;
  // 11TH ROUND (items 6-8): SOUTH/NORTH DASH — same instant-teleport
  // treatment, applied to the world-scroll axis instead of screen-x (item
  // 8 explicitly allows different axes/distances per direction, since a
  // literal x-pixel jump has no equivalent meaning in z-depth). 12TH ROUND:
  // also nudges es.depthPos (a smaller, bounded push, not a snap to ±1 —
  // items 16-17's screen-position/scale movement layered on top of the
  // world-z burst) so the dash reads as a real forward/back lunge, not just
  // a scroll-speed blip.
  if (actions.southDash) {
    forwardDelta += ESCAPE_DIR_SIGN * ESCAPE_SOUTH_DASH_DISTANCE_Z;
    p.invincibleUntil = now + ESCAPE_DASH_BLINK_MS;
    es.depthPos = Math.max(-1, es.depthPos - ESCAPE_DEPTH_DASH_NUDGE);
    // 13TH ROUND (item 1): SOUTH DASH = lunging toward the camera, so a
    // brief +2% scale pulse on top of the normal depth perspective — never
    // a replacement for it (see the decay tick below and the multiply in
    // renderEscapePlayer()).
    es.dashScalePulse = 1.02;
    // NEXT ROUND PART O: the old spawnDashStreak() white-stick trail call
    // that used to sit here is removed — SOUTH DASH's own scale-pulse +
    // blink already convey the lunge without it.
  }
  if (actions.northBackstep) {
    forwardDelta += ESCAPE_DIR_SIGN * -ESCAPE_NORTH_BACKSTEP_DISTANCE_Z;
    p.invincibleUntil = now + ESCAPE_DASH_BLINK_MS;
    es.depthPos = Math.min(1, es.depthPos + ESCAPE_DEPTH_DASH_NUDGE);
    // NORTH DASH = lunging away, so a brief -2% pulse (same decay).
    es.dashScalePulse = 0.98;
    // NEXT ROUND PART O: the old spawnDashStreak() white-stick trail call
    // that used to sit here is removed — see the SOUTH DASH branch above.
  }
  // 13TH ROUND (item 1): decay dashScalePulse back to exactly 1 — runs
  // every ESCAPE frame regardless of whether a dash just fired, so it can
  // never get stuck away from 1. ~120ms time constant: "short time", never
  // a residual +2%/-2%. WEST/EAST DASH never sets this field, so it stays
  // untouched (already decayed to 1) for lateral dashes, per spec.
  es.dashScalePulse += (1 - es.dashScalePulse) * Math.min(1, dt * ESCAPE_DASH_SCALE_PULSE_DECAY_RATE);

  // 11TH ROUND (items 1-4): the always-on 5-frame RUN LOOP — cycles
  // continuously for as long as ESCAPE is running, completely independent
  // of moveX/facing/dash (see renderEscapePlayer(): it no longer reads
  // es.facing at all). es.facing/animFrame above are left populated
  // (harmless, unused) per item 28 — nothing deletes the old asset/state.
  es.runElapsedMs += dt * 1000;
  if (es.runElapsedMs >= ESCAPE_ANIM_FRAME_MS) {
    es.runElapsedMs -= ESCAPE_ANIM_FRAME_MS;
    es.runFrame = (es.runFrame + 1) % ASSETS_PLAYER_ESCAPE_RUN.length;
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
  // 7TH ROUND PART 9: GABRIEL's NORMAL-state approach floor is now its own,
  // larger GABRIEL_NORMAL_Z_MIN — the CLAW attack sequence still closes the
  // rest of the distance down to the original (unchanged) GABRIEL_Z_MIN on
  // its own, separate from this player-driven clamp (see updateEnemy()).
  // 9TH ROUND (item 21-26 fix): while a CLAW attack sequence is in progress
  // (anything but 'idle'), the attack's OWN z-management (see updateEnemy(),
  // 'approach'/'recovery' sub-states) must have exclusive control — this
  // per-frame player-driven floor used to unconditionally win every frame
  // (it runs BEFORE updateEnemy() in frame()), snapping GABRIEL back out to
  // 260 the instant 'approach' ended, before its swing/telegraph ever
  // rendered at the intended close distance. Only the player's own forward
  // walking is gated by this floor now; ROID/ADAM SPHERE (non-claw types)
  // are unaffected, matching their unchanged existing behavior.
  // 13TH ROUND (item 2, real-device fix): this whole player-driven z-floor
  // represents "the PLAYER is walking toward/away from the enemy on foot" —
  // a COMBAT-only concept. In ESCAPE, forwardDelta is the automatic,
  // always-on, non-player-driven auto-scroll (ESCAPE_AUTO_SCROLL_SPEED,
  // now 2x as of Round 12), so this same clamp was running every single
  // ESCAPE frame for every non-claw type (isClawIdle was unconditionally
  // true for them, so it was NEVER gated by attackState) and continuously
  // dragging e.z toward ENEMY_Z_MAX during the enemy's OWN attack windup —
  // verified live: z climbed ~890->1500 over the course of a single
  // sniper/missile attack sequence, receding the enemy to a tiny, distant
  // speck exactly while it was supposed to be attacking. ESCAPE already has
  // its own dedicated z owner, updateEscapeEnemyPursuit() (oscillates while
  // idle, freezes during any attack — the exact "attack owns z exclusively"
  // rule COMBAT's claw types already follow), so this block is simply
  // skipped in ESCAPE and left entirely to that system.
  if (state.gameMode !== 'escape') {
    const isClaw = e.type === 'gabriel' || e.type === 'adam';
    // NEXT-ROUND PART C (root-cause fix): root cause of "SOUTH DASH creates
    // no real distance from GABRIEL/ADAM right after a melee attack" was
    // this whole player-driven z update being gated to ONLY
    // attackState==='idle' for claw types — 'recovery' (900ms) and
    // 'cooldown' (1200ms), together roughly 2 seconds right after every
    // attack, silently ignored the player's own forward/back movement
    // entirely. 'cooldown' has no z-tween of its own (confirmed in
    // updateEnemy()), so it can now take the exact same direct update idle
    // already used. 'recovery' DOES actively tween e.z every frame in
    // updateEnemy() (which runs after this), so writing e.z here would just
    // be silently overwritten — instead this accumulates the player's
    // movement into e.clawDistanceBonusZ, which updateEnemy()'s recovery
    // tween reads and offsets its own target by (see that block's comment).
    const isClawIdleLike = isClaw ? (e.attackState === 'idle' || e.attackState === 'cooldown') : true;
    if (isClawIdleLike) {
      const zMin = e.type === 'gabriel' ? GABRIEL_NORMAL_Z_MIN : (e.type === 'adam' ? ADAM_NORMAL_Z_MIN : approachZMinForRoid());
      e.z = Math.max(zMin, Math.min(ENEMY_Z_MAX, e.z - forwardDelta));
    } else if (isClaw && e.attackState === 'recovery') {
      e.clawDistanceBonusZ = (e.clawDistanceBonusZ || 0) - forwardDelta;
    } else if (!isClaw) {
      const zMin = approachZMinForRoid();
      e.z = Math.max(zMin, Math.min(ENEMY_Z_MAX, e.z - forwardDelta));
    }
  }
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

// 10TH ROUND (item 56): DEBUG-only — which BARREL CLUSTER is currently
// providing cover, if any. Deliberately a read-only re-scan of the exact
// same barrels/radius isPlayerInCover() already uses (never a second
// judgment source); clusterIndex is derived from the array position only
// (BARREL_CLUSTER_OFFSETS emits exactly 3 entries per anchor point, see
// the barrels[] build loop), so this can never disagree with the real
// COVER judgment above.
function r10DebugCoverClusterId() {
  const playerScreenX = state.centerX + state.player.strafeOffset;
  for (let i = 0; i < barrels.length; i++) {
    const b = barrels[i];
    if (b.z > BARREL_TOUCH_Z_MAX) continue;
    const proj = project(b.lane, CORRIDOR_FLOOR_Y, b.z);
    const radius = BARREL_TOUCH_RADIUS_PX * proj.scale + COVER_TOUCH_SLOP_PX;
    if (Math.abs(proj.x - playerScreenX) < radius) {
      return { barrelIndex: i, clusterId: Math.floor(i / BARREL_CLUSTER_OFFSETS.length) };
    }
  }
  return { barrelIndex: -1, clusterId: -1 };
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
  // 12TH ROUND (items 36-40): this diff-driven laneTarget/lane pair was
  // ALREADY real PLAYER-X-axis tracking for every enemy type (this function
  // runs unconditionally for all 6 in updateEnemy()) — what was missing was
  // per-type SPEED differentiation. ENEMY_LANE_TRACK_MULT below is the only
  // change: DRONE/ADAM SPHERE track fast, ROID1/ROID2 stay at the original
  // baseline rate, GABRIEL/ADAM (heavy melee) track slow.
  const trackMult = ENEMY_LANE_TRACK_MULT[e.type] || 1;
  e.lane += (e.laneTarget - e.lane) * Math.min(1, dt * 0.8 * trackMult);
}

function resolveSniperImpact(now) {
  const e = state.enemy;
  const p = state.player;
  const invincible = now < p.invincibleUntil;
  const blocked = COVER_BLOCKS_ATTACK.sniper && isPlayerInCover();
  // 16TH ROUND (Part A/B): small real BLAST instead of the old flat white
  // circle + single asterisk-ray spark — a SNIPER bolt impact is smaller
  // than a MISSILE/enemy-death explosion, so scale is reduced and no floor
  // shockwave is spawned, but it still reads as a genuine small detonation
  // (core flash + fire blob + traveling sparks), never a bare UI dot.
  spawnBlast(e.fireToX, e.fireToY, now, { scale: 0.42, big: false, shockwave: false });
  if (invincible) {
    // 15TH ROUND (items 10-13): on-screen "AVOIDED" text removed — the
    // judgment itself (no damage while DASH-invincible) is unchanged, just
    // recorded into DEBUG only (r10DebugLog is a silent no-op on a normal
    // URL, see its own comment).
    r10DebugLog('SNIPER: AVOIDED (dash-invincible)');
  } else if (blocked) {
    r10DebugLog('SNIPER: BLOCKED (cover)');
  } else {
    p.hp = Math.max(0, p.hp - SNIPER_DAMAGE);
    // 5TH ROUND PART 12/13: "HIT!" text removed — the blink IS the hit
    // feedback now (see renderPlayer()'s hitFlashUntil branch). Damage
    // application/effects above are unchanged.
    p.hitFlashUntil = now + PLAYER_HIT_FLASH_MS;
  }
}

// 12TH ROUND (items 20-24): world X/Z -> project() -> screen X/Y, recomputed
// every tick while the TARGET AREA is live so the drawn ellipse and the
// actual damage check (resolveMissileImpact(), below) always agree — the
// world coords themselves (e.missileTargetWorldX/Z) never change after the
// 'lockon'->'target' transition locks them, so this is a no-op in practice
// unless centerX/horizonY themselves move (a resize), which is exactly the
// case a screen-space-only cache would get wrong.
// 12TH ROUND (items 20-24): the player's own floor-projected world position,
// using the SAME worldX-solve-from-strafeOffset + depthPos-driven worldZ
// formula the MISSILE lock uses (see the 'lockon'->'target' transition
// above) — so the player's live position and the frozen TARGET AREA are
// always compared in the SAME coordinate space. Using the old fixed
// playerMarkerPos()-style reference here instead would silently desync the
// hit-check from the visible ellipse (the ellipse now floats at a real
// floor-projected Y, not the old constant cssH*0.9), breaking the "what's
// drawn = what damages you" guarantee the TARGET AREA exists to provide.
function currentPlayerFloorScreenPos() {
  const pl = state.player;
  const worldZ = MISSILE_TARGET_BASE_WORLD_Z - pl.depthPos * MISSILE_TARGET_WORLD_Z_RANGE;
  const scaleAtZ = FOCAL / (FOCAL + Math.max(worldZ, 1));
  const worldX = pl.strafeOffset / scaleAtZ;
  return project(worldX, CORRIDOR_FLOOR_Y, worldZ);
}

function refreshMissileTargetScreenPos(e) {
  const proj = project(e.missileTargetWorldX, CORRIDOR_FLOOR_Y, e.missileTargetWorldZ);
  e.missileTargetX = proj.x;
  e.missileTargetY = proj.y;
  e.missileTargetScale = proj.scale;
}

// 12TH ROUND (items 60-75): the falling PROJECTILE's own screen position —
// WORLD X/Z (same locked impact point as the shadow/TARGET AREA) with
// WORLD HEIGHT subtracted from the floor's own worldY (CORRIDOR_FLOOR_Y),
// so a bigger missileHeight pushes the object further UP the screen from
// its shadow, never a raw 2D Y slide. Also returns the shadow's own
// (height-independent) screen position and a perspective-scaled intercept
// hit radius, so updateBullets()/renderEnemyAttack() share one calculation.
// NEXT ROUND PART F (root-cause fix): the body used to project at the SAME
// world Z as its own shadow — only WORLD HEIGHT (a pure vertical axis)
// ever changed, so the "falling object" never actually traveled through
// depth at all. On screen this reads as a thin white line (the shadow-
// connector) dropping straight down onto a fixed point, with no sense of
// "flying in from a distance" — exactly the "縦方向の白線が落ちてくるだけ"
// bug report. Root cause: MISSILE_TARGET_WORLD_Z was only ever used for
// the (correct, unchanged) SHADOW/impact point; the body's own Z was never
// derived from a genuine "launch" point at all. Fixed by interpolating the
// body's own world Z from a distant MISSILE_APPROACH_Z_BONUS offset (at
// launch, height=START_HEIGHT) down to the real target Z (at impact,
// height=0) — same driver (e.missileHeight) as the existing vertical
// fall, so no new timing/state is needed. This makes project()'s own
// existing FOCAL/(FOCAL+z) perspective naturally shrink the body far away
// and grow it as it closes in, while the SHADOW stays fixed at the real,
// unchanged impact world point (still the correct "it will land here"
// tell).
const MISSILE_APPROACH_Z_BONUS = 780;
function getMissileProjectileVisual(e) {
  const heightFrac = clamp(e.missileHeight / MISSILE_PROJECTILE_START_HEIGHT, 0, 1); // 1=just launched (far), 0=impact (at target)
  const bodyWorldZ = e.missileTargetWorldZ + MISSILE_APPROACH_Z_BONUS * heightFrac;
  const shadow = project(e.missileTargetWorldX, CORRIDOR_FLOOR_Y, e.missileTargetWorldZ);
  const body = project(e.missileTargetWorldX, CORRIDOR_FLOOR_Y - e.missileHeight, bodyWorldZ);
  return {
    shadowX: shadow.x, shadowY: shadow.y,
    x: body.x, y: body.y, scale: body.scale,
    hitRadius: MISSILE_PROJECTILE_HIT_RADIUS_PX * body.scale,
  };
}

// 16TH ROUND (Part A-C): the real destructive BLAST — replaces the old
// asterisk-style 'explosionFlash'+'spark'(6 static rays)+'smoke'+'shockwave'
// (outline-only) combo entirely. Investigated /home/user/action-game's own
// spawnExplosionVisual()/drawExplosion() first (per spec item 14) — that
// codebase's phased white-yellow CORE FLASH -> multi-blob orange/red MAIN
// BLAST (radial gradients, never a flat single-color circle) -> individually
// -traveling spark dots/tumbling debris squares/soft smoke puffs (never a
// fixed ray-burst from one point, see that file's own "the fixed symmetry
// is what read as an asterisk" reasoning, mirrored in this project's OWN
// 'ishard' debris — see its comment) is genuinely higher quality than what
// existed here, so its phase timing/gradient-stop shape is ported directly
// (not just "add color to the old shapes" — item 3 explicitly forbids
// that), adapted to this project's own floor-perspective flattening (the
// SAME Y-scale squash 'shockwave' already used) and BLAST_SCATTER driven by
// the existing EXPLOSION CHAIN system (spawnExplosionChainBurst() below)
// rather than action-game's own single-shot model, so DARKOUT-TPS's
// "BOOM -> BA-BA-BA-BA" chained-impact feel (already correct — see
// EXPLOSION_CHAIN_COUNT/WINDOW_MS) is preserved on top of the new visuals.
const BLAST_DURATION_MS = 640; // 0-90 core flash, 50-380 main blast, sparks/debris/smoke decay to ~640
function spawnBlast(x, y, now, opts) {
  const o = opts || {};
  const scale = o.scale || 1;
  const big = !!o.big;
  const sparks = [];
  const nSparks = big ? 13 : 6;
  for (let i = 0; i < nSparks; i++) {
    sparks.push({ angle: Math.random() * Math.PI * 2, speed: (170 + Math.random() * 170) * scale, size: 1.3 + Math.random() * 1.6 });
  }
  const debris = [];
  if (big) {
    const nDebris = 6;
    for (let i = 0; i < nDebris; i++) {
      debris.push({ angle: Math.random() * Math.PI * 2, speed: (70 + Math.random() * 120) * scale, size: (2.6 + Math.random() * 3) * scale, spin: (Math.random() - 0.5) * 11 });
    }
  }
  state.blasts.push({
    active: true, x, y, startAt: now, scale, big,
    shockwave: !!o.shockwave, sparks, debris,
  });
}
function updateBlasts(now) {
  for (let i = state.blasts.length - 1; i >= 0; i--) {
    if (now - state.blasts[i].startAt >= BLAST_DURATION_MS) state.blasts.splice(i, 1);
  }
}
// Floor-perspective flatten — the SAME Y-scale squash the old 'shockwave'
// particle already used (ry = rx*0.4-ish), applied to every disc/gradient
// drawn here so the whole blast reads as sitting on the corridor floor from
// this game's own TPS camera angle, not a sphere floating in open air.
const BLAST_FLATTEN_Y = 0.58;
function renderBlast(b, now) {
  const t = now - b.startAt;
  if (t < 0 || t >= BLAST_DURATION_MS) return;
  const sc = b.scale;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.scale(1, BLAST_FLATTEN_Y);

  // CORE FLASH: brief, sharp, white -> hot-yellow radial gradient — a FACE
  // of light expanding from the impact center, never a symbol/glyph.
  if (t < 95) {
    const ft = t / 95;
    const r = (15 + ft * 62) * sc;
    const alpha = 1 - ft * 0.3;
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, r));
    grad.addColorStop(0, `rgba(255,255,246,${alpha})`);
    grad.addColorStop(0.5, `rgba(255,236,150,${alpha * 0.9})`);
    grad.addColorStop(1, 'rgba(255,196,70,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, 0, Math.max(1, r), 0, Math.PI * 2); ctx.fill();
  }

  // MAIN BLAST: the fireball proper — a main radial blob (white-hot core ->
  // yellow -> orange -> red-orange, fading to transparent) plus several
  // smaller offset blobs at fixed angles (irregular silhouette, never a
  // perfect single circle), reads as fire/heat, not a UI marker.
  if (t > 55 && t < 380) {
    const ft = Math.min(1, (t - 55) / 325);
    const baseR = (20 + ft * (b.big ? 68 : 40)) * sc;
    const alpha = 1 - ft * 0.88;
    const mainGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, baseR));
    mainGrad.addColorStop(0, `rgba(255,232,150,${alpha})`);
    mainGrad.addColorStop(0.35, `rgba(255,150,40,${alpha * 0.9})`);
    mainGrad.addColorStop(0.7, `rgba(220,60,20,${alpha * 0.6})`);
    mainGrad.addColorStop(1, 'rgba(150,25,10,0)');
    ctx.fillStyle = mainGrad;
    ctx.beginPath(); ctx.arc(0, 0, Math.max(1, baseR), 0, Math.PI * 2); ctx.fill();
    const nBlobs = b.big ? 5 : 3;
    for (let i = 0; i < nBlobs; i++) {
      const a = (i / nBlobs) * Math.PI * 2 + 0.35;
      const dist = baseR * 0.42;
      const bx = Math.cos(a) * dist, by = Math.sin(a) * dist;
      const br = Math.max(1, baseR * 0.5);
      const grad2 = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      grad2.addColorStop(0, `rgba(255,170,80,${alpha * 0.8})`);
      grad2.addColorStop(1, 'rgba(190,55,18,0)');
      ctx.fillStyle = grad2;
      ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
    }
  }

  // SHOCKWAVE: a filled, fading pressure-ring along the floor — a soft
  // annulus (gradient, not a bare stroke outline) so it reads as a wave of
  // force rather than a UI target ring.
  if (b.shockwave && t < 300) {
    const ft = t / 300;
    const r = (30 + ft * 130) * sc;
    const alpha = (1 - ft) * 0.55;
    const ringGrad = ctx.createRadialGradient(0, 0, Math.max(1, r * 0.72), 0, 0, Math.max(2, r));
    ringGrad.addColorStop(0, 'rgba(255,170,90,0)');
    ringGrad.addColorStop(0.75, `rgba(255,160,70,${alpha})`);
    ringGrad.addColorStop(1, 'rgba(255,140,50,0)');
    ctx.fillStyle = ringGrad;
    ctx.beginPath(); ctx.arc(0, 0, Math.max(2, r), 0, Math.PI * 2); ctx.fill();
  }

  // SPARKS/DEBRIS: each individually travels along its own baked angle/
  // speed from spawn — never redrawn as fixed rays from one static point.
  const tSec = t / 1000;
  for (const s of b.sparks) {
    if (t > 260) continue;
    const dx = Math.cos(s.angle) * s.speed * tSec;
    const dy = Math.sin(s.angle) * s.speed * tSec;
    const alpha = Math.max(0, 1 - t / 260);
    // 16TH ROUND (Part C, legibility pass): a short trailing streak back
    // toward the blast center (same "moving spark reads as moving" idea as
    // the fixed particles.js 'spark' case) makes each ember read as a real
    // traveling point rather than a nearly-invisible 1-2px static dot once
    // scaled down to real device resolution — confirmed too subtle via a
    // zoomed screenshot crop before this change.
    const trailX = dx - Math.cos(s.angle) * 7;
    const trailY = dy - Math.sin(s.angle) * 7;
    ctx.strokeStyle = `rgba(255,220,150,${alpha * 0.8})`;
    ctx.lineWidth = Math.max(1, s.size * 0.8);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(trailX, trailY); ctx.lineTo(dx, dy); ctx.stroke();
    ctx.fillStyle = `rgba(255,240,200,${alpha})`;
    ctx.beginPath(); ctx.arc(dx, dy, s.size, 0, Math.PI * 2); ctx.fill();
  }
  for (const d of b.debris) {
    if (t < 35 || t > 470) continue;
    const lt = (t - 35) / 435;
    const alpha = Math.max(0, 1 - lt);
    const dx = Math.cos(d.angle) * d.speed * tSec;
    const dy = Math.sin(d.angle) * d.speed * tSec;
    ctx.save();
    ctx.translate(dx, dy);
    ctx.rotate(d.spin * lt);
    // 16TH ROUND (Part C, legibility pass): a warm charred-ember tint (was
    // flat rgba(85,85,90,...) — nearly indistinguishable from the dark
    // background/floor) so debris reads as glowing fragments thrown from
    // the blast, not invisible flecks.
    ctx.fillStyle = `rgba(120,70,45,${alpha})`;
    ctx.fillRect(-d.size / 2, -d.size / 2, d.size, d.size);
    ctx.fillStyle = `rgba(255,160,90,${alpha * 0.7})`;
    ctx.fillRect(-d.size / 2, -d.size / 2, d.size * 0.5, d.size * 0.5);
    ctx.restore();
  }

  // SMOKE: dark, soft, drifts/grows and fades in late — the visual tail
  // the blast dissolves into, lingering longest of anything here.
  if (t > 140) {
    const lt = Math.min(1, (t - 140) / 500);
    const alpha = (1 - lt) * 0.4;
    const r = (18 + lt * 24) * sc;
    ctx.fillStyle = `rgba(55,55,58,${alpha})`;
    ctx.beginPath(); ctx.arc(0, -lt * 14, Math.max(1, r), 0, Math.PI * 2); ctx.fill();
  }

  ctx.restore();
}
function renderBlasts() {
  const now = performance.now();
  for (const b of state.blasts) renderBlast(b, now);
}

// 14TH ROUND (items 5-8): spawns ONE scattered burst of the chain — a small
// offset from the true impact point (upper-left/right/center/lower-right
// etc., per spec: "決して1点から同じ形で", "本当の着弾点から大きく離れない"),
// Y-flattened for floor perspective (mirrors ACTION-GAME's own radius*0.6
// pattern). burstIndex 0 is always dead-center (the instant, legible "着弾
// した" read); later indices scatter. 16TH ROUND: now spawns a real
// spawnBlast() instead of the old flat-circle/asterisk/outline-ring combo —
// see spawnBlast()'s own comment.
function spawnExplosionChainBurst(e, now, burstIndex) {
  const sc = e.explosionChainScale || 1;
  let ox = 0, oy = 0;
  if (burstIndex > 0) {
    const ang = Math.random() * Math.PI * 2;
    const r = (0.35 + Math.random() * 0.65) * EXPLOSION_CHAIN_SCATTER_PX * sc;
    ox = Math.cos(ang) * r;
    oy = Math.sin(ang) * r * 0.55; // flattened to read as sitting on the floor
  }
  const x = e.explosionChainX + ox;
  const y = e.explosionChainY + oy;
  const big = burstIndex === 0;
  spawnBlast(x, y, now, { scale: (big ? 1 : 0.6) * sc, big, shockwave: big });
}

// 14TH ROUND (items 5-8): the per-frame driver that spreads the remaining
// EXPLOSION_CHAIN_COUNT-1 scattered bursts across EXPLOSION_CHAIN_WINDOW_MS
// of REAL time — resolveMissileImpact() only fires burst 0 synchronously
// (attackState's own 'impact'/'cooldown' window is far shorter than ~900ms),
// so this must be ticked every frame independent of attackState, from
// frame() directly, exactly like updateParticles(). Called for every enemy
// type (only ever does anything while e.explosionChainActive is true, which
// only 'missile'-kind impacts ever set).
function updateExplosionChain(now) {
  const e = state.enemy;
  if (!e.explosionChainActive) return;
  const elapsed = now - e.explosionChainStartAt;
  const targetCount = Math.min(EXPLOSION_CHAIN_COUNT, Math.floor((elapsed / EXPLOSION_CHAIN_WINDOW_MS) * EXPLOSION_CHAIN_COUNT) + 1);
  while (e.explosionChainSpawned < targetCount) {
    spawnExplosionChainBurst(e, now, e.explosionChainSpawned);
    e.explosionChainSpawned++;
  }
  if (elapsed >= EXPLOSION_CHAIN_WINDOW_MS) {
    e.explosionChainActive = false;
  }
}

function resolveMissileImpact(now) {
  const e = state.enemy;
  const p = state.player;
  const invincible = now < p.invincibleUntil;
  const playerFloorPos = currentPlayerFloorScreenPos();
  const playerScreenX = playerFloorPos.x;
  const playerScreenY = playerFloorPos.y;
  const dist = Math.hypot(playerScreenX - e.missileTargetX, playerScreenY - e.missileTargetY);
  // PART 9: cover does NOT block missile splash — only actually having
  // moved out of the (frozen, visible-in-advance) target ellipse does.
  const inSplash = dist < 62;

  // 14TH ROUND (items 5-8): start the compressed chain-explosion — freeze
  // the center at the real impact point NOW (never re-derived later, so it
  // can never drift/track anything), fire the first (biggest, centered)
  // burst immediately for an instant "着弾した" read, then let
  // updateExplosionChain() spread EXPLOSION_CHAIN_COUNT-1 more scattered
  // bursts across the following ~900ms.
  e.explosionChainX = e.missileTargetX;
  e.explosionChainY = e.missileTargetY;
  e.explosionChainScale = e.missileTargetScale || 1;
  e.explosionChainActive = true;
  e.explosionChainStartAt = now;
  e.explosionChainSpawned = 0;
  spawnExplosionChainBurst(e, now, 0);
  e.explosionChainSpawned = 1;

  if (invincible) {
    // 15TH ROUND (items 10-13): on-screen "AVOIDED"/"DODGED" text removed —
    // the judgment itself (invincible / moved out of the target ellipse) is
    // unchanged, just recorded into DEBUG only.
    r10DebugLog('MISSILE: AVOIDED (dash-invincible)');
  } else if (!inSplash) {
    r10DebugLog('MISSILE: DODGED (out of splash)');
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
  if (e.type === 'roid1' || e.type === 'roid2') {
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
  } else if (e.type === 'adamSphere') {
    // 7TH ROUND PART 7: unlike ROID1/ROID2 (which only ping-pong their
    // FIRE frames while actively firing), ADAM SPHERE cycles continuously
    // for as long as it's alive — this whole branch is new; ADAM SPHERE
    // previously never reached this function's ping-pong logic at all
    // (the old `if (e.type !== 'roid1' && e.type !== 'roid2') return;`
    // guard exited before ever touching its frame index), which is why it
    // rendered as a static, non-rotating sphere before this round.
    e.roidFireFrameElapsedMs += dt * 1000;
    if (e.roidFireFrameElapsedMs >= ADAM_SPHERE_ROTATE_FRAME_MS) {
      e.roidFireFrameElapsedMs = 0;
      const step = stepPingPong(e.roidFireFrame, e.roidFireDir, ASSETS.adamSphere.fire.length);
      e.roidFireFrame = step.index;
      e.roidFireDir = step.dir;
    }
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
  // 9TH ROUND (item 25/27-28): GABRIEL/ADAM used to spawn at the same
  // generic z=900 as ROID1/ROID2/ADAM SPHERE — since e.z<900 gates their own
  // idle->attack roll (see updateEnemy()), a static spawn AT 900 meant they
  // could never even begin an attack cycle without the player first walking
  // forward, and read as "tiny and far away" at battle start.
  // 10TH ROUND (item 20): spawn at STALK_Z (not NORMAL_Z_MIN directly) —
  // still much closer than the old 900, but leaves real room for the new
  // idle-state autonomous approach (see updateEnemy()) to visibly close the
  // distance down to NORMAL_Z_MIN instead of starting already pinned there.
  e.z = type === 'gabriel' ? GABRIEL_STALK_Z : (type === 'adam' ? ADAM_STALK_Z : 900);
  e.lane = 0;
  e.laneTarget = 0;
  e.facing = 'east';
  e.zone = 'center';
  e.lastTurnAt = -Infinity;
  e.attackState = 'idle';
  e.attackUntil = 0;
  e.nextIdleCheckAt = 0;
  e.kind = (type === 'gabriel' || type === 'adam') ? 'claw' : 'sniper';
  // 10TH ROUND (item 40): per-type max HP — ROID1/ROID2 get ROID_MAX_HP
  // (600), every other type keeps the shared ENEMY_MAX_HP (300).
  const spawnMaxHp = (type === 'roid1' || type === 'roid2') ? ROID_MAX_HP : ENEMY_MAX_HP;
  e.hp = spawnMaxHp;
  e.maxHp = spawnMaxHp;
  // 10TH ROUND (items 41-48): ROID1/ROID2 counter-phase state — reset fresh
  // on every spawn so a new instance never inherits a previous one's
  // already-triggered thresholds or a stuck invulnerable flag. Harmless,
  // unused fields for every other enemy type.
  e.triggeredThresholds = [];
  e.invulnerable = false;
  e.counterPhaseUntil = 0;
  e.hitFlashUntil = 0;
  e.roidFireFrame = 0;
  e.roidFireDir = 1;
  e.roidFireFrameElapsedMs = 0;
  e.adamAttackVariantIndex = 0; // 7TH ROUND PART 21 — re-rolled each time a new ADAM attack begins, see updateEnemy()
  e.lastShotFiredAt = -Infinity;
  e.lockX = 0; e.lockY = 0;
  e.fireFromX = 0; e.fireFromY = 0; e.fireToX = 0; e.fireToY = 0;
  e.missileTargetX = 0; e.missileTargetY = 0;
  // 12TH ROUND (items 20-24): world-space impact point (WORLD X / WORLD
  // DEPTH(Z)) the TARGET AREA is projected from every frame — see
  // updateEnemy()'s 'lockon'->'target' transition and renderEnemyAttack()'s
  // 'target' branch. missileTargetX/Y above stay as the derived SCREEN
  // coords (kept for resolveMissileImpact()'s existing distance check and
  // the particle effects, which are unchanged).
  e.missileTargetWorldX = 0; e.missileTargetWorldZ = 0; e.missileTargetScale = 1;
  // 12TH ROUND (items 60-75): interceptable PROJECTILE — a real falling
  // object with its own WORLD HEIGHT above the (same, locked) impact X/Z,
  // never a 2D screen-Y slide. missileHeight ramps MISSILE_PROJECTILE_
  // START_HEIGHT -> 0 across the SAME MISSILE_TARGET_MS window the TARGET
  // AREA already uses (see updateEnemy()'s 'target' tick) — reaching 0
  // exactly when the existing 'target'->'impact' transition fires, so the
  // projectile visually merges into its own shadow right as the normal
  // impact resolves. missileDestroyed is set only by a real midair
  // interception (see updateBullets()) and short-circuits the normal
  // 'target'->'impact' transition into a no-damage, no-floor-impact
  // 'cooldown' instead.
  e.missileHeight = 0; e.missileDestroyed = false;
  // 16TH ROUND PART S: SWEEP FIRE + MULTI MISSILE BARRAGE state — fresh on
  // every spawn, harmless/unused for non-roid1/roid2 types.
  e.sweepDirPending = 1;
  e.sweepStartWorldX = 0; e.sweepEndWorldX = 0; e.sweepWorldZ = 0;
  e.sweepCount = 0; e.sweepIndex = 0; e.sweepNextFireAt = 0; e.sweepEnhanced = false;
  e.sweepTracers = [];
  e.barrage = [];
  e.forcedBarrageCount = 0;
  e.clawApproachStartZ = 0;
  e.clawDistanceBonusZ = 0; // NEXT-ROUND PART C — see applyForwardDelta()/updateEnemy()'s 'recovery' block
  e.deathState = 'alive';
  e.deathStartedAt = 0;
  e.deathUntil = 0;
  // 14TH ROUND (items 5-8): chain-explosion state — see updateExplosionChain()
  e.explosionChainActive = false;
  e.explosionChainStartAt = 0;
  e.explosionChainSpawned = 0;
  e.explosionChainX = 0;
  e.explosionChainY = 0;
  e.explosionChainScale = 1;
  // 14TH ROUND (items 22-43): GABRIEL/ADAM DEFENSE/re-aim/COUNTER state —
  // see updateBullets()/updateEnemy()'s 'claw' branch. Field names per the
  // spec's own suggestion (item 29). No-ops for every non-claw type (never
  // read outside the isClawBoss-guarded branches).
  e.hitInCurrentDefenseCycle = 0;
  e.defenseHitsTotal = 0;
  e.damageAimArmed = true; // armed from a fresh spawn — the very first hit always counts
  e.lastDamageAimX = null;
  e.aimMovedAwaySinceHit = false;
  e.lastDamageHitAt = 0;
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
    // 16TH ROUND (Part A/B, item 14): DRONE/ROID1/ROID2/ADAM SPHERE defeat
    // now reuses the SAME chained-BLAST system (spawnExplosionChainBurst()/
    // updateExplosionChain(), see their own comments) resolveMissileImpact()
    // drives, rather than the old flat white circle + asterisk-ray + plain
    // grey circle combo — a genuine "BOOM -> BA-BA-BA-BA" defeat explosion,
    // scaled up a bit (1.3x) so a boss defeat still reads bigger/more final
    // than a mid-fight MISSILE impact.
    e.explosionChainX = rect.cx;
    e.explosionChainY = rect.cy;
    e.explosionChainScale = 1.3;
    e.explosionChainActive = true;
    e.explosionChainStartAt = now;
    e.explosionChainSpawned = 0;
    spawnExplosionChainBurst(e, now, 0);
    e.explosionChainSpawned = 1;
  } else {
    // PART 26: GABRIEL/ADAM — NOT the same explosion. A scatter of REAL
    // traveling embers (spawnSparkEmber() — see its own comment for why
    // this is no longer a fixed ray-burst) across the body, paired with
    // renderEnemy()'s own bottom-up dissolve/tint for the sustained
    // "burning down" read over DEATH_BURN_MS.
    for (let i = 0; i < 7; i++) {
      spawnSparkEmber(
        rect.cx + (Math.random() - 0.5) * rect.w * 0.6, rect.y + rect.h * (0.3 + Math.random() * 0.5),
        now, 260 + Math.random() * 320,
      );
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
      // 9TH ROUND (item 30-35): COMBAT MODE's clear condition (item 38) is
      // BOSS HP=0 — trigger the shared CLEAR SEQUENCE here, but only for
      // real play (not AUTO MODE's own continuous QA rotation loop, which
      // must keep cycling enemies uninterrupted for testing, per its own
      // existing PART 12 design — see advanceEnemyRotation() below).
      if (state.gameMode === 'combat' && !state.autoMode.active) {
        triggerClearSequence(now, 'combat');
      }
      advanceEnemyRotation(now);
    }
    return;
  }

  updateEnemyFacing(dt, now);
  updateRoidAnimation(dt, now);

  // 10TH ROUND (items 45/47): ends the counter-phase invulnerability window
  // on its own fixed timer (ROID_COUNTER_PHASE_MS) — independent of
  // whatever attackState the existing sniper/missile machinery happens to
  // be in when the window closes, so it can never get stuck open.
  if (e.invulnerable && now >= e.counterPhaseUntil) {
    e.invulnerable = false;
    if (DEBUG_MODE) r10DebugLog('COUNTER PHASE END (' + (ENEMY_LABEL[e.type] || e.type) + ')');
  }

  if (e.attackState === 'idle') {
    // 9TH ROUND (item 30): advance GABRIEL's south-walk-loop frame timer
    // whenever NORMAL/STALKING (idle) — mirrors the player's own
    // walkFrame/p.walkTimer cadence pattern. Must live HERE, not further
    // down in the e.kind==='claw' block below: this 'idle' branch always
    // returns before reaching that block, so a walk-frame advance placed
    // there would be permanently dead code (caught via Playwright — the
    // frame index never moved off 0 until this fix). No-op for ADAM (no
    // walk asset; see the body-bob comment in renderEnemy()) but harmless.
    if (e.type === 'gabriel' || e.type === 'adam') {
      e.clawWalkElapsedMs += dt * 1000;
      if (e.clawWalkElapsedMs > 160) {
        e.clawWalkElapsedMs = 0;
        e.clawWalkFrame = (e.clawWalkFrame + 1) % 3;
      }
      // 10TH ROUND (items 19-21): autonomous idle-state approach —
      // previously ONLY the player's own forward movement (via
      // applyForwardDelta()) ever changed e.z during idle; standing still
      // meant GABRIEL/ADAM's walk-loop animation played with zero actual
      // motion ("足踏み" — marching in place, confirmed via real-device
      // report). This closes the STALK_Z -> NORMAL_Z_MIN gap on its own at
      // CLAW_STALK_SPEED, entirely independent of player input, and never
      // goes below NORMAL_Z_MIN (the same hard floor applyForwardDelta()'s
      // own idle-only gate already enforces) — ATTACK's own 'approach'
      // sub-state is still the only thing that ever closes past that floor.
      const stalkFloor = e.type === 'gabriel' ? GABRIEL_NORMAL_Z_MIN : ADAM_NORMAL_Z_MIN;
      // NEXT ROUND PART B: ADAM's own normal approach speed doubled (spec
      // item 5 — ADAM only, GABRIEL unchanged) — still the SAME continuous
      // FAR->MID->NEAR closing-the-gap tween, just faster, never a jump.
      const stalkSpeed = e.type === 'adam' ? CLAW_STALK_SPEED * 2 : CLAW_STALK_SPEED;
      if (e.z > stalkFloor) {
        e.z = Math.max(stalkFloor, e.z - stalkSpeed * dt);
      }
    } else if (state.gameMode === 'combat') {
      // 14TH ROUND (items 9-11): see ENEMY_IDLE_APPROACH_SPEED above — the
      // same autonomous-creep fix as GABRIEL/ADAM got in the 10TH ROUND,
      // applied to DRONE/ROID1/ROID2/ADAM SPHERE. COMBAT-mode only: ESCAPE
      // already owns e.z for these types via updateEscapeEnemyPursuit().
      const zMin = approachZMinForRoid();
      if (e.z > zMin) {
        e.z = Math.max(zMin, e.z - ENEMY_IDLE_APPROACH_SPEED * dt);
      }
    }
    if (!e.nextIdleCheckAt) e.nextIdleCheckAt = now + 1500 * enemyAttackFreqMult(e.type);
    if (now >= e.nextIdleCheckAt && e.z < 900) {
      const stealthMul = p.stealth ? 1.8 : 1.0;
      if (e.type === 'gabriel' || e.type === 'adam') {
        e.kind = 'claw';
        e.attackState = 'blink';
        e.attackUntil = now + CLAW_BLINK_MS * stealthMul;
        // 7TH ROUND PART 21: rolled ONCE per attack instance, right here at
        // the moment a new attack begins — held unchanged through blink/
        // approach/telegraph/impact (nothing else writes this field until
        // the NEXT idle->blink transition), so "その攻撃中は選択した画像
        // を使用" holds for the whole sequence, not just the render frame
        // it happened to be picked on.
        if (e.type === 'adam') e.adamAttackVariantIndex = Math.random() < 0.5 ? 0 : 1;
      } else if (e.type === 'roid1' || e.type === 'roid2') {
        // 16TH ROUND PART S: replaces the old plain missile/sniper 45/55
        // pool for ROID1/ROID2 ONLY (drone/adamSphere keep the untouched
        // pool below) — SWEEP FIRE and MULTI MISSILE BARRAGE together make
        // up the majority of rolls (spec: these become the "主力attack
        // pattern"), SNIPER's quick single precision shot stays in the pool
        // for unpredictability rather than being removed outright.
        const roll = Math.random();
        e.sweepTracers = []; e.barrage = []; // clear any stale visuals from a previous attack instance
        if (roll < 0.32) {
          e.kind = 'sniper';
          e.attackState = 'lock_red';
          e.attackUntil = now + SNIPER_LOCK_RED_MS * stealthMul;
        } else if (roll < 0.64) {
          startSweepAttack(e, now, false, stealthMul);
        } else {
          startBarrageAttack(e, now, 0, stealthMul);
        }
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
          // 15TH ROUND (items 10-13): on-screen "AVOIDED"/"MISS" text
          // removed — the hit-test/judgment above is unchanged, just
          // recorded into DEBUG only.
          r10DebugLog('CLAW: ' + (dashInvincible ? 'AVOIDED (dash-invincible)' : 'MISS (out of range)'));
        }
      }
    } else if (e.attackState === 'impact') {
      if (now >= e.attackUntil) {
        // 9TH ROUND (item 21-26): ease back out to the type's own NORMAL
        // floor instead of jumping straight to 'cooldown' at the close
        // CLAW_Z_MIN — this is the new state that actually returns
        // GABRIEL/ADAM to their mid "stalking" distance after an attack,
        // rather than leaving them parked at melee range forever.
        e.attackState = 'recovery';
        e.attackUntil = now + CLAW_RECOVERY_MS;
        e.clawApproachStartZ = e.z;
        // NEXT-ROUND PART C (root-cause fix): zeroed fresh for this
        // recovery window — see applyForwardDelta()'s own comment for why
        // this accumulator exists (the fix for "PLAYER SOUTH DASH does
        // nothing right after a GABRIEL/ADAM melee attack").
        e.clawDistanceBonusZ = 0;
      }
    } else if (e.attackState === 'recovery') {
      // 10TH ROUND (items 19-24): eases back out to STALK_Z (not straight to
      // NORMAL_Z_MIN) — "back off after the attack, then resume walking
      // closer" per this round's explicit approach/attack/recovery/re-
      // approach loop, rather than snapping straight back to the closest
      // normal-state distance with nothing left to visibly walk through.
      // NEXT-ROUND PART C (root-cause fix): the recovery TARGET itself is
      // now offset by e.clawDistanceBonusZ, which applyForwardDelta()
      // accumulates every frame from the PLAYER's own forward/back movement
      // while this state is active (see its own comment) — root cause of
      // "SOUTH DASH does nothing after an attack" was that this whole
      // window used to ignore player movement entirely (its own tween
      // unconditionally overwrote e.z every frame with no player input
      // factored in at all). Clamped to ENEMY_Z_MAX so a huge bonus can't
      // push the target past the world's own far bound.
      const baseTargetZ = e.type === 'gabriel' ? GABRIEL_STALK_Z : ADAM_STALK_Z;
      const targetZ = clamp(baseTargetZ + e.clawDistanceBonusZ, 0, ENEMY_Z_MAX);
      const tNorm = clamp(1 - (e.attackUntil - now) / CLAW_RECOVERY_MS, 0, 1);
      const eased = 1 - Math.pow(1 - tNorm, 2);
      e.z = e.clawApproachStartZ + (targetZ - e.clawApproachStartZ) * eased;
      if (now >= e.attackUntil) {
        e.z = targetZ;
        e.attackState = 'cooldown';
        e.attackUntil = now + CLAW_COOLDOWN_MS;
      }
    } else if (e.attackState === 'cooldown') {
      if (now >= e.attackUntil) { e.attackState = 'idle'; e.nextIdleCheckAt = now + (900 + Math.random() * 1400) * enemyAttackFreqMult(e.type); }
    } else if (e.attackState === 'defense') {
      // 14TH ROUND (items 22-39): triggered directly from updateBullets() the
      // instant hitInCurrentDefenseCycle reaches GABRIEL_ADAM_DEFENSE_HIT_CYCLE
      // — DAMAGE=0 unconditionally while here (see updateBullets()'s own
      // isClawBoss gate). Bounded, non-permanent (item 36): always exits back
      // to normal battle after GABRIEL_ADAM_DEFENSE_MS, UNLESS the 5-hit total
      // was already reached, in which case it skips straight to the forced
      // COUNTER instead of resuming normal battle.
      if (now >= e.attackUntil) {
        if (e.defenseHitsTotal >= GABRIEL_ADAM_COUNTER_TOTAL_HITS) {
          e.attackState = 'counterApproach';
          e.attackUntil = now + GABRIEL_ADAM_COUNTER_APPROACH_MS;
          e.clawApproachStartZ = e.z;
          e.invulnerable = true; // item 31: INVULNERABLE through the approach+attack, cleared the instant the attack resolves (item 37)
        } else {
          e.attackState = 'cooldown';
          e.attackUntil = now + CLAW_COOLDOWN_MS;
        }
      }
    } else if (e.attackState === 'counterApproach') {
      // item 38: a visibly fast lunge toward the player, never an instant
      // teleport — same eased-tween shape the normal 'approach' sub-state
      // above already uses, just over its own (shorter) duration.
      const zMin = e.type === 'gabriel' ? GABRIEL_Z_MIN : ADAM_Z_MIN;
      const tNorm = clamp(1 - (e.attackUntil - now) / GABRIEL_ADAM_COUNTER_APPROACH_MS, 0, 1);
      const eased = 1 - Math.pow(1 - tNorm, 2);
      e.z = e.clawApproachStartZ + (zMin - e.clawApproachStartZ) * eased;
      if (now >= e.attackUntil) {
        e.z = zMin;
        e.attackState = 'counterAttack';
        e.attackUntil = now + CLAW_WINDUP_MS; // reuses the SAME windup reaction-window duration/warning-ring the normal attack already uses
      }
    } else if (e.attackState === 'counterAttack') {
      // Close-range attack (item 32/33): GABRIEL reuses its existing CLAW hit-
      // test/impact resolution EXACTLY (same CLAW_HIT_RANGE_PX/DASH-avoidance
      // rule, same CLAW_DAMAGE) rather than a second, parallel attack system
      // — ADAM shares the identical code path (it already reuses GABRIEL's
      // CLAW machinery everywhere else in this file).
      if (now >= e.attackUntil) {
        const rect = computeEnemyDrawRect();
        const playerScreenX = state.centerX + p.strafeOffset;
        const lateralDist = Math.abs(playerScreenX - rect.cx);
        const outOfRange = lateralDist > CLAW_HIT_RANGE_PX;
        const dashInvincible = now < p.invincibleUntil;
        if (!outOfRange && !dashInvincible) {
          p.hp = Math.max(0, p.hp - CLAW_DAMAGE);
          p.hitFlashUntil = now + PLAYER_HIT_FLASH_MS;
        } else {
          // 15TH ROUND (items 10-13): on-screen text removed, DEBUG-only.
          r10DebugLog('CLAW COUNTER: ' + (dashInvincible ? 'AVOIDED (dash-invincible)' : 'MISS (out of range)'));
        }
        // item 37: invulnerability ends the instant the attack itself
        // resolves — never lingers through the recovery tail below.
        e.invulnerable = false;
        e.defenseHitsTotal = 0;
        e.hitInCurrentDefenseCycle = 0;
        e.attackState = 'recovery'; // reuses the existing recovery->cooldown->idle tail unchanged
        e.attackUntil = now + CLAW_RECOVERY_MS;
        e.clawApproachStartZ = e.z;
      }
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
      if (now >= e.attackUntil) { e.attackState = 'idle'; e.nextIdleCheckAt = now + (700 + Math.random() * 1200) * enemyAttackFreqMult(e.type); }
    }
    return;
  }

  // --- MISSILE (PART 7): lockon -> target -> impact -> cooldown ---
  if (e.kind === 'missile') {
    if (e.attackState === 'lockon') {
      if (now >= e.attackUntil) {
        // 12TH ROUND (items 20-24): TARGET AREA begins — freeze the impact
        // point's WORLD X/Z now (never re-tracks the player afterward), so
        // the player can dodge by moving away from THIS fixed world spot.
        // worldX is solved so project(worldX, ..., worldZ).x lands exactly
        // on the player's current screen X (the same targeting instant the
        // old screen-space version used), worldZ comes from the player's
        // own current depthPos via the shared perspective range.
        const pl = state.player;
        const worldZ = MISSILE_TARGET_BASE_WORLD_Z - pl.depthPos * MISSILE_TARGET_WORLD_Z_RANGE;
        const scaleAtZ = FOCAL / (FOCAL + Math.max(worldZ, 1));
        e.missileTargetWorldX = pl.strafeOffset / scaleAtZ;
        e.missileTargetWorldZ = worldZ;
        refreshMissileTargetScreenPos(e);
        // 12TH ROUND (items 60-75): arm the falling PROJECTILE fresh for
        // this attack — see updateBullets() for the midair intercept and
        // the height-driven tick below.
        e.missileHeight = MISSILE_PROJECTILE_START_HEIGHT;
        e.missileDestroyed = false;
        e.attackState = 'target';
        e.attackUntil = now + MISSILE_TARGET_MS;
      }
    } else if (e.attackState === 'target') {
      refreshMissileTargetScreenPos(e);
      // PROJECTILE HEIGHT ramps down across the SAME window as the TARGET
      // AREA's own progress curve, reaching 0 exactly as this branch's own
      // now>=attackUntil fires below — the falling object visually merges
      // into its floor shadow right as impact resolves.
      const fallProgress = clamp(1 - (e.attackUntil - now) / MISSILE_TARGET_MS, 0, 1);
      e.missileHeight = MISSILE_PROJECTILE_START_HEIGHT * (1 - fallProgress);
      if (now >= e.attackUntil) {
        e.attackState = 'impact';
        e.attackUntil = now + MISSILE_IMPACT_MS;
        resolveMissileImpact(now);
      }
    } else if (e.attackState === 'impact') {
      if (now >= e.attackUntil) { e.attackState = 'cooldown'; e.attackUntil = now + MISSILE_COOLDOWN_MS; }
    } else if (e.attackState === 'cooldown') {
      if (now >= e.attackUntil) { e.attackState = 'idle'; e.nextIdleCheckAt = now + (900 + Math.random() * 1400) * enemyAttackFreqMult(e.type); }
    }
    return;
  }

  // --- 16TH ROUND PART S: SWEEP FIRE (RIFLE/MINIGUN horizontal burst) ---
  // sweepTelegraph (brief charge, FIRE-pose only) -> sweepFiring (a fast
  // horizontal line of impact points sweeping across the ONE locked WORLD
  // X/Z, RIGHT<->LEFT) -> cooldown. Never re-locks to the player mid-burst
  // (item 127/135) — each individual shot's damage check below still reads
  // the player's LIVE position, so moving/DASHing out of a given shot's own
  // impact radius still avoids that shot, exactly like the old single-
  // missile splash check already worked.
  if (e.kind === 'sweep') {
    if (e.attackState === 'sweepTelegraph') {
      if (now >= e.attackUntil) {
        const pl = state.player;
        const worldZ = MISSILE_TARGET_BASE_WORLD_Z - pl.depthPos * MISSILE_TARGET_WORLD_Z_RANGE;
        const scaleAtZ = FOCAL / (FOCAL + Math.max(worldZ, 1));
        const lockWorldX = pl.strafeOffset / scaleAtZ;
        const half = SWEEP_HALF_WIDTH_WORLD;
        // dir=1 -> starts RIGHT (+X), sweeps to LEFT (-X); dir=-1 -> reverse.
        e.sweepStartWorldX = lockWorldX + (e.sweepDirPending >= 0 ? half : -half);
        e.sweepEndWorldX = lockWorldX + (e.sweepDirPending >= 0 ? -half : half);
        e.sweepWorldZ = worldZ;
        const baseCount = SWEEP_BULLET_COUNT_MIN + Math.floor(Math.random() * (SWEEP_BULLET_COUNT_MAX - SWEEP_BULLET_COUNT_MIN + 1));
        e.sweepCount = e.sweepEnhanced ? baseCount + SWEEP_BULLET_COUNT_ENHANCED_BONUS : baseCount;
        e.sweepIndex = 0;
        e.sweepNextFireAt = now;
        e.attackState = 'sweepFiring';
        e.attackUntil = now + e.sweepCount * SWEEP_BULLET_INTERVAL_MS + 120;
      }
    } else if (e.attackState === 'sweepFiring') {
      if (e.sweepIndex < e.sweepCount && now >= e.sweepNextFireAt) {
        resolveSweepShot(e, now);
        e.sweepIndex++;
        e.sweepNextFireAt = now + SWEEP_BULLET_INTERVAL_MS;
        e.lastShotFiredAt = now; // reuses the existing FIRE-pose hold (isRoidActivelyFiring()) — no new visual
      }
      if (now >= e.attackUntil) {
        e.sweepEnhanced = false;
        e.attackState = 'cooldown';
        e.attackUntil = now + SWEEP_COOLDOWN_MS;
      }
    } else if (e.attackState === 'cooldown') {
      if (now >= e.attackUntil) { e.attackState = 'idle'; e.nextIdleCheckAt = now + (900 + Math.random() * 1400) * enemyAttackFreqMult(e.type); }
    }
    return;
  }

  // --- 16TH ROUND PART S: MULTI MISSILE BARRAGE ---
  // barrageLockon (one LOCK of the player's WORLD X/Z) -> barrageFalling
  // (3-4 missiles, launch staggered, impact points scattered AROUND the
  // single locked point, never re-locked individually) -> cooldown.
  if (e.kind === 'barrage') {
    if (e.attackState === 'barrageLockon') {
      if (now >= e.attackUntil) {
        const pl = state.player;
        const worldZ = MISSILE_TARGET_BASE_WORLD_Z - pl.depthPos * MISSILE_TARGET_WORLD_Z_RANGE;
        const scaleAtZ = FOCAL / (FOCAL + Math.max(worldZ, 1));
        const lockWorldX = pl.strafeOffset / scaleAtZ;
        const count = e.forcedBarrageCount || (3 + (Math.random() < 0.5 ? 0 : 1));
        e.forcedBarrageCount = 0;
        e.barrage = [];
        for (let i = 0; i < count; i++) {
          const pat = BARRAGE_OFFSET_PATTERN[i] || BARRAGE_OFFSET_PATTERN[BARRAGE_OFFSET_PATTERN.length - 1];
          const jx = (Math.random() * 2 - 1) * BARRAGE_OFFSET_JITTER;
          const jz = (Math.random() * 2 - 1) * BARRAGE_OFFSET_JITTER * 0.5;
          const launchAt = now + i * BARRAGE_LAUNCH_INTERVAL_MS;
          e.barrage.push({
            worldX: lockWorldX + pat.dx + jx,
            worldZ: worldZ + pat.dz + jz,
            launchAt,
            impactAt: launchAt + BARRAGE_FALL_MS,
            height: MISSILE_PROJECTILE_START_HEIGHT,
            impacted: false,
          });
        }
        e.attackState = 'barrageFalling';
        const last = e.barrage[e.barrage.length - 1];
        e.attackUntil = last.impactAt + BARRAGE_IMPACT_TAIL_MS;
      }
    } else if (e.attackState === 'barrageFalling') {
      for (const m of e.barrage) {
        if (m.impacted || now < m.launchAt) continue;
        const fallProgress = clamp(1 - (m.impactAt - now) / BARRAGE_FALL_MS, 0, 1);
        m.height = MISSILE_PROJECTILE_START_HEIGHT * (1 - fallProgress);
        if (now >= m.impactAt) {
          m.impacted = true;
          resolveBarrageImpact(m, now);
        }
      }
      if (now >= e.attackUntil) {
        e.attackState = 'cooldown';
        e.attackUntil = now + BARRAGE_COOLDOWN_MS;
      }
    } else if (e.attackState === 'cooldown') {
      if (now >= e.attackUntil) { e.attackState = 'idle'; e.nextIdleCheckAt = now + (900 + Math.random() * 1400) * enemyAttackFreqMult(e.type); }
    }
    return;
  }
}

// 16TH ROUND PART S: rolls (or, if forcedCount>0, forces) a fresh SWEEP FIRE
// attack instance. Shared by the normal idle->attack roll and the ROID
// 80/60/40/20% counter-phase (which forces `enhanced=true` at the 40%
// threshold — see the bullet-hit resolution code in updateBullets()).
function startSweepAttack(e, now, enhanced, stealthMul) {
  e.kind = 'sweep';
  e.sweepDirPending = Math.random() < 0.5 ? 1 : -1;
  e.sweepEnhanced = !!enhanced;
  e.sweepTracers = [];
  e.attackState = 'sweepTelegraph';
  e.attackUntil = now + SWEEP_TELEGRAPH_MS * (stealthMul || 1);
}

// 16TH ROUND PART S: rolls (or, if forcedCount>0, forces) a fresh MULTI
// MISSILE BARRAGE attack instance. forcedCount=3 or 4 is used by the ROID
// counter-phase (60%/20% thresholds); forcedCount=0 lets barrageLockon's
// own transition roll a random 3-or-4 for normal (non-counter) attacks.
function startBarrageAttack(e, now, forcedCount, stealthMul) {
  e.kind = 'barrage';
  e.forcedBarrageCount = forcedCount || 0;
  e.barrage = [];
  e.attackState = 'barrageLockon';
  e.attackUntil = now + BARRAGE_LOCKON_MS * (stealthMul || 1);
}

// 16TH ROUND PART S: resolves ONE sweep bullet — computes its WORLD X (an
// interpolated point along the locked start->end line, index/ (count-1)),
// projects it to screen, spawns a small (non-explosion-scale) impact blast
// + a short tracer for rendering, then checks REAL distance against the
// PLAYER'S CURRENT position (never the original lock point — item 136) so
// a bullet's damage always matches where it visibly lands.
function resolveSweepShot(e, now) {
  const t = e.sweepCount <= 1 ? 0 : e.sweepIndex / (e.sweepCount - 1);
  const worldX = e.sweepStartWorldX + (e.sweepEndWorldX - e.sweepStartWorldX) * t;
  const proj = project(worldX, CORRIDOR_FLOOR_Y, e.sweepWorldZ);
  const gun = screenSpaceEnemyAnchor();
  e.sweepTracers.push({ x1: gun.x, y1: gun.y - 30, x2: proj.x, y2: proj.y, until: now + SWEEP_TRACER_LIFE_MS });
  // small, non-explosion-scale impact — a spark/flash/debris beat, never
  // the full MISSILE-scale blast (item 140).
  spawnBlast(proj.x, proj.y, now, { scale: 0.22 * (proj.scale || 1), big: false, shockwave: false });
  const p = state.player;
  const invincible = now < p.invincibleUntil;
  const playerFloorPos = currentPlayerFloorScreenPos();
  const dist = Math.hypot(playerFloorPos.x - proj.x, playerFloorPos.y - proj.y);
  if (!invincible && dist < SWEEP_HIT_RADIUS_PX) {
    p.hp = Math.max(0, p.hp - SWEEP_DAMAGE);
    p.hitFlashUntil = now + PLAYER_HIT_FLASH_MS;
  }
}

// 16TH ROUND PART S: resolves ONE barrage missile's impact — reuses the
// SAME spawnBlast() pipeline (PART A/B/C) directly as a full-quality single
// blast (never the old asterisk effect — item 153); damage is checked
// against the PLAYER'S CURRENT position vs THIS missile's own locked
// world point (never re-derived to the player's live position — item 147
// requires the player be able to have already moved away by the time this
// specific missile lands).
function resolveBarrageImpact(m, now) {
  const p = state.player;
  const proj = project(m.worldX, CORRIDOR_FLOOR_Y, m.worldZ);
  const invincible = now < p.invincibleUntil;
  const playerFloorPos = currentPlayerFloorScreenPos();
  const dist = Math.hypot(playerFloorPos.x - proj.x, playerFloorPos.y - proj.y);
  const inSplash = dist < 62; // same splash radius the single-MISSILE impact already used
  spawnBlast(proj.x, proj.y, now, { scale: proj.scale || 1, big: true, shockwave: true });
  if (!invincible && inSplash) {
    p.hp = Math.max(0, p.hp - MISSILE_DAMAGE);
    p.hitFlashUntil = now + PLAYER_HIT_FLASH_MS;
  }
}

// 16TH ROUND PART S: per-barrage-missile screen position — same WORLD
// HEIGHT-above-floor-shadow shape as getMissileProjectileVisual(), just
// parametrized over an { worldX, worldZ, height } record instead of
// reading the single-missile fields directly off `e`, so multiple barrage
// missiles can be in flight (and rendered) at once.
// NEXT ROUND PART F: same root-cause fix as getMissileProjectileVisual()
// above, applied to each barrage missile — the body approaches through
// real world depth (not just a vertical height drop at a fixed Z), so it
// visibly grows as it nears its own impact point instead of just falling
// straight down onto it.
function getBarrageProjectileVisual(m) {
  const heightFrac = clamp(m.height / MISSILE_PROJECTILE_START_HEIGHT, 0, 1);
  const bodyWorldZ = m.worldZ + MISSILE_APPROACH_Z_BONUS * heightFrac;
  const shadow = project(m.worldX, CORRIDOR_FLOOR_Y, m.worldZ);
  const body = project(m.worldX, CORRIDOR_FLOOR_Y - m.height, bodyWorldZ);
  return {
    shadowX: shadow.x, shadowY: shadow.y,
    x: body.x, y: body.y, scale: body.scale,
  };
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
    // 7TH ROUND PART 21: ADAM's own telegraph/impact frames swap to the
    // randomly-selected attack-variant image (see updateEnemy()'s
    // idle->blink transition) instead of its usual windup/release art.
    // GABRIEL is untouched — isGabriel short-circuits this before it ever
    // reads e.adamAttackVariantIndex.
    const inAttackPose = e.attackState === 'telegraph' || e.attackState === 'impact';
    // 9TH ROUND (item 30-31): while NORMAL/STALKING (attackState==='idle'),
    // GABRIEL cycles its own real 3-frame walk loop (see updateEnemy()'s
    // clawWalkFrame advance) instead of a single static idle pose. ADAM has
    // no walk-cycle asset (verified this round), so it keeps its single
    // idle image here — its "alive" motion cue is a Canvas-only body-bob
    // applied in renderEnemy() instead, never a fabricated/alternating hack.
    const isWalking = e.attackState === 'idle';
    // 14TH ROUND (items 22-39): DEFENSE/COUNTER pose reuse — no new image
    // assets fabricated ("新しい画像は生成しないでください"). DEFENSE and the
    // COUNTER lunge (counterApproach) both reuse the existing claw-raised
    // windup art (already reads as a guarded/ready stance); the COUNTER's
    // actual strike (counterAttack) reuses the existing swing-connecting
    // release art — the exact same images 'telegraph'/'impact' already use.
    const img = (!isGabriel && inAttackPose)
      ? ASSETS.adam.attackVariants[e.adamAttackVariantIndex]
      : (e.attackState === 'telegraph' || e.attackState === 'defense' || e.attackState === 'counterApproach' ? set.windup
        : (e.attackState === 'impact' || e.attackState === 'counterAttack' ? set.release
        : (isGabriel && isWalking ? ASSETS.gabriel.walk[e.clawWalkFrame] : set.idle)));
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
  // 7TH ROUND PART 6/7: ADAM SPHERE always shows its own continuously-
  // rotating frame (e.roidFireFrame, now advanced every frame by
  // updateRoidAnimation() regardless of firing state — see there) instead
  // of the zone-based search-frame selection ROID1/ROID2 use. Defaulting
  // to index 0 (adam_sphere_01.png, the frame where its "eye" faces the
  // camera/player — i.e. this game's "south") on spawn (spawnEnemy() resets
  // roidFireFrame to 0) satisfies "デフォルト方向を南向きへ" without any
  // new asset or a second, ROID-only-shared facing map.
  const frame = e.type === 'adamSphere'
    ? sprites.fire[e.roidFireFrame]
    : (isRoidActivelyFiring(performance.now()) ? sprites.fire[e.roidFireFrame] : sprites.search[ROID_FACE_FRAME[e.zone] != null ? ROID_FACE_FRAME[e.zone] : 2]);
  const img = frame.img;

  const targetBodyHeightPx = (e.type === 'adamSphere' ? ADAM_SPHERE_WORLD_HEIGHT : e.type === 'drone' ? DRONE_WORLD_HEIGHT : ROID_WORLD_HEIGHT) * proj.scale;
  const ready = imgReady(img);
  const scale = ready ? computeBodyVisualScale(frame, targetBodyHeightPx) : targetBodyHeightPx / 900;
  const nativeW = ready ? img.naturalWidth : 640;
  const nativeH = ready ? img.naturalHeight : 900;
  const w = nativeW * scale;
  const h = nativeH * scale;
  const dx = proj.x - w / 2;
  const dy = proj.y - frame.bodyBottomFrac * h;

  // 11TH ROUND (items 17-19): ROID1/ROID2 HEAD WEAK POINT — only present
  // when the current frame carries real measured head metadata
  // (roidSpriteFrame(), i.e. only roid1/roid2's own 9 frames each); every
  // other enemy type's frame() lacks these fields, so headX stays
  // undefined for them and updateBullets() falls back to the existing
  // generic body hit-test unchanged.
  const hasHead = frame.headCenterXFrac != null;
  return {
    img, proj, x: dx, y: dy, w, h, cx: proj.x,
    cy: dy + h * ((frame.bodyTopFrac + frame.bodyBottomFrac) / 2),
    headX: hasHead ? dx + frame.headCenterXFrac * w : undefined,
    headY: hasHead ? dy + frame.headCenterYFrac * h : undefined,
    headR: hasHead ? frame.headRadiusFrac * Math.max(w, h) : undefined,
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
// 7TH ROUND PART 17: shared by fireWeapon() (muzzle/bullet origin) so the
// effect position always tracks the player's ACTUAL current on-screen
// size (cssH, PLAYER_SCALE_BOOST, p.scale's own north/south depth pulse —
// all real, live values) rather than a fixed formula unrelated to it. Uses
// ASSETS.player.aim as the representative pose purely for its native
// width/height (every player pose shares near-identical proportions), not
// tied to whichever specific image renderPlayer() happens to be drawing
// this frame.
function computePlayerDrawRect() {
  const p = state.player;
  const cx = state.centerX + p.strafeOffset;
  const bottomY = state.cssH * 1.02;
  const baseScale = (state.cssH / 900) * PLAYER_SCALE_BOOST * p.scale;
  const img = ASSETS.player.aim;
  const nativeH = imgReady(img) ? img.naturalHeight : 900;
  const nativeW = imgReady(img) ? img.naturalWidth : 640;
  const h = nativeH * baseScale;
  const w = nativeW * baseScale;
  return { cx, bottomY, topY: bottomY - h, w, h };
}

function fireWeapon(now) {
  const p = state.player;
  // 8TH ROUND: FIRE diagnostics — fireWeapon() is called every frame
  // state.input.fireHeld is true (see frame()'s `if (state.input.fireHeld)
  // fireWeapon(ts);`), so this counts EVERY such call, success or reject,
  // never just the first. Completely inert on a normal URL (DEBUG_MODE
  // false short-circuits every line below before r10DebugState — which is
  // null — is ever touched).
  // 14TH ROUND (items 43-44): fireCallCount/fireRejectCount/fireRejectReason
  // below are running DIAGNOSTIC COUNTERS (read live by the DEBUG panel) and
  // keep updating every single call exactly as before — gameplay/diagnostic
  // behavior is unchanged. Only the r10DebugLog() CALLS (the lines that
  // actually get pushed into the ring-buffer EVENT LOG) are now gated to
  // fire once per REASON TRANSITION via r10DebugState.lastFireLogReason,
  // not once per frame — real-device report: holding FIRE during RELOAD was
  // writing a fresh 'FIRE INPUT'/'FIRE BLOCKED: RELOADING' pair every ~16ms,
  // flooding the 60-entry ring buffer with duplicate noise. The reason is
  // reset to null (so the next distinct press logs 'FIRE INPUT' fresh again)
  // wherever FIRE stops being held — see frame()'s own reset next to the
  // `if (state.input.fireHeld) fireWeapon(ts);` call.
  if (DEBUG_MODE) {
    r10DebugState.fireCallCount++;
    if (r10DebugState.lastFireLogReason === null) {
      r10DebugLog('FIRE INPUT');
      r10DebugState.lastFireLogReason = 'INPUT';
    }
  }
  // 9TH ROUND (item 9): FIRE is now blocked entirely while the player is
  // actively using COVER (checked before the reload/ammo guards below, so
  // a COVER-blocked attempt never consumes ammo or starts a reload either)
  // — reuses the EXISTING isPlayerInCover(), same gate renderPlayer()
  // already uses to pick the crouched sprite, so "COVER sprite showing"
  // and "FIRE disabled" can never disagree.
  if (isPlayerInCover()) {
    if (DEBUG_MODE) {
      r10DebugState.fireRejectCount++;
      r10DebugState.fireRejectReason = 'COVER';
      if (r10DebugState.lastFireLogReason !== 'COVER') {
        r10DebugLog('FIRE BLOCKED: COVER');
        r10DebugState.lastFireLogReason = 'COVER';
      }
    }
    return;
  }
  if (p.reloading || p.ammo <= 0) {
    if (DEBUG_MODE) {
      r10DebugState.fireRejectCount++;
      r10DebugState.fireRejectReason = p.reloading ? 'RELOADING' : 'NO AMMO';
      if (r10DebugState.lastFireLogReason !== r10DebugState.fireRejectReason) {
        r10DebugLog('FIRE BLOCKED: ' + r10DebugState.fireRejectReason);
        r10DebugState.lastFireLogReason = r10DebugState.fireRejectReason;
      }
    }
    return;
  }
  if (now < p.fireCooldownUntil) {
    if (DEBUG_MODE) {
      r10DebugState.fireRejectCount++;
      r10DebugState.fireRejectReason = 'COOLDOWN';
      if (r10DebugState.lastFireLogReason !== 'COOLDOWN') {
        r10DebugLog('FIRE BLOCKED: COOLDOWN (' + Math.ceil(p.fireCooldownUntil - now) + 'ms left)');
        r10DebugState.lastFireLogReason = 'COOLDOWN';
      }
    }
    return;
  }
  if (DEBUG_MODE) r10DebugState.lastFireLogReason = 'FIRED';
  p.fireCooldownUntil = now + FIRE_COOLDOWN_MS;
  p.ammo -= 1;
  p.lastShotAt = now; // 7TH ROUND PART 15 — drives renderPlayer()'s synced fire-pose pulse

  const rect = computePlayerDrawRect();
  const muzzleX = rect.cx;
  const muzzleY = rect.topY + rect.h * MUZZLE_HEIGHT_FRAC;
  const aim = getAimPoint();

  spawnParticle({ type: 'muzzle', x: muzzleX, y: muzzleY, born: now, until: now + 45 });
  const bullet = spawnBullet({ x1: muzzleX, y1: muzzleY, x2: aim.x, y2: aim.y, firedAt: now, resolveAt: now + BULLET_TRAVEL_MS });
  triggerFireHaptics();

  if (DEBUG_MODE) {
    r10DebugState.fireSuccessCount++;
    r10DebugState.lastFireAt = now;
    r10DebugState.nextFireAllowedAt = p.fireCooldownUntil;
    r10DebugState.shotCreatedCount++;
    r10DebugState.lastShotDir = { x: aim.x - muzzleX, y: aim.y - muzzleY };
    r10DebugState.lastTarget = { x: aim.x, y: aim.y };
    r10DebugLog('SHOT CREATED' + (bullet ? '' : ' (BULLET POOL EXHAUSTED — DROPPED)'));
  }
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

// 12TH ROUND (item 47): the "white door frame" investigation (see
// style.css's own comment) traced that report to a stray browser focus
// ring, not any Canvas effect — but the underlying ask, "DASHの速度感は
// 残す" (keep DASH's sense of speed), is real and independent of that fix.
// A handful of short streak lines radiating from BEHIND the dash direction
// (dirX/dirY is the direction of travel, so streaks trail opposite it),
// fading fast — reuses the existing particle pool/render loop exactly like
// every other effect in this file, no parallel one-off draw path.
function spawnDashStreak(x, y, dirX, dirY, now) {
  const mag = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / mag, uy = dirY / mag;
  const n = 5;
  for (let i = 0; i < n; i++) {
    const spread = (i - (n - 1) / 2) * 0.16;
    const cos = Math.cos(spread), sin = Math.sin(spread);
    // rotate the trailing (behind-motion) unit vector by `spread` radians
    const rx = -ux * cos + uy * sin, ry = -uy * cos - ux * sin;
    spawnParticle({
      type: 'dashstreak', x, y, x2: x + rx * (26 + Math.random() * 18), y2: y + ry * (26 + Math.random() * 18),
      born: now, until: now + 140 + Math.random() * 60,
    });
  }
}

// 14TH ROUND (items 27-30): the re-arm tracker for GABRIEL/ADAM's damage-
// interval rule. Must run every frame (not just at hit-resolve time) since
// the "AIM moved away, then came back" gesture happens continuously as the
// player moves RIGHT STICK, independent of when the next shot actually
// fires. Only ever touches e.damageAimArmed/aimMovedAwaySinceHit for
// GABRIEL/ADAM — a complete no-op for every other type (lastDamageAimX
// stays null until their first real hit, see spawnEnemy()/updateBullets()).
function updateGabrielAdamReaim(now) {
  const e = state.enemy;
  if ((e.type !== 'gabriel' && e.type !== 'adam') || e.lastDamageAimX == null) return;
  const aim = getAimPoint();
  if (!e.aimMovedAwaySinceHit && Math.abs(aim.x - e.lastDamageAimX) >= GABRIEL_ADAM_REAIM_THRESHOLD_PX) {
    e.aimMovedAwaySinceHit = true;
  }
  const elapsedOk = now - e.lastDamageHitAt >= GABRIEL_ADAM_DAMAGE_INTERVAL_MS;
  // item 30: 0.3s elapsing ALONE never re-arms — ALL THREE conditions must
  // hold together: elapsed time, having moved away at some point since the
  // hit, AND being back on the effective-hit point right now.
  e.damageAimArmed = elapsedOk && e.aimMovedAwaySinceHit && isAimOnEffectiveHit();
}

function updateBullets(now) {
  const e = state.enemy;
  for (const b of state.bullets) {
    if (!b.active) continue;
    if (now < b.resolveAt) continue;
    b.active = false;
    if (e.deathState !== 'alive') {
      if (DEBUG_MODE) r10DebugLog('SHOT RESOLVED: enemy not alive (deathState=' + e.deathState + ') — no hit-test run');
      continue; // PART 27: no damage while already dying/gone
    }
    // 12TH ROUND (items 60-75): PROJECTILE midair intercept — checked
    // BEFORE the normal enemy-body hit-test below, since a shot that hits
    // the falling projectile is resolved against IT, not the enemy's own
    // body. Destroying it here causes NEITHER a floor impact NOR player
    // damage (resolveMissileImpact() never runs — the state machine skips
    // straight to 'cooldown', see updateEnemy()'s 'target' branch owner).
    if (e.kind === 'missile' && e.attackState === 'target' && !e.missileDestroyed && e.missileHeight > 1) {
      const pv = getMissileProjectileVisual(e);
      const pdist = Math.hypot(b.x2 - pv.x, b.y2 - pv.y);
      if (pdist <= pv.hitRadius) {
        e.missileDestroyed = true;
        // 16TH ROUND (Part A/B): real BLAST for the midair intercept too —
        // same small-scale, no-shockwave treatment as SNIPER's bolt impact
        // (it's a projectile detonating in open air, not a ground impact).
        spawnBlast(pv.x, pv.y, now, { scale: 0.5, big: false, shockwave: false });
        e.attackState = 'cooldown';
        e.attackUntil = now + MISSILE_COOLDOWN_MS;
        if (DEBUG_MODE) r10DebugLog('PROJECTILE INTERCEPTED midair (' + (ENEMY_LABEL[e.type] || e.type) + ') dist=' + pdist.toFixed(1) + '/r=' + pv.hitRadius.toFixed(1));
        continue;
      }
    }
    const rect = computeEnemyDrawRect();
    const hitRadius = enemyHitRadius(rect);
    const dist = Math.hypot(b.x2 - rect.cx, b.y2 - rect.cy);
    // 11TH ROUND (items 17-20): ROID1/ROID2 HEAD WEAK POINT. Investigated
    // first (item 17-18): the previous hit-test treated the whole body
    // silhouette as equally "effective" (hitRadius = rect.w*0.42 centered
    // on the body midpoint) — no headshot concept existed at all. Chosen
    // design (item 19, reported honestly): the body hit-test STILL
    // resolves the shot (impact spark, so it never reads as a pure whiff)
    // but deals ZERO damage unless it also falls within the real, per-
    // frame measured head circle — "どこを撃っても同じ" is explicitly
    // rejected in favor of "頭部を狙うことに意味がある設計". Every other
    // enemy type (rect.headX undefined) is completely unaffected — falls
    // through to the exact same generic body-hit damage path as before.
    const isRoidType = e.type === 'roid1' || e.type === 'roid2';
    const hasHeadPoint = isRoidType && rect.headX != null;
    const headDist = hasHeadPoint ? Math.hypot(b.x2 - rect.headX, b.y2 - rect.headY) : Infinity;
    const headHit = hasHeadPoint && headDist <= rect.headR;
    // Playwright-measured live-hit-test verification (this round) caught a
    // real bug here: hitRadius/dist are centered on the body's VERTICAL
    // MIDPOINT (rect.cy — see computeEnemyDrawRect()'s cy formula), but the
    // real measured head sits well above that midpoint — for roid1 in a
    // typical mid-range pose, headDist-from-cy alone already exceeds
    // hitRadius, so a shot landing dead-center in the real head circle was
    // being rejected by THIS outer gate before ever reaching the headHit
    // check below, i.e. an accurate headshot silently MISSED. Fixed by
    // OR-ing in headHit here: the real, per-frame-measured head circle is
    // now its own authoritative hit region, independent of the old body-
    // center circle, so a headshot can never again be gated out by it.
    if (dist <= hitRadius || headHit) {
      if (isRoidType && !headHit) {
        // BODY HIT (outside the head weak point): shot resolves visually
        // but the design intentionally withholds damage — see comment above.
        spawnPlayerImpact(b.x2, b.y2, now);
        if (DEBUG_MODE) {
          r10DebugState.lastHitTestResult = 'BODY HIT dist=' + dist.toFixed(1) + ' headDist=' + headDist.toFixed(1) + '/headR=' + rect.headR.toFixed(1);
          r10DebugLog('BODY HIT ' + (ENEMY_LABEL[e.type] || e.type) + ' headDist=' + headDist.toFixed(1) + ' (no damage — HEAD required)');
        }
        continue;
      }
      // ROOT CAUSE (PART 21/22): this hit-test always fired correctly, but
      // NOTHING here ever touched enemy.hp — a full-repo search before this
      // change confirmed enemy.hp had no writer anywhere in the codebase
      // (only its initial value). It was Case A: the underlying HP value
      // itself never decreased — not a gauge-only display bug (no gauge
      // existed at all yet either, see the new #enemy-hud markup/updateHud()
      // below). This is the actual fix: apply real damage here.
      // 14TH ROUND (items 22-43): GABRIEL/ADAM DEFENSE/COUNTER gates — both
      // checked BEFORE the shared e.invulnerable branch below (COUNTER's own
      // invulnerable=true would otherwise just fall into that ROID-authored
      // branch and look identical to a ROID counter-phase block; this keeps
      // GABRIEL/ADAM's own distinct blocked-hit feedback and re-arm
      // bookkeeping instead). ROID1/ROID2 never reach here (isClawBoss is
      // false for them) — item 42.
      const isClawBoss = e.type === 'gabriel' || e.type === 'adam';
      if (isClawBoss && (e.attackState === 'defense' || e.attackState === 'counterApproach' || e.attackState === 'counterAttack')) {
        // item 25-26: visually distinct 0-damage block — a small blue-white
        // spark burst (reuses the existing 'spark' particle type, just at a
        // cool tint via a dedicated color, never the plain player-impact
        // spark alone) rather than a silent HP-side no-op.
        spawnPlayerImpact(b.x2, b.y2, now);
        spawnParticle({ type: 'defenseBlock', x: b.x2, y: b.y2, born: now, until: now + 160 });
        if (DEBUG_MODE) r10DebugLog('DAMAGE BLOCKED: DEFENSE/COUNTER (' + (ENEMY_LABEL[e.type] || e.type) + ' state=' + e.attackState + ')');
        continue;
      }
      if (isClawBoss && !e.damageAimArmed) {
        // item 27-30: repeated fire at the same point after a hit deals 0
        // damage until the player has ALSO moved AIM away and re-acquired
        // the point (not just waited 0.3s) — see updateGabrielAdamReaim().
        spawnPlayerImpact(b.x2, b.y2, now);
        if (DEBUG_MODE) r10DebugLog('DAMAGE BLOCKED: NOT RE-ARMED (' + (ENEMY_LABEL[e.type] || e.type) + ')');
        continue;
      }
      // 10TH ROUND (items 45/48): ROID1/ROID2 counter-phase invulnerability
      // — a real hit still spawns the impact spark (visual confirmation the
      // shot landed) but HP is untouched while e.invulnerable is true.
      if (e.invulnerable) {
        spawnPlayerImpact(b.x2, b.y2, now);
        if (DEBUG_MODE) r10DebugLog('DAMAGE BLOCKED: INVULNERABLE (' + (ENEMY_LABEL[e.type] || e.type) + (headHit ? ' HEAD HIT' : '') + ')');
      } else {
        const hpBefore = e.hp;
        e.hp = Math.max(0, e.hp - BULLET_DAMAGE);
        e.hitFlashUntil = now + 120;
        spawnPlayerImpact(b.x2, b.y2, now);
        if (DEBUG_MODE) {
          r10DebugState.hitCount++;
          r10DebugState.lastHitTestResult = (headHit ? 'HIT HEAD ' : 'HIT ') + 'dist=' + dist.toFixed(1) + '/r=' + hitRadius.toFixed(1);
          r10DebugState.lastDamage = BULLET_DAMAGE;
          r10DebugState.lastDamageAt = now;
          r10DebugLog((headHit ? 'HIT HEAD ' : 'HIT ') + (ENEMY_LABEL[e.type] || e.type) + ' dist=' + dist.toFixed(1) + ' r=' + hitRadius.toFixed(1));
          r10DebugLog('DAMAGE ' + BULLET_DAMAGE + ' HP ' + hpBefore + '->' + e.hp);
        }
        // 10TH ROUND (items 41-48): ROID1/ROID2 20%-threshold counter phase.
        // Checked high-to-low so a single large/overlapping hit that crosses
        // more than one threshold in one frame only ever triggers the
        // HIGHEST untriggered one (still exactly one trigger this frame —
        // the others remain available for later hits, never skipped or
        // double-fired). e.triggeredThresholds permanently marks each one
        // used so revisiting the same HP% later (impossible for HP, but
        // defensive) can never refire it.
        if ((e.type === 'roid1' || e.type === 'roid2') && e.hp > 0) {
          const pct = e.hp / e.maxHp;
          for (let ti = 0; ti < ROID_COUNTER_THRESHOLDS.length; ti++) {
            const t = ROID_COUNTER_THRESHOLDS[ti];
            if (pct <= t && !e.triggeredThresholds.includes(t)) {
              e.triggeredThresholds.push(t);
              e.invulnerable = true;
              e.counterPhaseUntil = now + ROID_COUNTER_PHASE_MS;
              e.hitFlashUntil = now + ROID_COUNTER_BLINK_MS; // reuses the existing hit-flash blink — no new visual system
              // 16TH ROUND (Part I, root-cause fix): the forced idle-check
              // used to just be `e.nextIdleCheckAt = now`, which only
              // actually STARTS an attack if e.z < 900 (see updateEnemy()'s
              // idle branch) — "merely invulnerable, no real attack" was
              // reproducible whenever the enemy's z happened to sit at/above
              // that gate the instant a threshold fired. Clamping z here
              // guarantees whatever forced attack we start below always
              // launches from inside attack range.
              if (e.z >= 900) e.z = 850;
              // 16TH ROUND PART S-6: force a genuine, escalating counter-
              // attack instead of merely re-rolling into the normal random
              // pool — spec item 156: 80%/40% = SWEEP FIRE (40% gets the
              // enhanced/longer burst), 60%/20% = MULTI MISSILE BARRAGE
              // (20% gets the full 4-missile barrage instead of 3). This
              // directly satisfies item 157 ("PLAYERがROIDを一方的に撃つ
              // →閾値到達→ROIDが無敵化/反撃準備→明確な攻撃を返してくる
              // →PLAYERがDASH/移動を要求される").
              if (ti === 0) startSweepAttack(e, now, false, 1);
              else if (ti === 1) startBarrageAttack(e, now, 3, 1);
              else if (ti === 2) startSweepAttack(e, now, true, 1);
              else startBarrageAttack(e, now, 4, 1);
              if (DEBUG_MODE) r10DebugLog('COUNTER PHASE START (' + (ENEMY_LABEL[e.type] || e.type) + ' @' + Math.round(t * 100) + '%) kind=' + e.kind);
              break;
            }
          }
        }
        // 14TH ROUND (items 22-39): GABRIEL/ADAM 2-hit-then-DEFENSE / 5-hit-
        // total-forced-COUNTER bookkeeping — this only runs on a hit that
        // JUST passed both new gates above (a real, re-armed, non-blocked
        // hit), matching item 24's "1st/2nd hit -> DAMAGE" + item 31's
        // "5 total real hits -> forced COUNTER" spec exactly.
        if (isClawBoss && e.hp > 0) {
          e.hitInCurrentDefenseCycle++;
          e.defenseHitsTotal++;
          e.lastDamageHitAt = now;
          e.damageAimArmed = false;
          e.lastDamageAimX = b.x2;
          e.aimMovedAwaySinceHit = false;
          if (e.defenseHitsTotal >= GABRIEL_ADAM_COUNTER_TOTAL_HITS) {
            // item 31-32: skip DEFENSE entirely — straight to the forced COUNTER.
            e.attackState = 'counterApproach';
            e.attackUntil = now + GABRIEL_ADAM_COUNTER_APPROACH_MS;
            e.clawApproachStartZ = e.z;
            e.invulnerable = true;
            e.hitInCurrentDefenseCycle = 0;
            if (DEBUG_MODE) r10DebugLog('COUNTER TRIGGERED (' + (ENEMY_LABEL[e.type] || e.type) + ' @' + e.defenseHitsTotal + ' total hits)');
          } else if (e.hitInCurrentDefenseCycle >= GABRIEL_ADAM_DEFENSE_HIT_CYCLE) {
            e.attackState = 'defense';
            e.attackUntil = now + GABRIEL_ADAM_DEFENSE_MS;
            e.hitInCurrentDefenseCycle = 0;
            if (DEBUG_MODE) r10DebugLog('DEFENSE TRIGGERED (' + (ENEMY_LABEL[e.type] || e.type) + ')');
          }
        }
        if (e.hp <= 0) startEnemyDeath(now);
      }
    } else if (DEBUG_MODE) {
      r10DebugState.missCount++;
      r10DebugState.lastHitTestResult = 'MISS dist=' + dist.toFixed(1) + '/r=' + hitRadius.toFixed(1);
      r10DebugLog('MISS dist=' + dist.toFixed(1) + ' r=' + hitRadius.toFixed(1));
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
// 13TH ROUND (items 9-19, real-device fix): LIGHT CENTER is now a genuine
// PERSISTENT POSITION (p.lightPersistX/Y) — the LEFT STICK moves it (as a
// velocity, see updatePlayer()'s manual branch) and it simply STAYS where
// it was left when the stick returns to neutral, never recentering. FOCUS
// (autoAimActive) drives the SAME field directly toward the current
// effective-hit point (updatePlayer()'s autoAimActive branch) — there is
// only ever ONE light-position variable, matching AIM's own aimLiveX/Y
// architecture, so the two can never compete or fight over LIGHT's
// position.
function getFlashlightCenter() {
  const p = state.player;
  return {
    x: state.centerX + p.lightPersistX,
    y: state.horizonY + state.cssH * 0.06 + p.lightPersistY,
  };
}

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
  const rawX = baseX + p.aimManualOffsetX + p.aimLiveX;
  const rawY = baseY + p.aimManualOffsetY + p.aimLiveY;
  // 7TH ROUND PART 12: safety clamp on the FINAL resolved point only — see
  // AIM_SCREEN_SAFE_MARGIN_PX's own comment. This only ever engages near
  // the true canvas edge; everywhere else it's a no-op.
  let x = clamp(rawX, AIM_SCREEN_SAFE_MARGIN_PX, state.cssW - AIM_SCREEN_SAFE_MARGIN_PX);
  let y = clamp(rawY, AIM_SCREEN_SAFE_MARGIN_PX, state.cssH - AIM_SCREEN_SAFE_MARGIN_PX);
  // 12TH ROUND (items 52-53): AIM must never leave the LIGHT circle — the
  // crosshair reading RED outside the lit area (or FIRE landing on
  // something the player can't even see) was never physically consistent
  // with "探す/照らす/狙う" gameplay. Clamped here, on the FINAL resolved
  // point, against getFlashlightCenter()/FLASHLIGHT_BASE_RADIUS — the SAME
  // live values renderFlashlight()/renderAimReticle() actually draw with
  // this frame (no stale/old-radius copy), so the visible lit circle and
  // this clamp can never disagree.
  const light = getFlashlightCenter();
  const dx = x - light.x, dy = y - light.y;
  const dist = Math.hypot(dx, dy);
  const maxDist = FLASHLIGHT_BASE_RADIUS - AIM_LIGHT_CLAMP_MARGIN_PX;
  if (dist > maxDist && dist > 0) {
    const k = maxDist / dist;
    x = light.x + dx * k;
    y = light.y + dy * k;
  }
  return { x, y };
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
      // 11TH ROUND (items 21-22): investigated first — 'pipe' used to draw
      // unconditionally in EVERY theme (part of the original shared 8-kind
      // pool, never theme-gated), a full-corridor-width horizontal line at
      // a FIXED height (CORRIDOR_CEIL_Y*0.35 — well below the true ceiling
      // line 'gantry' already draws), repeated at every one of its own
      // spacing instances. Confirmed via a live monkey-patch test
      // (disabling only this case) that this exact line is the "stray
      // horizontal line crossing the upper screen, not the ceiling itself"
      // reported in both ARMORED and ESCAPE screenshots — LAB was never
      // reported because its own busy labTank clutter visually absorbed
      // it. 'gantry' (the real ceiling/floor/wall outline) and the new
      // 'armorGate' lattice are untouched — only this redundant, non-
      // structural decorative line is now gated to LAB only, where it
      // reads as legitimate overhead piping.
      if (state.theme !== 'lab') break;
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
      // 10TH ROUND item 12 ("赤い光が暗い回廊を部分的に照らす"): the lamp
      // itself already existed (left/right edges, blink via per-instance
      // phase) — added a soft low-alpha glow behind it so it visibly
      // spills a little light into the dark corridor instead of just
      // being a bare dot. Color still comes entirely from theme.warn, so
      // this stays red for ARMORED without a theme-specific branch.
      const side = s.phase > Math.PI ? 1 : -1;
      const pt = project(side * half * 0.96, CORRIDOR_CEIL_Y * 0.55, s.z);
      const blink = Math.sin(state.timeSec * 6 + s.phase) > 0.4;
      if (blink) {
        ctx.save();
        ctx.fillStyle = theme.warn;
        ctx.globalAlpha = Math.min(0.35, pt.scale * 0.5);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, Math.max(4, 14 * pt.scale), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = Math.min(1, pt.scale * 1.6);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, Math.max(1.5, 4 * pt.scale), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      break;
    }

    // 7TH ROUND PART 19: theme-exclusive structural elements — see the
    // STRUCTURE_KINDS comment for why these are in the same shared pool
    // but each only ever draws under its own theme.
    case 'labTank': {
      // 10TH ROUND items 6-8: was a single flat ellipse ("細長い楕円" —
      // read as a capsule, not a tank). Rebuilt as the explicit structure
      // the spec requires: TOP CAP (thick mechanical cap) / GLASS CYLINDER
      // filled with culture LIQUID (+ rising bubbles + a highlight streak)
      // / BASE UNIT (thick mechanical base), stacked vertically. top/bot
      // share the same world z, so they project to the same x/scale —
      // this is a true vertical column, not an ellipse.
      if (state.theme !== 'lab') break;
      const side = s.phase > Math.PI ? 1 : -1;
      const top = project(side * half * 0.88, CORRIDOR_CEIL_Y * 0.62, s.z);
      const bot = project(side * half * 0.88, CORRIDOR_FLOOR_Y * 0.92, s.z);
      const scale = top.scale;
      const totalH = bot.y - top.y;
      if (scale < 0.02 || totalH < 3) break; // too far / degenerate — skip
      const bodyW = Math.max(3, 22 * scale);
      const capH = Math.max(2, totalH * 0.14);
      const baseH = Math.max(2, totalH * 0.16);
      const glassH = Math.max(1, totalH - capH - baseH);
      const cx = top.x;
      const capY = top.y;
      const glassY = capY + capH;
      const baseY = glassY + glassH;
      const alpha = Math.min(1, scale * 1.6);

      ctx.save();
      ctx.globalAlpha = alpha;

      // BASE UNIT (thick mechanical base)
      ctx.fillStyle = theme.wallDark;
      ctx.fillRect(cx - bodyW * 0.62, baseY, bodyW * 1.24, baseH);

      // GLASS CYLINDER: faint glass tint, then culture LIQUID fill with a
      // gently wobbling level so it doesn't read as a static drawing.
      const liquidTopFrac = 0.18 + 0.05 * Math.sin(state.timeSec * 1.3 + s.phase);
      const liquidTopY = glassY + glassH * liquidTopFrac;
      ctx.globalAlpha = alpha * 0.35;
      ctx.fillStyle = theme.wallDark;
      ctx.fillRect(cx - bodyW / 2, glassY, bodyW, glassH);
      ctx.globalAlpha = alpha * 0.6;
      ctx.fillStyle = theme.accent;
      ctx.fillRect(cx - bodyW / 2, liquidTopY, bodyW, baseY - liquidTopY);

      // rising bubbles through the liquid
      ctx.globalAlpha = alpha * 0.85;
      for (let i = 0; i < 3; i++) {
        const bp = (state.timeSec * 0.35 + s.phase + i / 3) % 1;
        const by = baseY - bp * (baseY - liquidTopY);
        if (by < liquidTopY) continue;
        const bx = cx + Math.sin(i * 2.1 + s.phase) * bodyW * 0.22;
        ctx.beginPath();
        ctx.arc(bx, by, Math.max(0.6, 1.4 * scale), 0, Math.PI * 2);
        ctx.fill();
      }

      // glass highlight streak + cylinder outline
      ctx.globalAlpha = alpha * 0.5;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(0.5, 1.4 * scale);
      ctx.beginPath();
      ctx.moveTo(cx - bodyW * 0.28, glassY + glassH * 0.08);
      ctx.lineTo(cx - bodyW * 0.28, baseY - glassH * 0.06);
      ctx.stroke();
      ctx.globalAlpha = alpha * 0.7;
      ctx.strokeStyle = theme.wallDark;
      ctx.lineWidth = Math.max(0.6, 1.2 * scale);
      ctx.strokeRect(cx - bodyW / 2, glassY, bodyW, glassH);

      // TOP CAP (thick mechanical cap) + small indicator + thin piping
      ctx.globalAlpha = alpha;
      ctx.fillStyle = theme.wallDark;
      ctx.fillRect(cx - bodyW * 0.58, capY, bodyW * 1.16, capH);
      if (Math.sin(state.timeSec * 2.4 + s.phase) > 0.3) {
        ctx.fillStyle = theme.accent;
        ctx.beginPath();
        ctx.arc(cx, capY + capH * 0.5, Math.max(0.8, 1.6 * scale), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = alpha * 0.55;
      ctx.strokeStyle = theme.wallDark;
      ctx.lineWidth = Math.max(0.5, 1 * scale);
      ctx.beginPath();
      ctx.moveTo(cx, capY);
      ctx.lineTo(cx, Math.max(0, capY - capH * 1.6));
      ctx.stroke();

      ctx.restore();
      break;
    }
    case 'labConsole': {
      if (state.theme !== 'lab') break;
      const side = s.phase > Math.PI ? -1 : 1;
      const pt = project(side * half * 0.98, CORRIDOR_CEIL_Y * 0.15, s.z);
      const w = Math.max(2, 22 * pt.scale), h = Math.max(2, 14 * pt.scale);
      ctx.save();
      ctx.fillStyle = theme.wallDark;
      ctx.fillRect(pt.x - w / 2, pt.y, w, h);
      if (Math.sin(state.timeSec * 5 + s.phase) > 0.2) {
        ctx.fillStyle = theme.accent;
        ctx.globalAlpha = 0.85 * Math.min(1, pt.scale * 1.6);
        ctx.fillRect(pt.x - w * 0.35, pt.y + h * 0.25, w * 0.7, h * 0.3);
      }
      ctx.restore();
      break;
    }
    case 'armorGate': {
      // 10TH ROUND items 10-12: replaces the removed 'armorPlate' (a
      // full-width horizontal bar at every spacing — read as "bridge
      // cross-bars" clutter) and 'armorHatch' (an unwanted square-with-an-X
      // badge). Restored to the simpler, previously-intended ARMORED look:
      // a lattice/grid-pattern GATE FRAME spanning the full corridor
      // cross-section, receding into the distance — outer frame + a few
      // vertical lattice bars + a single mid-height cross-brace, nothing
      // more. The red warning lights are the separate, shared
      // 'warningLight' kind above (see THEMES.armored.warn).
      if (state.theme !== 'armored') break;
      const topL = project(-half * 0.98, CORRIDOR_CEIL_Y * 0.92, s.z);
      const topR = project(half * 0.98, CORRIDOR_CEIL_Y * 0.92, s.z);
      const botL = project(-half * 0.98, CORRIDOR_FLOOR_Y * 0.92, s.z);
      const botR = project(half * 0.98, CORRIDOR_FLOOR_Y * 0.92, s.z);
      const scale = topL.scale;
      if (scale < 0.015) break;
      const alpha = Math.min(1, scale * 2.2);
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = theme.wallDark;
      ctx.lineWidth = Math.max(1, 6 * scale);
      ctx.beginPath();
      ctx.moveTo(botL.x, botL.y); ctx.lineTo(topL.x, topL.y); ctx.lineTo(topR.x, topR.y); ctx.lineTo(botR.x, botR.y);
      ctx.stroke();
      // lattice: a few vertical bars inside the frame
      ctx.lineWidth = Math.max(0.6, 2 * scale);
      ctx.globalAlpha = alpha * 0.8;
      const bars = 5;
      for (let i = 1; i < bars; i++) {
        const f = i / bars;
        const tx = topL.x + (topR.x - topL.x) * f, ty = topL.y + (topR.y - topL.y) * f;
        const bx = botL.x + (botR.x - botL.x) * f, by = botL.y + (botR.y - botL.y) * f;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(bx, by); ctx.stroke();
      }
      // single mid-height cross-brace (not a repeating wall of bars)
      ctx.lineWidth = Math.max(0.8, 3 * scale);
      ctx.globalAlpha = alpha * 0.7;
      ctx.beginPath();
      ctx.moveTo((topL.x + botL.x) / 2, (topL.y + botL.y) / 2);
      ctx.lineTo((topR.x + botR.x) / 2, (topR.y + botR.y) / 2);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'escapeArrow': {
      if (state.theme !== 'escape') break;
      const pt = project(0, CORRIDOR_FLOOR_Y * 0.99, s.z);
      const w = Math.max(3, 26 * pt.scale);
      ctx.save();
      ctx.strokeStyle = theme.warn;
      ctx.globalAlpha = Math.min(1, pt.scale * 1.8);
      ctx.lineWidth = Math.max(1, 2.5 * pt.scale);
      ctx.beginPath();
      ctx.moveTo(pt.x - w / 2, pt.y - w * 0.35);
      ctx.lineTo(pt.x, pt.y + w * 0.35);
      ctx.lineTo(pt.x + w / 2, pt.y - w * 0.35);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'escapeStrip': {
      if (state.theme !== 'escape') break;
      if (Math.sin(state.timeSec * 4 + s.phase) <= -0.2) break;
      const l = project(-half * 0.85, CORRIDOR_FLOOR_Y * 0.995, s.z);
      const r = project(-half * 0.7, CORRIDOR_FLOOR_Y * 0.995, s.z);
      const l2 = project(half * 0.7, CORRIDOR_FLOOR_Y * 0.995, s.z);
      const r2 = project(half * 0.85, CORRIDOR_FLOOR_Y * 0.995, s.z);
      ctx.save();
      ctx.strokeStyle = theme.warn;
      ctx.globalAlpha = Math.min(1, l.scale * 1.6);
      ctx.lineWidth = Math.max(1, 3 * l.scale);
      ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(r.x, r.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(l2.x, l2.y); ctx.lineTo(r2.x, r2.y); ctx.stroke();
      ctx.restore();
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
// 9TH ROUND (item 10-14): re-adds a floor shadow under each barrel, but as a
// soft, natural, dim ellipse (never a bright/game-UI circle, no outline, no
// text) whose radius is computed with the EXACT SAME formula isPlayerInCover()
// uses (BARREL_TOUCH_RADIUS_PX * proj.scale + COVER_TOUCH_SLOP_PX), so the
// visible shadow always equals the real cover-eligible area — "if you can see
// the shadow reach you, you are in cover." Drawing itself is factored into
// drawOneBarrel() so the COVER-time foreground occlusion pass (see
// renderBarrelForeground(), called after renderPlayer()) can reuse the exact
// same barrel art/fallback logic without duplicating it.
function barrelCoverRadiusPx(proj) {
  return BARREL_TOUCH_RADIUS_PX * proj.scale + COVER_TOUCH_SLOP_PX;
}

// 14TH ROUND (items 15-16): the shadow and the physical barrel body are now
// split into two separate draw functions. Previously drawOneBarrel() drew
// BOTH together, and renderBarrelForeground() (below) called it a SECOND
// time AFTER renderPlayer() to redraw the covering barrel on top of the
// player for the COVER occlusion effect — which meant the SHADOW also got
// redrawn a second time, on top of the player, every time the player stood
// in a barrel's cover footprint (exactly the real-device report: the floor
// shadow rendering over the player sprite). Root cause: shadow + body were
// never independent layers. Fix: FLOOR -> BARREL SHADOW -> PLAYER -> (only
// when in cover) foreground BARREL BODY — the shadow is drawn exactly once,
// in the pre-player pass, and never again.
function drawBarrelShadow(b, proj) {
  if (b.z > BARREL_TOUCH_Z_MAX) return;
  const shadowR = barrelCoverRadiusPx(proj);
  const inCover = isPlayerInCover();
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(proj.x, proj.y - 2, shadowR, shadowR * 0.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = inCover ? 'rgba(10,10,14,0.55)' : 'rgba(8,8,10,0.38)';
  ctx.filter = 'blur(3px)';
  ctx.fill();
  ctx.restore();
}

function drawBarrelBody(b, proj) {
  const drawH = BARREL_DRAW_H * proj.scale;
  if (drawH < 1.5) return;
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

function drawOneBarrel(b, proj) {
  const drawH = BARREL_DRAW_H * proj.scale;
  if (drawH < 1.5) return;
  drawBarrelShadow(b, proj);
  drawBarrelBody(b, proj);
}

function renderBarrels() {
  const sorted = barrels.slice().sort((a, b) => b.z - a.z);
  for (const b of sorted) {
    const proj = project(b.lane, CORRIDOR_FLOOR_Y, b.z);
    drawOneBarrel(b, proj);
  }
}

// 9TH ROUND (item 14): renderBarrels() runs BEFORE renderPlayer() in frame(),
// so the player sprite always drew on top of the barrel and never looked
// hidden behind it. This redraws only the specific barrel(s) currently
// providing cover, on top of the (already-drawn) player, to create real
// depth/occlusion — never touches barrels the player isn't using.
// 14TH ROUND (items 15-16): BODY ONLY — the shadow was already drawn once
// by renderBarrels() before the player, and must never be redrawn here (see
// drawBarrelShadow()'s comment above).
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

const redTintCanvas = document.createElement('canvas');
const redTintCtx = redTintCanvas.getContext('2d');
// 16TH ROUND (Part F, root-cause fix): the old DAMAGE red blink drew its
// source-atop fill directly on the MAIN canvas, right after the sprite —
// but source-atop composites onto whatever destination pixels already have
// alpha>0, and the main canvas at that point still carries everything
// painted underneath (background, LIGHT/flashlight mask circle, floor),
// not just the sprite that was "just drawn". So a distant, mostly-
// transparent sprite's PNG canvas rect (and any LIGHT circle overlapping
// it) got reddened along with it — confirmed visually (a full red rectangle
// + reddened LIGHT circle around a hit ROID2). Fix: draw the sprite to a
// small OFFSCREEN canvas first (which starts fully transparent and holds
// ONLY the sprite's own pixels), apply source-atop there — so it can only
// ever redden pixels the sprite itself painted — then blit that tinted
// result onto the main canvas with a normal source-over draw.
function drawRedTintedSprite(img, dx, dy, w, h) {
  const cw = Math.max(1, Math.round(w));
  const ch = Math.max(1, Math.round(h));
  if (redTintCanvas.width !== cw || redTintCanvas.height !== ch) {
    redTintCanvas.width = cw;
    redTintCanvas.height = ch;
  }
  redTintCtx.clearRect(0, 0, cw, ch);
  redTintCtx.globalCompositeOperation = 'source-over';
  redTintCtx.drawImage(img, 0, 0, cw, ch);
  redTintCtx.globalCompositeOperation = 'source-atop';
  redTintCtx.fillStyle = 'rgba(255,40,40,0.65)';
  redTintCtx.fillRect(0, 0, cw, ch);
  ctx.drawImage(redTintCanvas, dx, dy, w, h);
}

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

// COVER ACTION — WEST facing reuses ASSETS.player.cover.east, mirrored.
// Built ONCE into a small offscreen canvas the first time it's actually
// needed (never at load time, since the source Image may not be ready
// yet — callers only invoke this after confirming imgReady() on the
// ORIGINAL image), then reused every subsequent frame. The mirror is done
// entirely on this own private context (save/translate/scale/drawImage/
// restore, all scoped to THIS offscreen canvas) — it never touches the
// main `ctx`'s transform, so it cannot leak a flip into any later
// enemy/background/UI drawing on the main canvas (see the completion
// report's own note on this).
let coverEastFlippedCanvas = null;
function getFlippedCoverEastImage(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (coverEastFlippedCanvas && coverEastFlippedCanvas._sourceImg === img) return coverEastFlippedCanvas;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const fctx = c.getContext('2d');
  fctx.save();
  fctx.translate(w, 0);
  fctx.scale(-1, 1);
  fctx.drawImage(img, 0, 0, w, h);
  fctx.restore();
  c._sourceImg = img;
  coverEastFlippedCanvas = c;
  return c;
}

function renderPlayer(theme) {
  const p = state.player;
  const cx = state.centerX + p.strafeOffset;
  const bottomY = state.cssH * 1.02;
  const nowTs = now_();

  // 7TH ROUND PART 14/15/16: FIRE no longer swaps to a separate fire.png
  // pose — it reuses the SAME north-facing aim image, briefly enlarged,
  // synced to each REAL shot (p.lastShotAt, stamped in fireWeapon() on its
  // own FIRE_COOLDOWN_MS cadence) rather than the raw held-button state.
  // This is what makes a held FIRE visibly pulse normal->enlarged once per
  // actual shot instead of freezing on one static image for the whole
  // hold — see FIRE_POSE_HOLD_MS's own comment.
  const firing = (nowTs - p.lastShotAt) < FIRE_POSE_HOLD_MS;

  // COVER ACTION (drum-can hiding pose): sprite-selection priority is
  // DASH(特殊演出) > COVER > FIRE/RELOAD > WALK > default AIM — a dash
  // already in progress always wins (it covers real distance and must
  // show its own directional lunge pose; this is also exactly what makes
  // COVER自動的に解除される when a dash carries the player out of
  // isPlayerInCover()'s radius — no separate cancel logic needed), but
  // COVER otherwise overrides the normal FIRE/WALK/AIM pose choice
  // entirely — reuses the EXISTING isPlayerInCover() (unmodified) as the
  // ACTIVE/INACTIVE gate, not the smoothed p.coverVisual (that stays as
  // the separate tint-fade effect below, applied ON TOP of whichever
  // sprite — cover or normal — ends up chosen here).
  const dashActive = nowTs < p.fwdDashUntil || nowTs < p.dashUntil;
  const usingCoverPose = !dashActive && isPlayerInCover();
  const coverFlip = usingCoverPose && p.coverFacing === 'west';
  const coverFrame = usingCoverPose ? (coverFlip ? ASSETS.player.cover.east : ASSETS.player.cover[p.coverFacing]) : null;

  // 15TH ROUND (items 4-9): genuine 3-frame SOUTH WALK, gated the SAME way
  // the old single-image southWalk pose was (walk + real south input),
  // plus excluding dashActive up front (unlike the old img-identity check
  // below, southWalkFrame is a per-frame OBJECT, not a stable image
  // reference, so it can't be re-detected after the DASH override further
  // down reassigns img — excluding dashActive here instead keeps the same
  // net behavior: DASH always wins, exactly like before).
  const usingSouthWalkPose = !usingCoverPose && !dashActive && !p.reloading && !firing && p.facing === 'walk' && p.moveDirSouth;
  const southWalkFrame = usingSouthWalkPose ? ASSETS.player.southWalkFrames[p.walkFrame] : null;

  let img;
  if (usingCoverPose) img = coverFrame.img; // readiness checked below before this is ever flipped/drawn
  else if (p.reloading) img = ASSETS.player.aim;
  else if (firing) img = ASSETS.player.aim;
  else if (usingSouthWalkPose) img = southWalkFrame.img;
  else if (p.facing === 'walk') img = ASSETS.player.walk[p.walkFrame];
  else img = ASSETS.player.aim;
  // COVER中はFIRE演出の拡大ポーズを適用しない — 画像そのものがCOVER専用に
  // 置き換わるため（FIRE_POSE_SCALE_BOOSTの二重適用を避ける）。
  let fireScaleBoost = (firing && !usingCoverPose) ? FIRE_POSE_SCALE_BOOST : 1;

  // 10TH ROUND (items 1-2): SOUTH dash (fwdDashSign<0, the old "BACKSTEP")
  // now shows the real south-facing pose instead of the north-facing lunge
  // — unifies with normal SOUTH walk and SOUTH COVER, which already face
  // south (per this round's explicit "南方向の入力なら常にSOUTHを向く"
  // rule). NORTH dash (fwdDashSign>0) is unchanged. EAST/WEST DASH use
  // real direction-specific art so the dash direction actually reads
  // visually. DASH always wins over the fire-pose boost — it already has
  // its own distinct pose, no need to also enlarge it. (usingCoverPose is
  // already guaranteed false here whenever dashActive is true, so this
  // never fights the COVER branch above.)
  if (nowTs < p.fwdDashUntil) {
    img = p.fwdDashSign > 0 ? ASSETS.player.dashN : ASSETS.player.dashS;
    fireScaleBoost = 1;
  } else if (nowTs < p.dashUntil) {
    img = p.dashDir > 0 ? ASSETS.player.dashE : ASSETS.player.dashW;
    fireScaleBoost = 1;
  }

  // PART 5 (2nd round): the player reads a bit bigger now, leaning toward
  // the original "腰から上を中心に表示するTPS" intent — PLAYER_SCALE_BOOST
  // is the ONLY new factor here; nothing about AIM/hit-test/cover geometry
  // reads this value (there is no player collision-radius constant in this
  // game to begin with, so there is nothing coupled to accidentally
  // over-scale alongside the sprite).
  const baseScale = (state.cssH / 900) * PLAYER_SCALE_BOOST * fireScaleBoost;
  const strength = getStealthStrength(nowTs);

  if (!imgReady(img)) {
    drawSpriteCentered(img, cx, bottomY, baseScale * p.scale, 1);
    return;
  }

  let drawW, drawH, dx, dy;
  if (usingCoverPose) {
    // Uniform on-screen body size across all COVER directions (south/
    // north/east/west-flip) — reuses computeBodyVisualScale() verbatim
    // (the SAME normalization ROID1/ROID2/ADAM SPHERE/ESCAPE already rely
    // on), fed this frame's own measured bodyTopFrac/bodyBottomFrac.
    // Target height is COVER_HEIGHT_RATIO of the player's OWN current
    // standing height (judged from the actual rendered size, never source
    // resolution) so the crouch reads as genuinely lower than standing.
    const standingBodyHeightPx = ASSETS.player.aim.naturalHeight * baseScale * p.scale;
    const targetBodyHeightPx = standingBodyHeightPx * COVER_HEIGHT_RATIO;
    const bodyScale = computeBodyVisualScale(coverFrame, targetBodyHeightPx);
    drawW = coverFrame.img.naturalWidth * bodyScale;
    drawH = coverFrame.img.naturalHeight * bodyScale;
    // Stable anchor: this frame's own measured body-center-X/body-
    // bottom-Y is pinned to the SAME fixed screen point (cx, bottomY) for
    // every direction (mirrored for WEST, since the drawn image itself is
    // mirrored too — see getFlippedCoverEastImage() below) — so switching
    // COVER direction never jumps the player's on-screen position.
    const centerXFrac = coverFlip ? (1 - coverFrame.bodyCenterXFrac) : coverFrame.bodyCenterXFrac;
    dx = cx - centerXFrac * drawW;
    dy = bottomY - coverFrame.bodyBottomFrac * drawH;
    if (coverFlip) img = getFlippedCoverEastImage(coverFrame.img); // safe now: coverFrame.img already confirmed ready above
  } else if (usingSouthWalkPose) {
    // 15TH ROUND (items 6-7): normalize on-screen body size AND foot
    // position across the 3 real source photos — reuses
    // computeBodyVisualScale() verbatim (the SAME normalization COVER/
    // ROID1/ROID2/ADAM SPHERE/ESCAPE already rely on for exactly this
    // "differently-padded source images must read as one consistent body
    // size" problem) rather than a naive fixed width/height scale (item 6
    // explicitly forbids that — canvas size alone does not guarantee
    // matching visible person size). Target height matches the player's
    // own current standing (AIM pose) body height, same formula COVER
    // already uses for standingBodyHeightPx, so SOUTH WALK reads as the
    // same body size as the idle/NORTH-facing poses, not just consistent
    // across its own 3 frames. bodyBottomFrac anchors the foot to the SAME
    // fixed screen point (cx, bottomY) every frame — no vertical jitter on
    // frame switch (item 7).
    const standingBodyHeightPx = ASSETS.player.aim.naturalHeight * baseScale * p.scale;
    const bodyScale = computeBodyVisualScale(southWalkFrame, standingBodyHeightPx);
    drawW = southWalkFrame.img.naturalWidth * bodyScale;
    drawH = southWalkFrame.img.naturalHeight * bodyScale;
    dx = cx - southWalkFrame.bodyCenterXFrac * drawW;
    dy = bottomY - southWalkFrame.bodyBottomFrac * drawH;
  } else {
    drawH = img.naturalHeight * baseScale * p.scale;
    drawW = img.naturalWidth * baseScale * p.scale;
    dx = cx - drawW / 2;
    dy = bottomY - drawH;
  }
  // 5TH ROUND PART 12: short damage-blink — a brief brightness flash on the
  // player sprite the instant real damage lands (see PLAYER_HIT_FLASH_MS /
  // the three resolve*Impact() sites and the CLAW hit-test above). Mirrors
  // the SAME flashing pattern already used for enemy hit feedback
  // (renderEnemy()'s own hitFlashUntil check) — takes visual priority over
  // STEALTH/COVER for its brief duration so "you were just hit" is never
  // masked by another state's own dimming/tinting.
  if (nowTs < p.hitFlashUntil) {
    // 15TH ROUND (items 10-13): "HIT" text is gone entirely (already true
    // since the 5TH ROUND, see resolveSniperImpact()'s own comment) and the
    // generic brightness(2.2) pulse is replaced with a genuine RED blink on
    // the PLAYER sprite itself — a source-atop fill drawn after the normal
    // sprite, so the red only paints the sprite's own opaque silhouette
    // (never a rectangle over the transparent background). Single brief
    // pulse for the whole PLAYER_HIT_FLASH_MS window — non-strobing, and
    // only ever entered on a REAL HP-reducing hit (see resolveSniperImpact/
    // resolveMissileImpact/the CLAW hit-tests: MISS/DODGED/AVOIDED/BLOCKED/
    // DEFENSE never set p.hitFlashUntil), so DAMAGE=0 cases never blink.
    ctx.save();
    drawRedTintedSprite(img, dx, dy, drawW, drawH);
    ctx.restore();
    return;
  }
  if (strength > 0.001) {
    // STEALTH always wins visually over COVER (they must read as clearly
    // distinct states) — the heat-haze distortion effect is unchanged.
    drawPlayerStealthed(img, dx, dy, drawW, drawH, strength, nowTs);
  } else if (p.coverVisual > 0.001) {
    // PART 13 (3rd round): COVER's existing tint/alpha effect — ~10% extra
    // transparency + a subtle dark tint, both scaled by coverVisual (the
    // SAME smoothed isPlayerInCover() target as before, see
    // updatePlayer()) so entering/leaving barrel range fades rather than
    // snapping. Unchanged by the COVER-sprite addition above: it now
    // simply applies to whichever image was chosen (the new crouched
    // COVER pose while usingCoverPose, the normal sprite otherwise) —
    // still deliberately much milder than STEALTH's alpha 0.35 +
    // distortion so the two never look alike.
    ctx.save();
    ctx.globalAlpha = 1 - COVER_ALPHA_DROP * p.coverVisual;
    ctx.filter = `brightness(${(1 - COVER_TINT_STRENGTH * p.coverVisual).toFixed(3)})`;
    ctx.drawImage(img, dx, dy, drawW, drawH);
    ctx.restore();
  } else {
    ctx.drawImage(img, dx, dy, drawW, drawH);
  }
}

// ---------------------------------------------------------------------
// ESCAPE-EXCLUSIVE PLAYER RENDER. A dedicated function (not a branch
// inside renderPlayer() above) — only called from frame() while
// state.gameMode === 'escape'; renderPlayer() itself is never called in
// that case, so the real combat PLAYER sprite (ASSETS.player) can never
// show up during ESCAPE and vice versa.
// ---------------------------------------------------------------------
// NEXT ROUND PART M: shared by the live render AND by afterimage capture
// (updateEscapePlayer()) so a captured ghost is pixel-identical to how the
// real sprite would have drawn at that moment — pure math, no ctx calls.
function computeEscapePlayerDrawRect(cx, bottomY, frame, depthPos, dashScalePulse) {
  const targetBodyHeightPx = ASSETS.player.aim.naturalHeight * (state.cssH / 900) * PLAYER_SCALE_BOOST
    * perspectiveScaleFromDepth(depthPos, ESCAPE_DEPTH_SCALE_RANGE) * dashScalePulse;
  const bodyScale = computeBodyVisualScale(frame, targetBodyHeightPx);
  const drawW = frame.img.naturalWidth * bodyScale;
  const drawH = frame.img.naturalHeight * bodyScale;
  const dx = cx - frame.wheelCenterXFrac * drawW;
  const dy = bottomY - frame.wheelBottomFrac * drawH;
  return { dx, dy, drawW, drawH };
}

function renderEscapePlayer() {
  const p = state.player;
  const es = state.escape;
  const now = performance.now();
  const cx = state.centerX + p.strafeOffset;
  // 12TH ROUND (items 15-17): NORTH/SOUTH depth now moves the player's own
  // screen Y anchor too (not just scale) — es.depthPos>0 (NORTH/far) lifts
  // the anchor UP the screen (subtracts), es.depthPos<0 (SOUTH/near) drops
  // it DOWN, matching the perspective sense computeEnemyDrawRect()/
  // project() already use elsewhere (farther = higher on screen).
  const bottomY = state.cssH * 1.02 - es.depthPos * ESCAPE_DEPTH_SCREEN_RANGE_PX;

  // 11TH ROUND (items 1-4, 7): the 5-frame RUN LOOP replaces the old
  // facing-based (south/west/east) sprite selection entirely — moveX/
  // direction input no longer changes WHICH image shows, only the
  // player's on-screen x position (updateEscapePlayer()), matching item
  // 2's explicit "方向入力しても方向別spriteへ変わらない".
  const frame = ASSETS_PLAYER_ESCAPE_RUN[es.runFrame];
  if (!imgReady(frame.img)) return; // the LOADING gate already guarantees these 5 are loaded before gameStarted; defensive no-op only

  // 11TH ROUND (item 13): uniform visual size across all 5 frames — reuses
  // computeBodyVisualScale() verbatim (the SAME normalization every other
  // *SpriteFrame() table in this file relies on) fed this frame's own real
  // measured bodyTopFrac/bodyBottomFrac, targeting the same LAB-player-
  // relative height the old ESCAPE art used. Because bodyTopFrac/
  // bodyBottomFrac are per-frame real alpha measurements, this makes the
  // rendered body height IDENTICAL (not just close) across all 5 frames —
  // comfortably inside item 4's ±2% cap without a separate breathing pulse
  // (removed — see below).
  // 12TH ROUND (items 15-18): the depth-based PERSPECTIVE SCALE is applied
  // to the shared targetBodyHeightPx baseline BEFORE computeBodyVisualScale()
  // normalizes each of the 5 frames to it — so every frame still lands on
  // the SAME target height at the CURRENT depth (the ±2% cross-frame cap
  // from the 11th round is preserved exactly; only the baseline itself now
  // tracks es.depthPos).
  // 13TH ROUND (item 1): dashScalePulse multiplies ON TOP of the existing
  // depth-based perspective scale — never replaces it — and decays back to
  // 1 on its own (see updateEscapePlayer()), so a South/North DASH reads as
  // a brief +-2% snap layered on whatever depth scale was already in
  // effect, then a clean return to that same normal scale.
  // 11TH ROUND (item 4): the old SOUTH_PULSE_AMPLITUDE (~3%) "breathing"
  // scale pulse is REMOVED for this new loop — it existed only because the
  // old SOUTH pose was a single static image with nothing else to convey
  // motion; the new 5-frame loop already conveys motion by cycling real
  // frames, and item 4 explicitly caps frame-to-frame size variation at
  // ±2%, which a further multiplicative pulse would blow through.
  // Stable anchor: this frame's own measured wheel-bottom/wheel-center-x
  // point (see escapeSpriteFrame()) is pinned to the SAME fixed screen
  // point (cx, bottomY) every frame, regardless of each source image's own
  // padding — so the bike neither grows/shrinks, bounces vertically, nor
  // drifts horizontally when the sprite switches (spec section 3).
  const rect = computeEscapePlayerDrawRect(cx, bottomY, frame, es.depthPos, es.dashScalePulse);

  // NEXT ROUND PART M: draw any live lateral-DASH afterimages BEHIND the
  // real sprite first — real captured PLAYER-sprite ghosts (see
  // updateEscapePlayer()), fading out over ESCAPE_AFTERIMAGE_MS, never a
  // white line/stick (PART O).
  if (es.afterimages.length) {
    es.afterimages = es.afterimages.filter((a) => now < a.until);
    for (const a of es.afterimages) {
      const spawnMs = a.until - now <= ESCAPE_AFTERIMAGE_MS ? ESCAPE_AFTERIMAGE_MS : ESCAPE_AFTERIMAGE_MS * 0.7;
      const lifeFrac = Math.max(0, Math.min(1, (a.until - now) / spawnMs));
      ctx.globalAlpha = lifeFrac * 0.45;
      ctx.drawImage(a.img, a.dx, a.dy, a.drawW, a.drawH);
    }
    ctx.globalAlpha = 1;
  }

  // 11TH ROUND (item 7) / 13TH ROUND (items 7-8): DASH blink — reuses
  // p.invincibleUntil, the SAME i-frame window updateEscapePlayer() sets on
  // any instant DASH (no second blink/invulnerability system). Redesigned
  // this round to be DASH-START-ANCHORED (phase from elapsed-since-dash,
  // never raw wall-clock modulo) with an explicit ESCAPE_DASH_BLINK_CYCLES
  // count, so the number of visible->invisible flashes is deterministic —
  // with CYCLES=1: visible for the first half of ESCAPE_DASH_BLINK_MS, one
  // deliberate fade for the second half, then normal display resumes the
  // instant invincibility ends. Still never long enough to lose track of
  // the player's position, per item 7's original "操作位置が分からなくな
  // るほど長時間消さないでください".
  // NEXT ROUND PART M: this strobe no longer runs for a lateral (WEST/EAST)
  // DASH — es.lateralDashBlinkSuppressUntil covers exactly that window,
  // during which the afterimages above are the DASH's visual tell instead.
  // SOUTH DASH/NORTH BACKSTEP (out of PART M's scope) keep the blink.
  const blinking = now < p.invincibleUntil && now >= es.lateralDashBlinkSuppressUntil;
  if (blinking) {
    const dashStartAt = p.invincibleUntil - ESCAPE_DASH_BLINK_MS;
    const elapsed = now - dashStartAt;
    const cycleMs = ESCAPE_DASH_BLINK_MS / (ESCAPE_DASH_BLINK_CYCLES * 2);
    const phase = Math.floor(elapsed / cycleMs) % 2;
    if (phase === 1) return; // skip this frame's draw — the single "off" half of the blink
  }
  // NEXT ROUND PART N: whole sprite leans around the tire/ground-contact
  // point (cx, bottomY) — pure Canvas transform, no new art — smoothly
  // toward/away from 0 (see es.leanAngle's own update in updateEscapePlayer()).
  ctx.save();
  ctx.translate(cx, bottomY);
  ctx.rotate(es.leanAngle);
  ctx.translate(-cx, -bottomY);
  ctx.drawImage(frame.img, rect.dx, rect.dy, rect.drawW, rect.drawH);
  ctx.restore();
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

  // 5TH ROUND PART 8, extended 7TH ROUND PART 22: CLAW's first reaction
  // window ("GABRIELが点滅") already existed for attackState==='blink' —
  // 7TH ROUND widens this SAME flicker to cover the whole "now actually
  // attacking" window (spec: "攻撃開始〜攻撃成立付近だけに限定") for
  // ADAM/GABRIEL (telegraph=windup tell, impact=the swing landing) and
  // newly adds it for ADAM SPHERE (its own lock/fire/target/impact states —
  // it had no blink effect at all before this round). ROID1/ROID2 are
  // untouched (not in scope this round — see ATTACK_FLASH_TYPES). Reuses
  // the exact same visual (never a second, competing effect) and is
  // explicitly SKIPPED whenever a real hit-flash is already active, so the
  // two never fight for priority on the same frame.
  const attackFlashStates = e.kind === 'claw'
    ? ['blink', 'impact', 'counterApproach']
    : ['lock_red', 'lock_yellow', 'fire', 'lockon', 'target', 'impact'];
  const inAttackFlashWindow = ATTACK_FLASH_TYPES.has(e.type)
    && e.deathState === 'alive' && attackFlashStates.includes(e.attackState);
  // 15TH ROUND (items 15-16): the pre-attack telegraph (right after
  // 'approach' lands, before the swing) is now a genuine SLOW, clearly-
  // countable 2-blink warning — split out of the fast attackFlashStates
  // pulse above ('telegraph'/'counterAttack' removed from that array),
  // which is left untouched for the OTHER claw states (the pre-approach
  // 'blink' tell and the brief 'impact'/'counterApproach' frames — items
  // 15-16 only asked to fix the post-approach telegraph). Phase is
  // anchored to THIS state's own entry time (e.attackUntil - CLAW_WINDUP_MS,
  // the same "recover start time from the deadline" pattern updateEnemy()'s
  // own eased tweens already use), split into 4 equal quarters —
  // lit/dim/lit/dim — so it always resolves to exactly 2 discrete flashes
  // before the swing, never a fast/variable strobe (item 16) and never a
  // random count. Reused verbatim for 'counterAttack' (item 17).
  const inSlowTelegraph = e.kind === 'claw' && e.deathState === 'alive'
    && (e.attackState === 'telegraph' || e.attackState === 'counterAttack');
  // 14TH ROUND (items 25-26): DEFENSE must read as visually distinct from a
  // normal attack-flash pulse — not "HP just didn't move," a real, different
  // look (steady cool-blue tint + a thin guard-glow rim), so the player can
  // tell at a glance "further shots here won't count right now" without
  // reading the HP bar. Deliberately its own branch, never sharing the
  // brightness-pulse attackFlashStates treatment above.
  const inDefense = e.deathState === 'alive' && e.attackState === 'defense';
  if (flashing) {
    // 15TH ROUND (items 11-13): real damage now blinks the ENEMY sprite
    // itself red (see the matching source-atop fill drawn right after the
    // sprite below, after imgReady(rect.img)'s drawImage/fillRect) instead
    // of a generic brightness pulse — gated on `flashing` itself already
    // requiring deathState==='alive', so it can never overlap the
    // exploding/burning death filters above.
  } else if (inDefense) {
    ctx.filter = 'brightness(0.9) saturate(1.4) hue-rotate(175deg)';
  } else if (inSlowTelegraph) {
    const quarterMs = CLAW_WINDUP_MS / 4;
    const stateStartedAt = e.attackUntil - CLAW_WINDUP_MS;
    const elapsed = clamp(now - stateStartedAt, 0, CLAW_WINDUP_MS - 1);
    const quarter = Math.floor(elapsed / quarterMs);
    const lit = quarter === 0 || quarter === 2; // lit, dim, lit, dim -> exactly 2 flashes
    ctx.globalAlpha = lit ? 1 : 0.45;
    ctx.filter = lit ? 'brightness(2.0)' : 'brightness(0.8)';
  } else if (inAttackFlashWindow) {
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

  // 9TH ROUND (item 30-31): ADAM has no real walk-cycle asset (confirmed —
  // see ASSETS.adam / renderer comment above), so rather than fabricate
  // frames or force an unnatural alternating-pose swap, it gets a small,
  // Canvas-only vertical bob + width pulse while NORMAL/STALKING, just
  // enough to read as "alive and approaching" rather than a frozen billboard.
  // GABRIEL needs no such trick — it uses its own real walk[] frames above.
  let bobY = 0, bobScale = 1;
  if (e.type === 'adam' && e.attackState === 'idle') {
    const phase = (now % 700) / 700;
    bobY = Math.sin(phase * Math.PI * 2) * (rect.h * 0.012);
    bobScale = 1 + Math.sin(phase * Math.PI * 2) * 0.012;
  }
  if (imgReady(rect.img)) {
    const w = rect.w * bobScale;
    const h = rect.h;
    if (flashing) {
      ctx.filter = 'none';
      drawRedTintedSprite(rect.img, rect.x - (w - rect.w) / 2, rect.y + bobY, w, h);
    } else {
      ctx.drawImage(rect.img, rect.x - (w - rect.w) / 2, rect.y + bobY, w, h);
    }
  } else {
    ctx.fillStyle = '#334';
    ctx.fillRect(rect.x, rect.y + bobY, rect.w, rect.h);
    if (flashing) {
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = 'rgba(255,40,40,0.65)';
      ctx.fillRect(rect.x, rect.y + bobY, rect.w, rect.h);
    }
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

  if (e.kind === 'claw' && (e.attackState === 'telegraph' || e.attackState === 'impact' || e.attackState === 'counterAttack')) {
    // GABRIEL's melee telegraph is unchanged from before this batch: a
    // simple growing warning ring at the player's position.
    // 14TH ROUND (items 31-39): COUNTER's own windup reuses this exact same
    // warning ring (grown over CLAW_WINDUP_MS, same as a normal telegraph)
    // rather than inventing a second warning visual — a real DASH-avoidable
    // tell, per item 37/spec ("プレイヤーはDASHで回避可能").
    // 16TH ROUND (Part D): the old white/warn-colored STROKE-ONLY ellipse
    // outline (a bare ring, no fill) read as a UI target marker, not an
    // in-world warning — exactly the pattern PART D bans. Replaced with a
    // filled, soft radial-gradient FLOOR GLOW at the same position/size/
    // timing (grow/pulse logic untouched, so the DASH-avoidable warning
    // window is identical) — reads as the floor itself locally brightening
    // ahead of the strike, flashing warm-white right at 'impact', rather
    // than a drawn ring shape.
    const m = playerMarkerPos();
    const tRemain = Math.max(0, e.attackUntil - now);
    const grow = (e.attackState === 'telegraph' || e.attackState === 'counterAttack') ? (1 - tRemain / 700) : 1;
    const isImpact = e.attackState === 'impact';
    const rx = 50 + grow * 20, ry = 16 + grow * 6;
    const pulse = isImpact ? 1 : 0.55 + 0.35 * Math.sin(now * 0.02);
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.scale(1, ry / rx);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(1, rx));
    if (isImpact) {
      grad.addColorStop(0, `rgba(255,250,235,${0.6 * pulse})`);
      grad.addColorStop(0.55, `rgba(255,205,110,${0.4 * pulse})`);
      grad.addColorStop(1, 'rgba(255,205,110,0)');
    } else {
      grad.addColorStop(0, `rgba(255,150,60,${0.34 * pulse})`);
      grad.addColorStop(0.6, `rgba(255,110,40,${0.2 * pulse})`);
      grad.addColorStop(1, 'rgba(255,110,40,0)');
    }
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill();
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
      // 14TH ROUND (items 1-4): the 12TH ROUND's orange/warm glow ellipse +
      // rim + 6 converging light rays (real-device report: "茶色/橙色の楕円
      // +放射状の線", read as a cheap symbolic marker) is gone. Replaced with
      // a plain, brief, pale white/gray semi-transparent floor shadow —
      // still driven by the SAME world-space pipeline (e.missileTargetWorldX/
      // Z -> project() -> e.missileTargetX/Y/Scale, refreshed every tick by
      // refreshMissileTargetScreenPos() from updateEnemy()), so it still sits
      // ON THE FLOOR at the real locked world depth and never tracks the
      // player once locked — only its OWN visual style changed. No rays, no
      // saturated color, no rotation: a single soft ellipse that brightens
      // slightly toward impact, kept deliberately understated because the
      // NEW chain-explosion effect (below, at impact) is where the emphasis
      // now belongs. Scoped to 'missile' kind only (ROID1/ROID2/ADAM SPHERE)
      // — GABRIEL/ADAM's 'claw' telegraph and SNIPER's lock-box/bolt
      // telegraph are both untouched. The PROJECTILE + PROJECTILE SHADOW
      // block right below this is a SEPARATE, pre-existing system (12TH
      // ROUND) and must not be confused with this floor-shadow warning.
      const progress = clamp(1 - (e.attackUntil - now) / MISSILE_TARGET_MS, 0, 1);
      const sc = e.missileTargetScale || 1;
      const rx = (24 + progress * 10) * sc, ry = (9 + progress * 4) * sc;
      const brighten = 0.4 + 0.3 * progress; // brief, understated -- never flickers
      ctx.save();
      ctx.fillStyle = 'rgba(230,230,236,' + (0.28 * brighten) + ')';
      ctx.beginPath();
      ctx.ellipse(e.missileTargetX, e.missileTargetY, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(240,240,245,' + (0.3 + 0.25 * brighten) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(e.missileTargetX, e.missileTargetY, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // 12TH ROUND (items 60-75): the interceptable PROJECTILE + its own
      // PROJECTILE SHADOW — visually DISTINCT from the TARGET AREA above
      // (that's the weapon's broad danger-zone warning; this is the
      // physical falling object and the sharp, dark ground shadow it casts
      // directly beneath itself). Both use the SAME locked world X/Z, so
      // they sit concentric with the TARGET AREA by construction. Skipped
      // once the projectile has been shot down (missileDestroyed).
      if (!e.missileDestroyed && e.missileHeight > 0.5) {
        const pv = getMissileProjectileVisual(e);
        const heightFrac = clamp(e.missileHeight / MISSILE_PROJECTILE_START_HEIGHT, 0, 1);
        ctx.save();
        // SHADOW: a tight, dark, perspective-correct ellipse (never the
        // TARGET AREA's warm glow) — this is what tells the player exactly
        // where the object will land if they don't shoot it down.
        const shadowRx = 16 * pv.scale, shadowRy = 6 * pv.scale;
        ctx.fillStyle = 'rgba(0,0,0,' + (0.55 - 0.15 * heightFrac) + ')';
        ctx.beginPath();
        ctx.ellipse(pv.shadowX, pv.shadowY, shadowRx, shadowRy, 0, 0, Math.PI * 2);
        ctx.fill();

        // A thin connecting line between the object and its shadow reads
        // the closing GAP as altitude drops — never drawn once they're
        // effectively touching.
        if (heightFrac > 0.03) {
          ctx.strokeStyle = 'rgba(255,255,255,0.18)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(pv.x, pv.y);
          ctx.lineTo(pv.shadowX, pv.shadowY);
          ctx.stroke();
        }

        // The falling object itself: a small glowing orb, subtly
        // brightening/pulsing (never flashing) as impact nears.
        const bodyR = 10 * pv.scale;
        const bright = 0.6 + 0.4 * (1 - heightFrac);
        const bodyGrad = ctx.createRadialGradient(pv.x, pv.y, 0, pv.x, pv.y, bodyR * 1.6);
        bodyGrad.addColorStop(0, 'rgba(255,235,190,' + bright + ')');
        bodyGrad.addColorStop(0.6, 'rgba(255,150,60,' + (0.7 * bright) + ')');
        bodyGrad.addColorStop(1, 'rgba(255,90,40,0)');
        ctx.fillStyle = bodyGrad;
        ctx.beginPath();
        ctx.arc(pv.x, pv.y, bodyR * 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(pv.x, pv.y, bodyR * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    return;
  }

  // --- 16TH ROUND PART S: SWEEP FIRE telegraph/tracers ---
  // No LOCK ON ring/gauge/white ellipse/HUD (item 137/143) — the only
  // "telegraph" is a brief muzzle glow while charging (item 138), then each
  // shot's own short tracer + impact flash (item 139/159— never a long
  // white line, never a UI marker).
  if (e.kind === 'sweep') {
    if (e.attackState === 'sweepTelegraph') {
      const gun = screenSpaceEnemyAnchor();
      const grow = clamp(1 - (e.attackUntil - now) / SWEEP_TELEGRAPH_MS, 0, 1);
      ctx.save();
      const grad = ctx.createRadialGradient(gun.x, gun.y - 30, 0, gun.x, gun.y - 30, 18 + grow * 10);
      grad.addColorStop(0, 'rgba(255,225,170,' + (0.5 + 0.4 * grow) + ')');
      grad.addColorStop(1, 'rgba(255,180,90,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(gun.x, gun.y - 30, 18 + grow * 10, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    if (e.sweepTracers && e.sweepTracers.length) {
      ctx.save();
      for (const tr of e.sweepTracers) {
        const life = clamp((tr.until - now) / SWEEP_TRACER_LIFE_MS, 0, 1);
        if (life <= 0) continue;
        ctx.strokeStyle = 'rgba(255,205,120,' + (0.85 * life) + ')';
        ctx.lineWidth = 2;
        ctx.shadowColor = 'rgba(255,170,80,0.7)';
        ctx.shadowBlur = 5;
        ctx.beginPath(); ctx.moveTo(tr.x1, tr.y1); ctx.lineTo(tr.x2, tr.y2); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255,235,190,' + life + ')';
        ctx.beginPath(); ctx.arc(tr.x2, tr.y2, 3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      // pruning (never mutates gameplay state, just this render-list's own
      // expired entries) — keeps the array from growing across a long burst
      e.sweepTracers = e.sweepTracers.filter((tr) => tr.until > now);
    }
    return;
  }

  // --- 16TH ROUND PART S: MULTI MISSILE BARRAGE telegraph ---
  // Each in-flight missile gets the EXACT SAME "understated floor shadow +
  // TARGET AREA glow + small falling orb" visual the single MISSILE attack
  // already uses (see the 'missile'/'target' branch above) — no rotating
  // gauge/LOCK ON ring/white outline (item 148/149), reused per-missile via
  // getBarrageProjectileVisual() so 3-4 can render at once.
  if (e.kind === 'barrage' && e.barrage && e.barrage.length) {
    for (const m of e.barrage) {
      if (m.impacted || m.height <= 0.5) continue;
      const pv = getBarrageProjectileVisual(m);
      const heightFrac = clamp(m.height / MISSILE_PROJECTILE_START_HEIGHT, 0, 1);
      const brighten = 0.4 + 0.3 * (1 - heightFrac);
      ctx.save();
      ctx.fillStyle = 'rgba(230,230,236,' + (0.26 * brighten) + ')';
      ctx.beginPath();
      ctx.ellipse(pv.shadowX, pv.shadowY, 22 * pv.scale, 8 * pv.scale, 0, 0, Math.PI * 2);
      ctx.fill();
      // SHADOW: the actual "something is falling here" tell (item 149-151)
      ctx.fillStyle = 'rgba(0,0,0,' + (0.55 - 0.15 * heightFrac) + ')';
      ctx.beginPath();
      ctx.ellipse(pv.shadowX, pv.shadowY, 14 * pv.scale, 5 * pv.scale, 0, 0, Math.PI * 2);
      ctx.fill();
      if (heightFrac > 0.03) {
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pv.x, pv.y);
        ctx.lineTo(pv.shadowX, pv.shadowY);
        ctx.stroke();
      }
      const bodyR = 9 * pv.scale;
      const bright = 0.6 + 0.4 * (1 - heightFrac);
      const bodyGrad = ctx.createRadialGradient(pv.x, pv.y, 0, pv.x, pv.y, bodyR * 1.6);
      bodyGrad.addColorStop(0, 'rgba(255,235,190,' + bright + ')');
      bodyGrad.addColorStop(0.6, 'rgba(255,150,60,' + (0.7 * bright) + ')');
      bodyGrad.addColorStop(1, 'rgba(255,90,40,0)');
      ctx.fillStyle = bodyGrad;
      ctx.beginPath(); ctx.arc(pv.x, pv.y, bodyR * 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(pv.x, pv.y, bodyR * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    return;
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
      // 16TH ROUND (Part A/B): was 6 FIXED rays drawn from one static
      // point every frame — exactly the "束ねた棒線/アスタリスク" shape
      // explicitly banned this round. A real spark/ember is now a SINGLE
      // glowing dot that genuinely TRAVELS along its own baked vx/vy (set
      // at spawn — see spawnSparkEmber()) and decelerates via the SAME
      // updateParticles() integration 'ishard'/'dashstreak' already use,
      // drawn with a short trailing streak behind its direction of motion
      // — never a symmetric static burst.
      const speed = Math.hypot(pt.vx, pt.vy);
      const trail = Math.min(10, speed * 0.045 + 1.5);
      const ang = Math.atan2(pt.vy, pt.vx);
      ctx.strokeStyle = 'rgba(255,225,150,' + fadeAlpha + ')';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pt.x - Math.cos(ang) * trail, pt.y - Math.sin(ang) * trail);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,' + fadeAlpha + ')';
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2); ctx.fill();
    } else if (pt.type === 'defenseBlock') {
      // 14TH ROUND (items 25-26): DEFENSE/COUNTER's own 0-damage block
      // feedback — a small, brief, cool-blue ring + flat "shield" chord,
      // deliberately never the warm amber 'spark' (which already means "a
      // real hit landed") and never a text/symbol glyph. Fades fast, same
      // lifetime class as 'spark'.
      ctx.strokeStyle = 'rgba(150,195,255,' + fadeAlpha + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 10 + 6 * (1 - fadeAlpha), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(210,230,255,' + fadeAlpha + ')';
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2); ctx.fill();
    } else if (pt.type === 'smoke') {
      // Still used by spawnPlayerImpact() (small bullet-hit puff) — the old
      // 'explosionFlash'/'shockwave' plain-white-circle/outline-ring types
      // that used to sit here were removed in the 16TH ROUND (Part A/B):
      // every real explosion now goes through spawnBlast()/renderBlasts()
      // instead (see their own comments), which already has its own phased
      // CORE FLASH/MAIN BLAST/SHOCKWAVE/SMOKE — nothing spawns those two
      // particle types anymore.
      const growProgress = 1 - fadeAlpha; // 0 at spawn -> 1 at expiry, always >= 0
      ctx.fillStyle = 'rgba(90,90,90,' + fadeAlpha * 0.35 + ')';
      ctx.beginPath(); ctx.arc(pt.x, pt.y, (pt.r || 18) * (1 + growProgress * 0.8), 0, Math.PI * 2); ctx.fill();
    } else if (pt.type === 'dashstreak') {
      // 12TH ROUND (item 47): DASH motion trail — short fading light
      // streaks from the player's position trailing opposite the dash
      // direction, replacing no prior effect (see spawnDashStreak()).
      ctx.strokeStyle = 'rgba(200,230,255,' + (fadeAlpha * 0.8) + ')';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(pt.x, pt.y);
      ctx.lineTo(pt.x2, pt.y2);
      ctx.stroke();
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
    // 11TH ROUND (items 12-13): investigated first — the muzzle FLASH
    // particle already draws BEHIND the player (renderParticles() runs
    // before renderPlayer(), a 7TH ROUND fix, still correct). The actual
    // "effect pasted on top of the body" visual traces to THIS traveling
    // bullet: it necessarily draws AFTER renderPlayer() (so it stays
    // visible against the darkness mask — see renderFlashlightMask()'s own
    // ordering comment, a real constraint this round must not break), so
    // its earliest segment — right as it leaves the muzzle, still
    // overlapping the player's own silhouette — reads as "on top of the
    // body." Fading it in over the first 12% of travel keeps the bullet
    // fully visible for the vast majority of its flight (near the enemy,
    // where it needs to read against the dark corridor) while it starts
    // near-invisible at the muzzle itself, satisfying "emerges near the
    // muzzle, never pasted flat on the body" without touching the
    // darkness-mask ordering this same code protects elsewhere.
    ctx.globalAlpha = Math.min(1, t / 0.12);
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

  // 9TH ROUND (item 22) BUG FIX: this "soft glow near the player's own feet"
  // never reset globalCompositeOperation back to 'source-over' after the
  // flashlight circle above set it to 'destination-out' — so it was ALSO
  // erasing darkness, at a cssW*0.55 radius (nearly the whole phone-landscape
  // screen), regardless of where the flashlight actually pointed. That is
  // the real, verified root cause of "boss/barrels visible without aiming
  // the light at them." Kept as destination-out (it's still meant to soften
  // pure black right at the player's own footing), but shrunk drastically —
  // to roughly the barrel/COVER interaction scale, not screen scale — so it
  // only ever affects the player's immediate footing.
  const ambientR = BARREL_TOUCH_RADIUS_PX * 2.2;
  const ambient = darkCtx.createRadialGradient(
    state.centerX, state.cssH * 0.97, 0,
    state.centerX, state.cssH * 0.97, ambientR
  );
  ambient.addColorStop(0, 'rgba(0,0,0,0.35)');
  ambient.addColorStop(1, 'rgba(0,0,0,0)');
  darkCtx.globalCompositeOperation = 'destination-out';
  darkCtx.fillStyle = ambient;
  darkCtx.beginPath();
  darkCtx.arc(state.centerX, state.cssH * 0.97, ambientR, 0, Math.PI * 2);
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
// 12TH ROUND (items 54-59): the SINGLE source of truth for "the real
// effective-damage point on the current enemy" — for roid1/roid2 that's the
// measured HEAD circle (rect.headX/Y, matching updateBullets()'s own
// headHit check exactly, see below), for every other type it's the same
// body-center circle SHOT already resolves against. isAimOnEffectiveHit()
// (AIM->RED), the FOCUS auto-aim target (updatePlayer()), and LIGHT's own
// follow-target (getFlashlightCenter()) all read from this ONE function —
// they can never disagree about where "the hit point" is, per spec.
function getEffectiveHitPoint(rect) {
  const e = state.enemy;
  if ((e.type === 'roid1' || e.type === 'roid2') && rect.headX != null) {
    return { x: rect.headX, y: rect.headY };
  }
  return { x: rect.cx, y: rect.cy };
}
function isAimOnEffectiveHit() {
  const aim = getAimPoint();
  const rect = computeEnemyDrawRect();
  const e = state.enemy;
  // 14TH ROUND (items 40-41): RED must never show while GABRIEL/ADAM is in
  // DEFENSE/COUNTER — firing right now would deal 0 damage (see
  // updateBullets()'s own isClawBoss gate), and this single shared function
  // is what BOTH manual AIM and FOCUS's own auto-aim target read (FOCUS
  // drives LIGHT/AIM toward getEffectiveHitPoint() but never bypasses this
  // check), so neither path can ever "see through" DEFENSE. Scoped to
  // GABRIEL/ADAM only — ROID1/ROID2's own counter-phase is untouched
  // (item 42; it never checked e.invulnerable here before this round either).
  if ((e.type === 'gabriel' || e.type === 'adam') &&
      (e.attackState === 'defense' || e.attackState === 'counterApproach' || e.attackState === 'counterAttack')) {
    return false;
  }
  // 12TH ROUND (items 60-75, item f): the live falling PROJECTILE is its
  // OWN independently-aimable effective-hit area — checked first so AIM
  // turns RED over it exactly where updateBullets()'s own intercept
  // hit-test (same getMissileProjectileVisual()) will actually register a
  // hit, per the unified effective-hit rule.
  if (e.kind === 'missile' && e.attackState === 'target' && !e.missileDestroyed && e.missileHeight > 1) {
    const pv = getMissileProjectileVisual(e);
    if (Math.hypot(aim.x - pv.x, aim.y - pv.y) <= pv.hitRadius) return true;
  }
  // 11TH ROUND (items 17-19): for roid1/roid2, "effective hit" now means
  // the real measured HEAD circle specifically (a body-only hit deals no
  // damage — see updateBullets()), so the crosshair's white->red feedback
  // must track headHit, not the old body-center circle, to keep this
  // function's own promise ("matches an ACTUAL registered hit") true under
  // the new head-weak-point damage rule. Every other enemy type (no
  // rect.headX) is completely unchanged.
  if ((e.type === 'roid1' || e.type === 'roid2') && rect.headX != null) {
    return Math.hypot(aim.x - rect.headX, aim.y - rect.headY) <= rect.headR;
  }
  return Math.hypot(aim.x - rect.cx, aim.y - rect.cy) <= enemyHitRadius(rect);
}
// 15TH ROUND (items 18-23): root-cause of the long-standing "RED表示され
// ているのに実際は無傷" bug (recurring since the 12TH ROUND per this
// round's spec) — isAimOnEffectiveHit() above only ever checked geometry
// plus GABRIEL/ADAM's DEFENSE/COUNTER-state, but updateBullets()'s REAL
// damage decision (see its own isClawBoss branches below) additionally
// gates on e.damageAimArmed (the 14TH ROUND re-arm rule) AND e.invulnerable
// (ROID1/ROID2's own counter-phase, which isAimOnEffectiveHit() never
// checked at all) — two extra conditions the crosshair silently ignored,
// so it could read "hot" in cases that would actually deal 0 damage. This
// function is the fix: the ONE place that composes ALL THREE real gates,
// in the SAME order updateBullets() itself applies them, so AIM COLOR can
// never again diverge from the real outcome. Never reimplements the
// geometry itself — always defers to isAimOnEffectiveHit() first.
function isEffectiveDamageNow() {
  if (!isAimOnEffectiveHit()) return false;
  const e = state.enemy;
  const isClawBoss = e.type === 'gabriel' || e.type === 'adam';
  if (isClawBoss && !e.damageAimArmed) return false; // item 22: re-arm gate
  if (e.invulnerable) return false; // item 21: ROID counter-phase + any lingering claw-boss invulnerable window
  return true;
}
function renderAimReticle() {
  const aim = getAimPoint();
  // 15TH ROUND (items 18-20): WHITE/RED -> WHITE/YELLOW. YELLOW is now an
  // ABSOLUTE guarantee real damage lands if FIRE is pressed this instant
  // (isEffectiveDamageNow() is exactly updateBullets()'s own real gate
  // composition — see its own comment) — replacing the old RED, which only
  // promised "geometrically over the hit area," not "will actually deal
  // damage," which is what real-device testing kept catching as a lie.
  const hot = isEffectiveDamageNow();
  ctx.save();
  ctx.strokeStyle = hot ? 'rgba(255,214,10,0.95)' : 'rgba(255,255,255,0.9)';
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

  // 10TH ROUND (items 25-26): single AMMO readout, current/MAGAZINE
  // CAPACITY, directly under FOCUS — plus a "RELOADING..." line while
  // reloading so 0-ammo is never a silent dead end on screen. p.reserve is
  // no longer shown in the main HUD (still tracked internally and visible
  // in DEBUG) since a player only ever needs to reason about the
  // magazine during normal play.
  if (p.ammo !== p.lastAmmoBelowHpCount || p.reloading !== p.lastAmmoBelowHpReloading) {
    ammoHudCountEl.textContent = p.ammo;
    ammoHudReloadingEl.hidden = !p.reloading;
    ammoHudReadoutEl.classList.toggle('empty', p.ammo <= 0);
    ammoHudReadoutEl.classList.toggle('low', p.ammo > 0 && p.ammo <= Math.ceil(MAG_SIZE * 0.25));
    p.lastAmmoBelowHpCount = p.ammo;
    p.lastAmmoBelowHpReloading = p.reloading;
  }

  // 9TH ROUND (item 36) / 12TH ROUND (items 48-49): ESCAPE MODE's own
  // SURVIVE MM:SS readout (was "TIME LEFT") — same state.escape.timeLeftSec
  // countdown and triggerClearSequence() trigger, label/format only.
  // Dirty-checked at whole-second granularity like every other HUD write.
  if (state.gameMode === 'escape') {
    const secsLeft = Math.ceil(state.escape.timeLeftSec);
    if (secsLeft !== state.escape.lastTimeLeftDisplayedSec) {
      const mm = String(Math.floor(secsLeft / 60)).padStart(2, '0');
      const ss = String(secsLeft % 60).padStart(2, '0');
      escapeTimeLeftValueEl.textContent = mm + ':' + ss;
      state.escape.lastTimeLeftDisplayedSec = secsLeft;
    }
  }

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

// 9TH ROUND (item 37): ESCAPE-exclusive enemy pursuit oscillation — see the
// full root-cause/design comment on ESCAPE_ENEMY_PURSUIT_MIN_Z above. Only
// ever called from frame()'s ESCAPE branch; COMBAT's own applyForwardDelta()/
// updateEnemy() distance logic never calls this and is completely untouched.
function updateEscapeEnemyPursuit(now) {
  const e = state.enemy;
  if (e.deathState !== 'alive') return;
  // Only while nothing else owns e.z (claw approach/recovery, or any future
  // attack-side z write) — same "idle = free to move" rule COMBAT's own
  // recovery gating uses (see applyForwardDelta()'s isClawIdle).
  if (e.attackState !== 'idle') return;
  const phase = (now % ESCAPE_ENEMY_PURSUIT_PERIOD_MS) / ESCAPE_ENEMY_PURSUIT_PERIOD_MS;
  const mid = (ESCAPE_ENEMY_PURSUIT_MIN_Z + ESCAPE_ENEMY_PURSUIT_MAX_Z) / 2;
  const amp = (ESCAPE_ENEMY_PURSUIT_MAX_Z - ESCAPE_ENEMY_PURSUIT_MIN_Z) / 2;
  e.z = mid - amp * Math.cos(phase * Math.PI * 2); // starts near MAX (falling behind), closes in, retreats, repeats
}

// 9TH ROUND (item 30-35): shared CLEAR SEQUENCE — reachable from COMBAT
// (boss defeated) and ESCAPE (TIME LIMIT hit 0). idempotent: a second call
// while already active is a no-op, so nothing can double-trigger it.
function triggerClearSequence(now, reason) {
  if (state.clearSequence.active) return;
  state.clearSequence.active = true;
  state.clearSequence.phase = 'gateAppear';
  state.clearSequence.phaseStartedAt = now;
  state.clearSequence.reason = reason;
  if (DEBUG_MODE) r10DebugLog('CLEAR SEQUENCE START (' + reason + ')');
}

function clearSequenceResolve(now) {
  // 9TH ROUND note (honest scope disclosure — see completion report item
  // 48): DARKOUT-TPS is a single-arena test-bed prototype with no stage
  // manifest/sequencer (unlike ACTION-GAME's MAIN SCENARIO stage list) — so
  // "transition to the next stage/state" is implemented here as looping
  // back into a fresh encounter of the SAME kind that was just cleared,
  // which is the closest honest equivalent this codebase actually has.
  const reason = state.clearSequence.reason;
  state.clearSequence.active = false;
  state.clearSequence.phase = 'idle';
  state.clearSequence.reason = null;
  if (reason === 'combat') {
    spawnEnemy(state.enemy.type);
  } else if (reason === 'escape') {
    state.escape.timeLeftSec = ESCAPE_TIME_LIMIT_SEC;
  }
  if (DEBUG_MODE) r10DebugLog('CLEAR SEQUENCE COMPLETE (' + reason + ')');
}

function updateClearSequence(now) {
  const cs = state.clearSequence;
  if (!cs.active) return;
  const elapsed = now - cs.phaseStartedAt;
  if (cs.phase === 'gateAppear' && elapsed >= CLEAR_GATE_APPEAR_MS) {
    cs.phase = 'gateOpen'; cs.phaseStartedAt = now;
  } else if (cs.phase === 'gateOpen' && elapsed >= CLEAR_GATE_OPEN_MS) {
    cs.phase = 'playerRun'; cs.phaseStartedAt = now;
  } else if (cs.phase === 'playerRun' && elapsed >= CLEAR_PLAYER_RUN_MS) {
    cs.phase = 'lightExpand'; cs.phaseStartedAt = now;
  } else if (cs.phase === 'lightExpand' && elapsed >= CLEAR_LIGHT_EXPAND_MS) {
    cs.phase = 'whiteOut'; cs.phaseStartedAt = now;
  } else if (cs.phase === 'whiteOut' && elapsed >= CLEAR_WHITEOUT_MS + CLEAR_HOLD_WHITE_MS) {
    clearSequenceResolve(now);
  }
}

// Canvas-only — no new image assets. Drawn as the LAST thing in frame()'s
// render section (after HUD-relevant canvas content, before nothing else),
// so it visually overlays the whole scene. A no-op draw whenever inactive.
function renderClearSequence(now) {
  const cs = state.clearSequence;
  if (!cs.active) return;
  const elapsed = now - cs.phaseStartedAt;
  const w = state.cssW, h = state.cssH;
  const gateCX = state.centerX;
  const gateCY = h * 0.42;
  const gateW = Math.min(w * 0.32, 260);
  const gateH = gateW * 1.5;

  if (cs.phase === 'gateAppear') {
    const t = Math.min(1, elapsed / CLEAR_GATE_APPEAR_MS);
    ctx.save();
    ctx.globalAlpha = t;
    ctx.strokeStyle = '#cfd8e0';
    ctx.lineWidth = 4;
    ctx.strokeRect(gateCX - gateW / 2, gateCY - gateH / 2, gateW, gateH);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(gateCX - gateW / 2 + 3, gateCY - gateH / 2 + 3, gateW - 6, gateH - 6);
    ctx.restore();
  } else if (cs.phase === 'gateOpen' || cs.phase === 'playerRun') {
    const t = cs.phase === 'gateOpen' ? Math.min(1, elapsed / CLEAR_GATE_OPEN_MS) : 1;
    ctx.save();
    // two door halves slide apart, revealing a growing white gap between them
    const doorGap = gateW * 0.5 * t;
    ctx.strokeStyle = '#cfd8e0';
    ctx.lineWidth = 4;
    ctx.strokeRect(gateCX - gateW / 2, gateCY - gateH / 2, gateW, gateH);
    // light spilling through the opening gap
    const glowW = Math.max(1, doorGap * 2);
    const grad = ctx.createLinearGradient(gateCX - glowW / 2, 0, gateCX + glowW / 2, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.95)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(gateCX - glowW / 2, gateCY - gateH / 2 + 3, glowW, gateH - 6);
    // left/right door leaves sliding outward
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(gateCX - gateW / 2 + 3, gateCY - gateH / 2 + 3, gateW / 2 - 3 - doorGap, gateH - 6);
    ctx.fillRect(gateCX + doorGap, gateCY - gateH / 2 + 3, gateW / 2 - 3 - doorGap, gateH - 6);
    if (cs.phase === 'playerRun') {
      // player sprint cue: brighten + scale the existing player draw slightly
      // toward the gate by nudging strafeOffset toward center — purely
      // cosmetic, gameplay input is already frozen (see frame()'s gate).
      const rt = Math.min(1, elapsed / CLEAR_PLAYER_RUN_MS);
      state.player.strafeOffset *= (1 - rt * 0.06);
    }
    ctx.restore();
  } else if (cs.phase === 'lightExpand') {
    const t = Math.min(1, elapsed / CLEAR_LIGHT_EXPAND_MS);
    const r = t * Math.hypot(w, h);
    const grad = ctx.createRadialGradient(gateCX, gateCY, 0, gateCX, gateCY, Math.max(1, r));
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  } else if (cs.phase === 'whiteOut') {
    const t = Math.min(1, elapsed / CLEAR_WHITEOUT_MS);
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,' + t.toFixed(3) + ')';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
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
  // 7TH ROUND PART 11: controllerAimSensitivity multiplies ONLY the
  // gamepad branch — touchAim.x/y (the else branch) is untouched, so the
  // PAUSE setting never affects TOUCH AIM.
  state.input.aimX = gpInput.aim.x !== 0 ? gpInput.aim.x * controllerAimSensitivity : touchAim.x;
  state.input.aimY = gpInput.aim.y !== 0 ? gpInput.aim.y * controllerAimSensitivity : touchAim.y;
  // PART 6: LT/RT + D-PAD manual AIM trim (height/horizontal).
  state.input.aimHeightAdjust = gpInput.aimAdjust.height;
  state.input.aimHorizAdjust = gpInput.aimAdjust.horiz;
  // ESCAPE has zero attack commands (spec section 7) — forced false here,
  // in addition to pollGamepad()'s ESCAPE branch already returning
  // fire:false/focusHeld:false and #touch-fire/#touch-focus being hidden
  // via CSS (body.escape-mode) — defense-in-depth so a single button (e.g.
  // RB, which is both LAB's FIRE and ESCAPE's EAST-dash trigger key) can
  // NEVER produce a LAB combat effect while in ESCAPE, no matter what path
  // set it.
  state.input.fireHeld = state.gameMode === 'escape' ? false : (gpInput.fire || touchFireHeld);
  state.input.focusHeld = state.gameMode === 'escape' ? false : (gpInput.focusHeld || touchFocusHeld);

  const actions = consumeActions();
  // 4th round: PAUSE (gamepad Start / touch PAUSE button) toggles the
  // overlay — see togglePauseMenu(). Checked before the paused-gate below
  // so the SAME frame that opens/closes PAUSE can still toggle it back.
  // Shared by both modes (PAUSE is generic UI, not combat) — untouched.
  if (actions.pauseToggle) togglePauseMenu();

  if (!state.paused) {
    // 9TH ROUND (item 30-35): CLEAR SEQUENCE owns the frame while active —
    // advance its own time-based phase machine, but skip every normal
    // FIRE/MOVE/DASH/RELOAD/COVER/LIGHT/enemy-update call below entirely
    // (no updatePlayer/updateEscapePlayer/updateEnemy/updateBullets/
    // fireWeapon calls at all), so the player can never take damage or fire
    // mid-sequence, and it can never be re-triggered while already active
    // (see triggerClearSequence()'s own guard).
    updateClearSequence(ts);
    if (state.clearSequence.active) {
      // intentionally no gameplay update this frame — render-only below.
    } else if (state.gameMode === 'escape') {
      // ESCAPE: its own dedicated player-update path — still no
      // updatePlayer()/updateBullets()/fireWeapon() call anywhere in this
      // branch, so the PLAYER still has zero attack commands and no shot
      // can ever be fired while this mode is active (unchanged from the
      // ESCAPE round's own spec). 8TH ROUND (real-device feedback item 14):
      // state.enemy itself is NO LONGER fully halted — updateEnemy() now
      // runs here too, so whichever enemy is currently selected (via the
      // existing ENEMY SELECT panel/AUTO MODE — the SAME shared
      // state.enemy object COMBAT already uses, never a separate/invented
      // ESCAPE roster) chases/attacks the player during ESCAPE exactly as
      // it already does in LAB/ARMORED. This is safe to share as-is: e.z
      // was ALREADY being advanced every ESCAPE frame via the unconditional
      // applyForwardDelta() call below (it always touched enemy z, even
      // while updateEnemy() itself was skipped), so resuming updateEnemy()
      // does not require any new position/state bookkeeping — no separate
      // enemy state, no corruption risk.
      const escActions = consumeEscapeActions();
      const forwardDelta = updateEscapePlayer(dt, ts, state.input.moveX, state.input.moveY, escActions);
      applyForwardDelta(forwardDelta); // 12TH ROUND (item 30): BARREL no longer blocks movement — see clampStrafeForBarrels()'s own comment
      updateEnemy(dt, ts);
      updateEscapeEnemyPursuit(ts);
      updateExplosionChain(ts); // 14TH ROUND (items 5-8): outlives the brief attackState impact/cooldown window, so must tick every frame independent of it
      updateParticles(dt); // ESCAPE itself still spawns no particles directly, but the now-active enemy's own attack impacts do (spark/smoke/shockwave) — no longer a pure no-op
      updateBlasts(ts); // 16TH ROUND (Part A/B): the new real-BLAST instances (spawnBlast()) prune themselves independent of attackState, same reasoning as updateExplosionChain() above
      // 9TH ROUND (item 36): real elapsed-time countdown, ticked only while
      // unpaused and the CLEAR SEQUENCE isn't already running (guarded
      // above) — reaching 0 triggers the SAME shared CLEAR SEQUENCE COMBAT
      // uses on boss defeat, per spec's "共通の演出" requirement.
      if (state.escape.timeLeftSec > 0) {
        state.escape.timeLeftSec = Math.max(0, state.escape.timeLeftSec - dt);
        if (state.escape.timeLeftSec <= 0) triggerClearSequence(ts, 'escape');
      }
    } else {
      const forwardDelta = updatePlayer(dt, ts, state.input.moveX, state.input.moveY, actions);
      applyForwardDelta(forwardDelta); // 12TH ROUND (item 30): BARREL no longer blocks movement — see clampStrafeForBarrels()'s own comment
      updateEnemy(dt, ts);
      updateBullets(ts);
      updateGabrielAdamReaim(ts); // 14TH ROUND (items 27-30): must tick every frame, independent of firing, so AIM-moved-away tracking never misses a frame
      updateExplosionChain(ts); // 14TH ROUND (items 5-8): outlives the brief attackState impact/cooldown window, so must tick every frame independent of it
      updateParticles(dt);
      updateBlasts(ts); // 16TH ROUND (Part A/B)

      if (state.input.fireHeld) {
        fireWeapon(ts);
      } else if (DEBUG_MODE && r10DebugState.lastFireLogReason !== null) {
        // 14TH ROUND (items 43-44): FIRE released — clear the edge-tracking
        // state so the NEXT press logs a fresh 'FIRE INPUT', per spec ("FIRE
        // being released" is one of the three things allowed to re-arm the
        // log). fireWeapon() itself is never called while released, so this
        // reset can't live there.
        r10DebugState.lastFireLogReason = null;
      }
    }
  }

  const theme = THEMES[state.theme];
  renderCorridor(theme);
  // 11TH ROUND (item 9): ESCAPE never shows BARRELs — COMBAT's own BARREL/
  // COVER system (renderBarrels()/renderBarrelForeground()/isPlayerInCover()
  // etc.) is completely untouched and still runs exactly as before for
  // state.gameMode==='combat'; this is the ONLY change, a render-time skip
  // gated on GAME MODE (never STAGE TYPE, per the existing decoupling).
  if (state.gameMode !== 'escape') renderBarrels();
  if (state.gameMode === 'escape') {
    // 8TH ROUND (item 14): the enemy is no longer inert here — render it
    // and its attack telegraphs same as COMBAT (item 23: same warning/
    // impact/shockwave quality in both modes). Still no muzzle/tracer/aim
    // reticle — the PLAYER still has no weapon in ESCAPE, only
    // updateBullets()/fireWeapon()/renderBullets()/renderAimReticle() stay
    // excluded.
    renderEnemy(theme);
    renderParticles();
    renderBlasts(); // 16TH ROUND (Part A/B)
    renderEscapePlayer();
    // 9TH ROUND (item 20): ESCAPE MODE has no LIGHT at all — it is a
    // survive-until-TIME-LIMIT mode, not explore-in-darkness, so the
    // darkness mask/flashlight is never drawn here (was previously called
    // unconditionally in this branch, gated only by theme==='escape', which
    // no longer implies gameMode==='escape' now that STAGE TYPE and GAME
    // MODE are decoupled).
    renderEnemyTelegraphs(theme);
  } else {
    renderEnemy(theme);
    // 7TH ROUND PART 18 ("射撃エフェクトが主人公より前面にオーバーレイされ
    // ており不自然"): renderParticles() (the muzzle flash + all other
    // particle types) used to run AFTER renderPlayer(), drawing the flash on
    // top of the player sprite. Swapped so it draws BEFORE the player —
    // background -> 射撃エフェクト -> 主人公, per spec — so the player's own
    // sprite now naturally overlaps/hides part of the flash instead of the
    // reverse.
    renderParticles();
    // 16TH ROUND (Part E, root-cause fix): PLAYER used to draw HERE, before
    // renderFlashlightMask() below — so the mask's own ~0.90-alpha black
    // overlay painted over it like any other world object, dimming the
    // player's own sprite whenever they stood outside the lit circle. Spec:
    // only the WORLD should darken outside LIGHT — the player sprite itself
    // must always read at normal brightness. Root cause was purely draw
    // order (same bug class already fixed for telegraphs/bullets — see
    // their own comments), so the fix is the same: PLAYER now draws ONLY
    // ONCE, after the mask (below), never before it. The barrel-foreground
    // "behind the drum can" redraw moves with it (was previously paired
    // with this now-removed early draw).
    renderFlashlightMask();
    // 16TH ROUND (Part A/B, root-cause fix): a BLAST must read as its own
    // bright, self-illuminating event, not get dimmed into a faint grey
    // smudge by the darkness mask above — same bug class as
    // renderEnemyTelegraphs()/renderBullets() below (drawn-before-the-mask
    // content is ~0.90-alpha darkened outside the lit circle). Moved from
    // its old spot right after renderParticles() (before renderPlayer()) to
    // here, after the mask, so CORE FLASH/MAIN BLAST/sparks/shockwave/smoke
    // stay fully visible regardless of where the flashlight currently
    // points — confirmed via screenshot: the blast was nearly invisible
    // (dim grey, no fire color) until this move.
    renderBlasts();
    // PART 8 (3rd round): renderBullets() (the player's own tracer) must run
    // AFTER the darkness mask, same bug class as renderEnemyTelegraphs()
    // below — otherwise any tracer segment landing outside the lit circle
    // (i.e. away from wherever AIM/FLASHLIGHT currently points) is nearly
    // invisible against the 0.90-alpha overlay, which is why the tracer
    // used to appear to vanish depending on input state.
    renderBullets();
    // 16TH ROUND (Part E): PLAYER's one-and-only draw for this frame — always
    // after the mask/blasts/bullets, so it's never darkened and always sits
    // on top of the tracer (matches the pre-16th-round "player redraws on
    // top of an active bullet" behavior, made unconditional now that there
    // is no earlier pre-mask draw to leave stale underneath).
    // NEXT ROUND PART P: the old renderBarrelForeground() call that used to
    // sit here (redrawing the covering BARREL body a second time, ON TOP of
    // the just-drawn player, for a "barrel occludes player" COVER visual)
    // is removed — real-device reports showed the PLAYER reading as
    // sandwiched behind/between BARRELs. Draw order is now the simplified
    // STAGE/FLOOR -> BARREL -> PLAYER the spec asks for (renderBarrels()
    // already runs once, before renderPlayer(), earlier in this same
    // function) — PLAYER always renders in front. COVER's own gameplay
    // logic (isPlayerInCover()/damage-protection/FIRE-block) is completely
    // untouched — it was always invisible hit-testing, never tied to this
    // now-removed visual redraw.
    renderPlayer(theme);
    // FOLLOWUP FIX: telegraphs (LOCK boxes/▲/target ellipse/bolts) render
    // AFTER the darkness mask so they stay legible as warnings no matter
    // where the flashlight is pointed — see renderEnemyTelegraphs()'s own
    // comment for the bug this fixes.
    renderEnemyTelegraphs(theme);
    renderAimReticle();
  }

  // 9TH ROUND (item 30-35): drawn last so it overlays the whole scene
  // (gate/door/light-expand/WHITE OUT), in both COMBAT and ESCAPE — a
  // genuine no-op draw whenever inactive.
  renderClearSequence(ts);

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

  // 8TH ROUND: DEBUG MODE panel refresh — single top-level gate, so a
  // normal URL never even evaluates r10UpdateDebugPanel()'s body.
  if (state.debugPanelVisible) r10UpdateDebugPanel(ts);
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

// 12TH ROUND (items 6-9): panel visibility is now set once, earlier, by
// setDebugPanelVisible(state.debugPanelVisible) right after it's defined
// (see the PAUSE MENU / DEBUG DISPLAY setup above) — nothing left to do
// here.

start();

window.__darkoutTps = {
  state, THEMES, ASSETS,
  // pure read-only helpers, exposed for automated testing only
  getAimPoint, getFlashlightCenter, computeEnemyDrawRect,
  isPlayerInCover, getStealthStrength, applyAimCurve, playerMarkerPos, barrels,
  isAimOnEffectiveHit, isEffectiveDamageNow, enemyHitRadius, approachZMinForRoid, isRoidActivelyFiring,
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
  // added 7th round: AIM sensitivity, player fire-pose rect, ADAM attack
  // variants, boss-HP/world-height constants — exposed for automated
  // testing only.
  get controllerAimSensitivity() { return controllerAimSensitivity; },
  set controllerAimSensitivity(v) { controllerAimSensitivity = v; },
  AIM_SENSITIVITY_PRESETS, computePlayerDrawRect,
  ENEMY_MAX_HP, ADAM_SPHERE_WORLD_HEIGHT, ROID_WORLD_HEIGHT,
  GABRIEL_Z_MIN, GABRIEL_NORMAL_Z_MIN, ADAM_Z_MIN,
  applyForwardDelta, ATTACK_FLASH_TYPES, fireWeapon,
  // ESCAPE mode — exposed for automated testing only.
  updateEscapePlayer, renderEscapePlayer, consumeEscapeActions,
  computeBodyVisualScale, ASSETS_PLAYER_ESCAPE,
  ESCAPE_AUTO_SCROLL_SPEED, ESCAPE_STRAFE_SPEED, ESCAPE_ANIM_FRAME_MS,
  // COVER ACTION — exposed for automated testing only.
  COVER_HEIGHT_RATIO, getFlippedCoverEastImage,
  // 8TH ROUND: DEBUG MODE — exposed for automated testing only. Read-only
  // diagnostic state; nothing here is ever written FROM a test back into
  // gameplay logic.
  DEBUG_MODE, r10DebugState,
  // 9TH ROUND: STAGE TYPE / GAME MODE independence — exposed for automated
  // testing only.
  setGameMode,
  // 10TH ROUND: real player-bullet-vs-enemy damage path — exposed for
  // automated testing only, so the ROID counter-phase threshold logic can
  // be exercised through the actual code path it lives in (updateBullets())
  // instead of a test faking the resulting state directly.
  updateBullets,
  // 11TH ROUND: ESCAPE run-loop rewrite, enemy attack-frequency multiplier,
  // ROID HEAD WEAK POINT, SOUTH WALK discrete frames — exposed for
  // automated testing only.
  ASSETS_PLAYER_ESCAPE_RUN, applyEscapeMoveCurve,
  ENEMY_ATTACK_FREQ_MULT, enemyAttackFreqMult,
  ESCAPE_DASH_BLINK_MS, ESCAPE_STRAFE_DASH_DISTANCE_PX,
  ESCAPE_SOUTH_DASH_DISTANCE_Z, ESCAPE_NORTH_BACKSTEP_DISTANCE_Z,
  FLASHLIGHT_BASE_RADIUS, FIRE_POSE_SCALE_BOOST,
  // 12TH ROUND: PLAYER PERSPECTIVE, world-space TARGET AREA/PROJECTILE,
  // effective-hit/FOCUS/LIGHT unification — exposed for automated testing
  // only.
  project, perspectiveScaleFromDepth, getEffectiveHitPoint,
  getMissileProjectileVisual, currentPlayerFloorScreenPos,
  refreshMissileTargetScreenPos, setDebugPanelVisible,
  MAG_SIZE, RESERVE_MAX, PLAYER_MAX_HP,
  MISSILE_TARGET_BASE_WORLD_Z, MISSILE_TARGET_WORLD_Z_RANGE,
  MISSILE_PROJECTILE_START_HEIGHT, MISSILE_PROJECTILE_HIT_RADIUS_PX,
  AMBIENT_FLOOR_CRAWL_SPEED, ENEMY_LANE_TRACK_MULT,
  // 16TH ROUND PART S: SWEEP FIRE / MULTI MISSILE BARRAGE — exposed for
  // automated testing only (real-battle simulation + frame capture).
  startSweepAttack, startBarrageAttack, resolveSweepShot, resolveBarrageImpact,
  getBarrageProjectileVisual,
  SWEEP_BULLET_COUNT_MIN, SWEEP_BULLET_COUNT_MAX, SWEEP_BULLET_COUNT_ENHANCED_BONUS,
  SWEEP_BULLET_INTERVAL_MS, SWEEP_HALF_WIDTH_WORLD, SWEEP_HIT_RADIUS_PX, SWEEP_DAMAGE,
  SWEEP_TELEGRAPH_MS, SWEEP_COOLDOWN_MS,
  BARRAGE_LOCKON_MS, BARRAGE_LAUNCH_INTERVAL_MS, BARRAGE_FALL_MS, BARRAGE_COOLDOWN_MS,
  BARRAGE_OFFSET_PATTERN,
  // 13TH ROUND: DASH scale pulse, ESCAPE attack-gate fix, blink-count
  // redesign, LIGHT persistent-position — exposed for automated testing
  // only.
  ESCAPE_DASH_SCALE_PULSE_DECAY_RATE, ESCAPE_DASH_BLINK_CYCLES,
  ESCAPE_ATTACK_FREQ_MULT, LIGHT_MOVE_SPEED_PX_S, updatePlayer,
  // 14TH ROUND: COMBAT autonomous idle-approach, chain-explosion, exploded
  // BARREL SHADOW draw-order, DEBUG log de-spam — exposed for automated
  // testing only.
  ENEMY_IDLE_APPROACH_SPEED, updateExplosionChain, resolveMissileImpact,
  EXPLOSION_CHAIN_COUNT, EXPLOSION_CHAIN_WINDOW_MS,
  // 14TH ROUND: GABRIEL/ADAM DEFENSE/re-aim/COUNTER, BGM retry — exposed for
  // automated testing only.
  updateGabrielAdamReaim, GABRIEL_ADAM_DEFENSE_HIT_CYCLE,
  GABRIEL_ADAM_COUNTER_TOTAL_HITS, GABRIEL_ADAM_DAMAGE_INTERVAL_MS,
  GABRIEL_ADAM_REAIM_THRESHOLD_PX, GABRIEL_ADAM_DEFENSE_MS,
  GABRIEL_ADAM_COUNTER_APPROACH_MS, updateEnemy,
};
