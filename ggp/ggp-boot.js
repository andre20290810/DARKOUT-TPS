'use strict';
/*
 * GGP (Game Generation Platform) v0.1 — boot loader.
 *
 * Resolves ONE game config, exposes it as window.GGP, applies the parts
 * that live in index.html (title text, battle BGM source), then loads the
 * unchanged game engine (game.js). game.js reads the config only through
 * window.GGP (see ggpNum()/ggpAsset() at the top of game.js).
 *
 * Config source, first match wins:
 *   1. ?ggp=preview inside the Generator's preview frame: the config object
 *      the Generator put on its own window (window.__GGP_PREVIEW_CONFIG__).
 *   2. game.json next to index.html.
 *   3. GGP_DEFAULT_CONFIG below (file:// play from the PC ZIP, where fetch()
 *      of a local file is blocked). Keep it identical to game.json.
 */
(function () {
  var GAME_SCRIPT = 'game.js?v=4';

  var GGP_DEFAULT_CONFIG = {
    ggpVersion: '0.1',
    title: null,
    player: { image: null, hp: 300 },
    enemy: {
      image: null,
      imageTargets: ['drone', 'roid1', 'roid2', 'gabriel', 'adamSphere', 'adam'],
      hp: 300,
      speedMultiplier: 1,
    },
    stage: { background: null, escapeTimeLimitSec: 90 },
    audio: { battle: 'assets/audio/after_the_limits.mp3' },
  };

  // Which original art each config image replaces. Paths are the engine's
  // own asset folders; every file under a folder is swapped for the one
  // uploaded image.
  var PLAYER_ASSET_DIRS = ['assets/player/', 'assets/player_escape/'];
  var ENEMY_ASSET_DIRS = {
    drone: 'assets/drone/',
    roid1: 'assets/roid1/',
    roid2: 'assets/roid2/',
    gabriel: 'assets/gabriel/',
    adamSphere: 'assets/adam_sphere/',
    adam: 'assets/adam/',
  };

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function merge(base, over) {
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    if (!isObj(over)) return out;
    Object.keys(over).forEach(function (k) {
      out[k] = isObj(base[k]) && isObj(over[k]) ? merge(base[k], over[k]) : over[k];
    });
    return out;
  }
  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
  }

  // Draws `upload` into a canvas the size of the original image, contain-
  // fitted into the original's body box and standing on its bottom edge.
  // Results are cached per (upload, size, box): many frames share a size.
  var fitCache = {};
  function fittedUrl(upload, W, H, box) {
    var top = box && typeof box.top === 'number' ? box.top : 0;
    var bottom = box && typeof box.bottom === 'number' ? box.bottom : 1;
    var cx = box && typeof box.centerX === 'number' ? box.centerX : 0.5;
    var key = [upload.src, W, H, top, bottom, cx].join('|');
    if (fitCache[key]) return fitCache[key];
    var boxH = Math.max(1, (bottom - top) * H);
    var boxW = 2 * Math.min(cx, 1 - cx) * W;
    var k = Math.min(boxW / upload.naturalWidth, boxH / upload.naturalHeight);
    var w = upload.naturalWidth * k, h = upload.naturalHeight * k;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').drawImage(upload, cx * W - w / 2, bottom * H - h, w, h);
    fitCache[key] = c.toDataURL('image/png');
    return fitCache[key];
  }

  function makeGGP(config, source, uploads) {
    var overrides = [];
    if (typeof getPath(config, 'player.image') === 'string' && config.player.image) {
      PLAYER_ASSET_DIRS.forEach(function (dir) { overrides.push([dir, config.player.image]); });
    }
    if (typeof getPath(config, 'enemy.image') === 'string' && config.enemy.image) {
      var targets = Array.isArray(config.enemy.imageTargets) ? config.enemy.imageTargets : Object.keys(ENEMY_ASSET_DIRS);
      targets.forEach(function (t) { if (ENEMY_ASSET_DIRS[t]) overrides.push([ENEMY_ASSET_DIRS[t], config.enemy.image]); });
    }
    return {
      version: '0.1',
      source: source,
      config: config,
      // A positive finite number from the config, or the engine's built-in.
      num: function (path, builtIn) {
        var v = getPath(config, path);
        return typeof v === 'number' && isFinite(v) && v > 0 ? v : builtIn;
      },
      // Original asset path -> replacement URL (or the path itself).
      resolveAsset: function (src) {
        for (var i = 0; i < overrides.length; i++) {
          if (src.indexOf(overrides[i][0]) === 0) return overrides[i][1];
        }
        return src;
      },
      // Called by game.js's loadImg() for a replaced file: once the
      // original has loaded (its size is now known), swap in the fitted
      // replacement. The LOADING gate keeps waiting on the same <img>.
      fitOverride: function (img, src, box) {
        var upload = uploads[this.resolveAsset(src)];
        if (!upload) return;
        img.addEventListener('load', function onOriginal() {
          img.removeEventListener('load', onOriginal);
          img.src = fittedUrl(upload, img.naturalWidth, img.naturalHeight, box);
        });
      },
    };
  }

  function applyDom(config) {
    if (typeof config.title === 'string' && config.title.trim()) {
      document.title = config.title;
      var t = document.getElementById('mode-select-title');
      if (t) t.textContent = config.title;
    }
    var bgm = document.getElementById('bgm-audio');
    var battle = getPath(config, 'audio.battle');
    if (bgm && typeof battle === 'string' && battle && bgm.getAttribute('src') !== battle) {
      bgm.setAttribute('src', battle);
      bgm.load();
    }
  }

  // Decodes the replacement character images up front so fitOverride() can
  // draw them synchronously. A file that fails to decode is dropped from the
  // config (the original art is kept) rather than blocking the game.
  function preloadImage(url) {
    return new Promise(function (resolve) {
      var im = new Image();
      im.onload = function () { resolve(im.naturalWidth > 0 ? im : null); };
      im.onerror = function () { console.warn('[GGP] image could not be loaded, keeping original art:', url); resolve(null); };
      im.src = url;
    });
  }

  function start(raw, source) {
    var config = merge(GGP_DEFAULT_CONFIG, raw);
    var uploads = {};
    var keys = ['player', 'enemy'].filter(function (k) { return typeof getPath(config, k + '.image') === 'string' && config[k].image; });
    Promise.all(keys.map(function (k) { return preloadImage(config[k].image); })).then(function (imgs) {
      keys.forEach(function (k, i) {
        if (imgs[i]) uploads[config[k].image] = imgs[i];
        else config[k] = merge(config[k], { image: null });
      });
      window.GGP = makeGGP(config, source, uploads);
      applyDom(config);
      var s = document.createElement('script');
      s.src = GAME_SCRIPT;
      s.async = false;
      document.body.appendChild(s);
    });
  }

  var preview = null;
  try {
    if (new URLSearchParams(window.location.search).get('ggp') === 'preview' && window.parent !== window) {
      preview = window.parent.__GGP_PREVIEW_CONFIG__ || null;
    }
  } catch (e) { preview = null; }
  if (preview) { start(preview, 'preview'); return; }

  if (window.location.protocol === 'file:' || typeof fetch !== 'function') {
    start(null, 'built-in');
    return;
  }
  fetch('game.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (json) { start(json, 'game.json'); })
    .catch(function (err) {
      console.warn('[GGP] game.json not loaded (' + err.message + '), using built-in defaults');
      start(null, 'built-in');
    });
})();
