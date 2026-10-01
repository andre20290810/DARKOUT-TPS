# DARKOUT-TPS (prototype)

A pseudo-3D, landscape, Gamepad-first TPS prototype built on the DARK OUT
world/characters. No 3D models — depth is procedural (Canvas 2D perspective
projection) and character art is reused, scaled 2D imagery from the original
DARK OUT (ACTION-GAME) project.

This is a standalone project. It does not read from or write to the
ACTION-GAME repository at runtime; a handful of PNGs were copied once
(read-only) into `assets/` during initial setup.

## Run locally

```
python3 -m http.server 8000
# open http://localhost:8000/index.html
```

Landscape only. Best with a standard-mapping Gamepad (e.g. GameSir); on-screen
touch sticks/buttons are provided as a fallback for testing without one.

## Controls

- D-PAD: move (WEST/EAST strafe, NORTH/SOUTH advance-retreat)
- LEFT STICK: FLASHLIGHT (search)
- RIGHT STICK: AIM (fine aim, clamped inside the flashlight radius)
- RB: FIRE · LB: RELOAD
- RT: EAST DASH · LT: WEST DASH
- B: NORTH DASH (forward) · A: SOUTH DASH (backstep)
- X: STEALTH (toggle) · Y: FLASH (stun pulse)

`?debugPerf` info is always shown in the top debug bar (FPS/frame time/DPR/
gamepad/state). Theme (LAB / ARMORED CORRIDOR / ESCAPE) and enemy
(ROID1 / ROID2 / GABRIEL) can be swapped live via the on-screen buttons —
dev/test controls, not meant for a shipped build.

## Status

Early prototype. Verifies the core interaction loop (movement, dash,
flashlight/aim split, fire/reload, stealth/flash, one enemy with
distance-based scale and a telegraphed attack, three corridor themes) is
playable and holds a stable frame rate. Not a full game.

## GGP Generator v0.1

DARK OUT 2 can be re-skinned and re-balanced from one config file without
touching the engine code.

- `game.json`: the game config. `ggp/ggp-boot.js` reads it, exposes it as
  `window.GGP`, then loads `game.js`. `null` image fields keep the original art.
- `generator.html`: upload player/enemy/background images and a battle BGM,
  set HP/speed/time limit, press PREVIEW to play the result in the frame.
  Uploads stay in the browser only. Needs an http server (not `file://`).

```
python3 -m http.server 8000
# game:      http://localhost:8000/index.html      (uses game.json)
# generator: http://localhost:8000/generator.html
```

| game.json field | engine value it sets |
|---|---|
| `title` | page title + MODE SELECT title (`null` = unchanged) |
| `player.image` | every frame in `assets/player/` and `assets/player_escape/` |
| `player.hp` | `PLAYER_MAX_HP` (default 300) |
| `enemy.image` + `enemy.imageTargets` | every frame of the listed enemies (drone, roid1, roid2, gabriel, adamSphere, adam) |
| `enemy.hp` | `ENEMY_MAX_HP` (default 300; ROID 1/2 stay at 2x) |
| `enemy.speedMultiplier` | x `ENEMY_IDLE_APPROACH_SPEED` and `CLAW_STALK_SPEED` (default 1) |
| `stage.background` | backdrop painted behind the corridor |
| `stage.escapeTimeLimitSec` | `ESCAPE_TIME_LIMIT_SEC` (default 90) |
| `audio.battle` | `#bgm-audio` source |

Replacement images are fitted into each original frame's own canvas size and
measured body box, so sprite scaling and anchoring stay as tuned.
