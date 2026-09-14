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
