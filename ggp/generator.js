'use strict';
/*
 * GGP Generator v0.1.
 *
 * The form is only ever turned into ONE game config object (same shape as
 * game.json). PREVIEW hands that object to a fresh DARK OUT 2 instance in
 * the preview frame (index.html?ggp=preview), whose ggp/ggp-boot.js reads it
 * from window.__GGP_PREVIEW_CONFIG__ instead of game.json. Uploaded files
 * stay in this browser as object URLs and disappear with the page.
 */
(function () {
  var FALLBACK_DEFAULT = {
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
  var defaults = FALLBACK_DEFAULT;

  var $ = function (id) { return document.getElementById(id); };
  var form = $('gen-form');
  var frame = $('preview-frame');
  var statusEl = $('preview-status');
  var jsonEl = $('config-json');

  // input id -> { url, name } for the current upload
  var uploads = {};

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function numberOr(id, fallback) {
    var v = parseFloat($(id).value);
    return isFinite(v) && v > 0 ? v : fallback;
  }

  // Form -> game config. The only place the form is read.
  function buildConfig() {
    var c = clone(defaults);
    var title = $('f-title').value.trim();
    c.title = title || defaults.title;
    c.player.image = uploads['f-player-image'] ? uploads['f-player-image'].url : defaults.player.image;
    c.player.hp = Math.round(numberOr('f-player-hp', defaults.player.hp));
    c.enemy.image = uploads['f-enemy-image'] ? uploads['f-enemy-image'].url : defaults.enemy.image;
    var target = $('f-enemy-targets').value;
    c.enemy.imageTargets = target === 'all' ? defaults.enemy.imageTargets.slice() : [target];
    c.enemy.hp = Math.round(numberOr('f-enemy-hp', defaults.enemy.hp));
    c.enemy.speedMultiplier = numberOr('f-enemy-speed', defaults.enemy.speedMultiplier);
    c.stage.background = uploads['f-stage-bg'] ? uploads['f-stage-bg'].url : defaults.stage.background;
    c.stage.escapeTimeLimitSec = Math.round(numberOr('f-stage-time', defaults.stage.escapeTimeLimitSec));
    c.audio.battle = uploads['f-audio-battle'] ? uploads['f-audio-battle'].url : defaults.audio.battle;
    return c;
  }

  function renderJson() {
    var names = {};
    Object.keys(uploads).forEach(function (k) { names[uploads[k].url] = uploads[k].name; });
    jsonEl.textContent = JSON.stringify(buildConfig(), function (k, v) {
      return typeof v === 'string' && names[v] ? 'upload:' + names[v] : v;
    }, 2);
  }

  function fillFromDefaults() {
    $('f-title').value = '';
    $('f-player-hp').value = defaults.player.hp;
    $('f-enemy-hp').value = defaults.enemy.hp;
    $('f-enemy-speed').value = defaults.enemy.speedMultiplier;
    $('f-stage-time').value = defaults.stage.escapeTimeLimitSec;
    $('f-enemy-targets').value = 'all';
  }

  function setUpload(input, file) {
    var box = input.closest('.gen-file');
    var thumb = box.querySelector('.gen-thumb');
    var nameEl = box.querySelector('.gen-filename');
    var clearBtn = box.querySelector('.gen-clear');
    // The previous URL may still be in use by the running preview; it is
    // released when the next PREVIEW replaces that game instance.
    if (uploads[input.id]) pendingRevoke.push(uploads[input.id].url);
    if (file) {
      uploads[input.id] = { url: URL.createObjectURL(file), name: file.name };
    } else {
      delete uploads[input.id];
      input.value = '';
    }
    var u = uploads[input.id];
    if (thumb) { thumb.hidden = !u; if (u) thumb.src = u.url; else thumb.removeAttribute('src'); }
    if (nameEl) { nameEl.hidden = !u; nameEl.textContent = u ? u.name : ''; }
    clearBtn.hidden = !u;
    renderJson();
  }
  var pendingRevoke = [];

  Array.prototype.forEach.call(document.querySelectorAll('.gen-file'), function (box) {
    var input = box.querySelector('input[type=file]');
    input.addEventListener('change', function () { setUpload(input, input.files && input.files[0]); });
    box.querySelector('.gen-clear').addEventListener('click', function () { setUpload(input, null); });
  });
  form.addEventListener('input', renderJson);
  form.addEventListener('change', renderJson);

  var previewCount = 0;
  function preview() {
    var config = buildConfig();
    // Single interface to the engine: the preview frame's boot loader reads
    // exactly this object.
    window.__GGP_PREVIEW_CONFIG__ = config;
    previewCount++;
    var toRevoke = pendingRevoke;
    pendingRevoke = [];
    frame.onload = function () {
      toRevoke.forEach(function (url) { URL.revokeObjectURL(url); });
      statusEl.textContent = 'Preview #' + previewCount + ' running' + (config.title ? ' — ' + config.title : '') +
        '. Click inside the game to give it keyboard focus.';
      try { frame.contentWindow.focus(); } catch (e) { /* cross-origin never happens here */ }
    };
    statusEl.textContent = 'Loading preview #' + previewCount + '…';
    $('preview-empty').hidden = true;
    frame.src = 'index.html?ggp=preview&run=' + previewCount;
    renderJson();
  }

  form.addEventListener('submit', function (e) { e.preventDefault(); preview(); });
  $('reset-btn').addEventListener('click', function () {
    Array.prototype.forEach.call(document.querySelectorAll('.gen-file input[type=file]'), function (input) {
      if (uploads[input.id]) setUpload(input, null);
    });
    fillFromDefaults();
    renderJson();
  });

  // Exposed for automated tests and a future AI step that produces a config
  // directly: GGPGenerator.preview(config) skips the form entirely.
  window.GGPGenerator = {
    buildConfig: buildConfig,
    preview: function (config) {
      if (!config) return preview();
      window.__GGP_PREVIEW_CONFIG__ = config;
      previewCount++;
      $('preview-empty').hidden = true;
      frame.src = 'index.html?ggp=preview&run=' + previewCount;
    },
  };

  fillFromDefaults();
  renderJson();
  fetch('game.json', { cache: 'no-cache' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (json) { defaults = json; fillFromDefaults(); renderJson(); })
    .catch(function () { /* file:// or missing game.json: keep the built-in defaults */ });
})();
