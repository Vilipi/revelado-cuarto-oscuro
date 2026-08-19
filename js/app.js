/* ============================================================
   Revelado — aplicación
   ============================================================ */

(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };

  var app       = $('#app');
  var stage     = $('#stage');
  var viewport  = $('#viewport');
  var dropzone  = $('#dropzone');
  var panels    = $('#panels');
  var strip     = $('#strip');
  var histCanvas = $('#histogram');
  var filename  = $('#filename');
  var toastEl   = $('#toast');
  var presetNote = $('#preset-note');

  var shelf      = $('#shelf');
  var warpGroup    = $('#group-warp');
  var geoGroup     = $('#group-geo');
  var presetsGroup = $('#shelf-presets');
  var historyGroup = $('#shelf-history');
  var historyList  = $('#history-list');
  var cropLayer  = $('#crop-overlay');
  var cropBox    = $('#crop-box');
  var cropbar    = $('#cropbar');
  var zoombar    = $('#zoombar');
  var viewbar    = $('#viewbar');
  var splitLayer = $('#split-overlay');
  var splitDiv   = $('#split-divider');
  var brushRing  = $('#brush-ring');
  var presetList = $('#preset-list');

  var scopeSeg     = $('#scope-seg');
  var scopeLocal   = $('#scope-local');
  var maskPaintBtn = $('#mask-paint');
  var maskEraseBtn = $('#mask-erase');
  var maskShowBox  = $('#mask-show');
  var maskHint     = $('#mask-hint');

  // Sesión de selección abierta: de "Pintar" a "Aplicar" y viceversa.
  // Independiente del pincel concreto (pintar/borrar) para que alternar
  // entre ambos sin querer no cierre la sesión a medias.
  var maskEditing  = false;

  var fileInput  = $('#file-input');
  var xmpInput   = $('#xmp-input');

  var library = [];       // { id, name, bitmap, thumbUrl, settings }
  var activeId = null;
  var comparing = false;
  var activePreset = null;

  // Pincel de deformación
  var brush = { tool: null, size: 16, strength: 55 };
  var stroke = null;

  // Ajuste local: dónde escriben los sliders y con qué pincel se
  // selecciona la zona. Los dos pinceles se excluyen entre sí.
  var scope = 'global';   // 'global' | 'local'
  var maskBrush = { tool: null, size: 12, strength: 60, feather: 55 };
  var groupSections = {};

  /** El pincel que manda ahora mismo, o null si no hay ninguno activo. */
  function activeBrush() {
    if (maskBrush.tool) return maskBrush;
    if (brush.tool) return brush;
    return null;
  }

  // Encuadre
  var cropping = false;
  var cropDrag = null;
  var panDrag = null;
  var viewRect = { cx: 0.5, cy: 0.5, w: 1, h: 1, pct: 100, fitPct: 100 };

  // Comparación antes/después
  var split = { on: false, x: 0.5 };
  var splitDrag = false;
  var seq = 0;

  var renderer;
  try {
    renderer = new RV.Renderer(viewport);
  } catch (err) {
    dropzone.innerHTML = '<strong>WebGL no está disponible</strong>' +
      '<span>Actívalo en el navegador o prueba en otro equipo.</span>';
    return;
  }

  var controls = {};      // id → { input, valueEl, row }
  var frameQueued = false;
  var histTimer = 0;

  /* ---------- Construcción del panel ---------- */

  RV.GROUPS.forEach(function (group) {
    var section = document.createElement('section');
    section.className = 'group';
    section.dataset.open = 'false';

    var head = document.createElement('button');
    head.className = 'group__head';
    head.type = 'button';
    head.innerHTML = group.label + '<span class="chev" aria-hidden="true">▾</span>';
    head.setAttribute('aria-expanded', 'false');
    head.addEventListener('click', function () {
      var open = section.dataset.open === 'true';
      section.dataset.open = String(!open);
      head.setAttribute('aria-expanded', String(!open));
      // Abrir otro desplegable mientras se está empujando/suavizando/
      // restaurando suelta el pincel: si no, se queda pintando fuera de
      // la vista de Deformar sin que se note.
      if (brush.tool) setTool(null);
    });

    var body = document.createElement('div');
    body.className = 'group__body';

    group.items.forEach(function (adj) {
      body.appendChild(buildControl(adj));
    });

    section.appendChild(head);
    section.appendChild(body);
    panels.insertBefore(section, warpGroup);
    groupSections[group.id] = section;
  });

  /* ---------- Presets ---------- */

  // Estado del preset en curso. `before` es lo que había antes de
  // aplicarlo: sin eso no se puede ni graduar la intensidad ni quitarlo.
  var presetSel = null;   // { id, name, kind, target, before, amount }

  var strengthInput = $('#preset-strength');
  var strengthOut   = $('#preset-strength-val');
  var amountBox     = $('#preset-amount');

  RV.PRESETS.forEach(function (preset) {
    presetList.appendChild(buildPresetRow(preset, 'incluido'));
  });

  function buildPresetRow(preset, kind) {
    var li = document.createElement('li');
    li.className = 'preset-row';

    var b = document.createElement('button');
    b.className = 'preset';
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.dataset.preset = preset.id;
    b.innerHTML = '<b></b><small></small>';
    b.querySelector('b').textContent = preset.name;
    b.querySelector('small').textContent = preset.hint || '';
    b.addEventListener('click', function () { togglePreset(preset, kind); });
    li.appendChild(b);

    if (kind === 'mio') {
      var actions = document.createElement('div');
      actions.className = 'preset-actions';

      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'preset-action';
      save.textContent = '↓';
      save.title = 'Exportar como .xmp';
      save.setAttribute('aria-label', 'Exportar ' + preset.name + ' como .xmp');
      save.addEventListener('click', function (e) { e.stopPropagation(); exportPreset(preset); });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'preset-action preset-action--danger';
      del.textContent = '×';
      del.title = 'Borrar preset';
      del.setAttribute('aria-label', 'Borrar ' + preset.name);
      del.addEventListener('click', function (e) { e.stopPropagation(); deleteUserPreset(preset.id); });

      actions.appendChild(save);
      actions.appendChild(del);
      li.appendChild(actions);
    }
    return li;
  }

  /** Pulsar el preset activo lo quita; pulsar otro lo sustituye. */
  function togglePreset(preset, kind) {
    var img = active();
    if (!img) { toast('Carga una imagen antes de aplicar un preset.', true); return; }

    if (presetSel && presetSel.id === preset.id) { clearPreset(); return; }

    // Un preset se aplica a la foto entera: si el panel estuviera en modo
    // zona, los sliders mostrarían otra cosa que lo que acaba de pasar.
    if (scope === 'local') setScope('global');

    // Cambiar de preset descarta el anterior: la nueva mezcla parte del
    // estado previo a cualquier preset, no del resultado del que había.
    var base = presetSel ? presetSel.before : img.settings;

    presetSel = {
      id: preset.id,
      name: preset.name,
      kind: kind,
      target: RV.applyPreset(preset.values),
      before: Object.assign({}, base),
      amount: 100
    };
    strengthInput.value = 100;
    amountBox.hidden = false;
    applyPresetAmount();
    setActivePreset(preset.id);
    historyPush(img, 'Preset: ' + preset.name);
  }

  /**
   * Mezcla entre lo que había antes y el preset completo. Al 100 % el
   * resultado es exactamente el preset; al 0 %, el estado anterior.
   */
  function applyPresetAmount() {
    var img = active();
    if (!img || !presetSel) return;
    var k = presetSel.amount / 100;

    RV.ALL.forEach(function (adj) {
      var a = presetSel.before[adj.id], b = presetSel.target[adj.id];
      var v = a + (b - a) * k;
      img.settings[adj.id] = adj.decimals ? v : Math.round(v);
    });

    syncPanels();
    markEdited(img);
    requestRender();

    strengthOut.textContent = Math.round(presetSel.amount) + ' %';
    presetNote.hidden = false;
    presetNote.innerHTML = '<b>' + escapeHtml(presetSel.name) + '</b> · ' +
      (presetSel.kind === 'mio' ? 'preset guardado' :
       presetSel.kind === 'xmp' ? 'preset importado' : 'preset incluido') +
      ' al ' + Math.round(presetSel.amount) + ' %';
  }

  function clearPreset() {
    var img = active();
    if (img && presetSel) {
      img.settings = Object.assign({}, presetSel.before);
      syncPanels();
      markEdited(img);
      requestRender();
      historyPush(img, 'Preset quitado');
    }
    presetSel = null;
    amountBox.hidden = true;
    presetNote.hidden = true;
    setActivePreset(null);
  }

  function setActivePreset(id) {
    activePreset = id;
    if (!id) { presetSel = null; amountBox.hidden = true; }
    var rows = document.querySelectorAll('.preset[data-preset]');
    Array.prototype.forEach.call(rows, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.preset === id));
    });
  }

  strengthInput.addEventListener('input', function () {
    if (!presetSel) return;
    presetSel.amount = parseFloat(strengthInput.value);
    applyPresetAmount();
  });
  strengthInput.addEventListener('change', function () {
    var img = active();
    if (!img || !presetSel) return;
    historyPush(img, presetSel.name + ' al ' + Math.round(presetSel.amount) + ' %');
  });

  /* ---- Presets propios ---- */

  // Almacenamiento: la API de artefactos si está, si no el navegador, y
  // si tampoco, sólo la sesión. Guardar nunca debe romper la aplicación.
  var store = {
    read: function () {
      if (window.storage && window.storage.get) {
        return window.storage.get('revelado:presets')
          .then(function (r) { return r ? JSON.parse(r.value) : []; })
          .catch(function () { return []; });
      }
      try {
        return Promise.resolve(JSON.parse(window.localStorage.getItem('revelado:presets') || '[]'));
      } catch (e) { return Promise.resolve([]); }
    },
    write: function (list) {
      var json = JSON.stringify(list);
      if (window.storage && window.storage.set) {
        return window.storage.set('revelado:presets', json).catch(function () {});
      }
      try { window.localStorage.setItem('revelado:presets', json); } catch (e) {}
      return Promise.resolve();
    }
  };

  var userPresets = [];
  var userList = $('#user-preset-list');
  var mineTitle = $('#mine-title');

  function renderUserPresets() {
    userList.innerHTML = '';
    mineTitle.hidden = userPresets.length === 0;
    userPresets.forEach(function (p) {
      userList.appendChild(buildPresetRow(p, 'mio'));
    });
    if (presetSel) setActivePreset(presetSel.id);
  }

  store.read().then(function (list) {
    if (!Array.isArray(list)) return;
    userPresets = list.filter(function (p) { return p && p.id && p.values; });
    renderUserPresets();
  });

  function deleteUserPreset(id) {
    var found = userPresets.filter(function (p) { return p.id === id; })[0];
    userPresets = userPresets.filter(function (p) { return p.id !== id; });
    if (presetSel && presetSel.id === id) clearPreset();
    renderUserPresets();
    store.write(userPresets);
    if (found) toast('Preset «' + found.name + '» borrado.');
  }

  function exportPreset(preset) {
    var out = RV.toXMP(preset.name, RV.applyPreset(preset.values));
    var blob = new Blob([out.text], { type: 'application/rdf+xml' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = safeName(preset.name) + '.xmp';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    toast(out.skipped.length
      ? 'Exportado sin ' + out.skipped.join(', ') + ': Camera Raw no tiene ese ajuste.'
      : 'Preset exportado como ' + safeName(preset.name) + '.xmp');
  }

  /* ---- Guardar los ajustes actuales ---- */

  var presetModal = $('#preset-modal');
  var presetNameInput = $('#preset-name');

  $('#btn-preset-save').addEventListener('click', function () {
    var img = active();
    if (!img) { toast('Carga una imagen para guardar sus ajustes.', true); return; }
    if (RV.isDefault(img.settings)) {
      toast('No hay ningún ajuste que guardar todavía.', true);
      return;
    }
    var touched = RV.ALL.filter(function (a) { return img.settings[a.id] !== a.def; });
    presetNameInput.value = 'Mi preset ' + (userPresets.length + 1);
    $('#preset-modal-meta').textContent = touched.length + ' ajustes · ' +
      touched.slice(0, 4).map(function (a) { return a.label.toLowerCase(); }).join(', ') +
      (touched.length > 4 ? '…' : '');
    presetModal.hidden = false;
    presetNameInput.focus();
    presetNameInput.select();
  });

  function closePresetModal() { presetModal.hidden = true; }

  function saveUserPreset() {
    var img = active();
    if (!img) return;
    var name = String(presetNameInput.value).trim().slice(0, 60) || 'Sin nombre';

    var values = {};
    RV.ALL.forEach(function (a) {
      if (img.settings[a.id] !== a.def) values[a.id] = img.settings[a.id];
    });

    userPresets.push({
      id: 'mio-' + Date.now().toString(36),
      name: name,
      hint: Object.keys(values).length + ' ajustes',
      values: values
    });

    closePresetModal();
    renderUserPresets();
    store.write(userPresets);
    toast('Preset «' + name + '» guardado.');
  }

  $('#preset-cancel').addEventListener('click', closePresetModal);
  $('#preset-confirm').addEventListener('click', saveUserPreset);
  presetModal.addEventListener('click', function (e) { if (e.target === presetModal) closePresetModal(); });
  presetNameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') saveUserPreset();
  });

  /* ---------- Encuadre: zoom, recorte y giros ---------- */

  (function () {
    var head = geoGroup.querySelector('.group__head');
    head.addEventListener('click', function () {
      var open = geoGroup.dataset.open === 'true';
      geoGroup.dataset.open = String(!open);
      head.setAttribute('aria-expanded', String(!open));
      if (brush.tool) setTool(null);
    });
  })();

  // Proporciones
  RV.RATIOS.forEach(function (r) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = r.label;
    b.dataset.ratio = r.id;
    b.setAttribute('aria-pressed', String(r.id === 'libre'));
    b.addEventListener('click', function () {
      var img = active();
      if (!img) return;
      RV.applyRatio(img.geo, img.bitmap.width, img.bitmap.height, r.id);
      syncGeo();
      resize();
      historyPush(img, 'Proporción ' + r.label);
    });
    $('#ratio-seg').appendChild(b);
  });

  // Enderezado: es el único control de este panel con forma de slider.
  var angleInput;
  (function () {
    var row = document.createElement('div');
    row.className = 'ctl';
    row.innerHTML = '<div class="ctl__top"><label class="ctl__label" for="geo-angle">Ángulo</label>' +
                    '<input type="text" class="ctl__val" id="geo-angle-val" ' +
                    'inputmode="decimal" autocomplete="off" aria-label="Ángulo (valor)" value="0.0°"></div>' +
                    '<div class="ctl__track"><input type="range" id="geo-angle" ' +
                    'min="-45" max="45" step="0.1" value="0"></div>';
    angleInput = row.querySelector('#geo-angle');
    var out = row.querySelector('.ctl__val');

    function commitAngle() {
      var img = active();
      if (!img) { out.value = '0.0°'; return; }
      var n = parseFloat(String(out.value).replace(',', '.').replace(/[^0-9.+-]/g, ''));
      if (!isFinite(n)) { syncGeo(); return; }
      var before = img.geo.angle;
      img.geo.angle = RV.clamp(n, -45, 45);
      RV.normalizeCrop(img.geo, img.bitmap.width, img.bitmap.height);
      syncGeo();
      resize();
      if (img.geo.angle !== before) historyPush(img, 'Ángulo ' + img.geo.angle.toFixed(1) + '°');
    }
    out.addEventListener('focus', function () { out.select(); });
    out.addEventListener('blur', commitAngle);
    out.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { commitAngle(); out.blur(); }
      if (e.key === 'Escape') { syncGeo(); out.blur(); }
    });

    angleInput.addEventListener('input', function () {
      var img = active();
      if (!img) { angleInput.value = 0; return; }
      img.geo.angle = parseFloat(angleInput.value);
      RV.normalizeCrop(img.geo, img.bitmap.width, img.bitmap.height);
      out.value = img.geo.angle.toFixed(1) + '°';
      row.classList.toggle('is-dirty', img.geo.angle !== 0);
      markEdited(img);
      resize();
    });
    // Igual que en los sliders de ajuste: el paso al histórico se
    // registra al soltar, no en cada grado que cruza el arrastre.
    angleInput.addEventListener('change', function () {
      var img = active();
      if (!img || !img.history) return;
      if (img.geo.angle !== img.history.current().geo.angle) {
        historyPush(img, 'Ángulo ' + img.geo.angle.toFixed(1) + '°');
      }
    });
    angleInput.addEventListener('dblclick', function () {
      var img = active();
      if (!img || img.geo.angle === 0) return;
      img.geo.angle = 0;
      RV.normalizeCrop(img.geo, img.bitmap.width, img.bitmap.height);
      syncGeo();
      resize();
      historyPush(img, 'Ángulo restablecido');
    });
    angleInput.out = out;
    angleInput.row = row;
    $('#geo-sliders').appendChild(row);
  })();

  function rotate(dir) {
    var img = active();
    if (!img) return;
    var g = img.geo;
    // El recorte se gira con la imagen para que siga encuadrando lo mismo.
    var nx, ny, nw = g.h, nh = g.w;
    if (dir > 0) { nx = 1 - g.y - g.h; ny = g.x; }
    else         { nx = g.y;           ny = 1 - g.x - g.w; }
    g.quarter = (g.quarter + (dir > 0 ? 1 : 3)) % 4;
    g.x = nx; g.y = ny; g.w = nw; g.h = nh;
    RV.normalizeCrop(g, img.bitmap.width, img.bitmap.height);
    syncGeo();
    resize();
    historyPush(img, dir > 0 ? 'Girar a la derecha' : 'Girar a la izquierda');
  }

  $('#rot-left').addEventListener('click', function () { rotate(-1); });
  $('#rot-right').addEventListener('click', function () { rotate(1); });

  $('#flip-h').addEventListener('click', function () {
    var img = active();
    if (!img) return;
    img.geo.flipH = !img.geo.flipH;
    syncGeo();
    requestRender();
    historyPush(img, 'Voltear horizontal');
  });
  $('#flip-v').addEventListener('click', function () {
    var img = active();
    if (!img) return;
    img.geo.flipV = !img.geo.flipV;
    syncGeo();
    requestRender();
    historyPush(img, 'Voltear vertical');
  });

  $('#crop-reset').addEventListener('click', function () {
    var img = active();
    if (!img) return;
    img.geo = RV.defaultGeometry();
    img.view = RV.defaultView();
    syncGeo();
    resize();
    historyPush(img, 'Encuadre restablecido');
  });

  $('#crop-toggle').addEventListener('click', function () { setCropping(!cropping); });
  $('#crop-done').addEventListener('click', function () { setCropping(false); });
  $('#crop-cancel').addEventListener('click', function () { setCropping(false, true); });

  // Encuadre tal y como estaba al entrar, para poder descartar los cambios.
  var cropUndo = null;

  /** `cancel` descarta el encuadre y vuelve al que había al entrar. */
  function setCropping(on, cancel) {
    var img = active();
    if (on && !img) { toast('Carga una imagen antes de recortar.', true); return; }
    var was = cropping;
    cropping = on;
    var toggle = $('#crop-toggle');
    toggle.setAttribute('aria-pressed', String(on));
    toggle.textContent = on ? 'Terminar' : 'Recortar';
    cropLayer.hidden = !on;
    cropbar.hidden = !on;

    if (on) {
      if (!was) cropUndo = img ? Object.assign({}, img.geo) : null;
      setTool(null);
      maskEditing = false;
      setMaskTool(null);
      refreshMaskApply();
      if (split.on) setSplit(false);
      geoGroup.dataset.open = 'true';
      geoGroup.querySelector('.group__head').setAttribute('aria-expanded', 'true');
      if (img) img.view = RV.defaultView();
    } else {
      if (cancel && img && cropUndo) {
        img.geo = cropUndo;
        img.view = RV.defaultView();
        syncGeo();
      } else if (img && cropUndo && (
        img.geo.x !== cropUndo.x || img.geo.y !== cropUndo.y ||
        img.geo.w !== cropUndo.w || img.geo.h !== cropUndo.h
      )) {
        historyPush(img, 'Recortar');
      }
      cropUndo = null;
    }
    resize();
  }

  function syncGeo() {
    var img = active();
    var g = img ? img.geo : RV.defaultGeometry();
    angleInput.value = g.angle;
    angleInput.out.value = g.angle.toFixed(1) + '°';
    angleInput.row.classList.toggle('is-dirty', g.angle !== 0);
    $('#flip-h').setAttribute('aria-pressed', String(!!g.flipH));
    $('#flip-v').setAttribute('aria-pressed', String(!!g.flipV));
    Array.prototype.forEach.call($('#ratio-seg').children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.ratio === g.ratio));
    });
    if (img) {
      var out = RV.outputSize(g, img.bitmap.width, img.bitmap.height);
      $('#geo-meta').textContent = 'Resultado: ' + out.w + ' × ' + out.h + ' px' +
        (g.quarter ? ' · girada ' + (g.quarter * 90) + '°' : '');
      markEdited(img);
    } else {
      $('#geo-meta').textContent = '';
    }
  }

  /* ---- Capa de recorte ---- */

  // En modo recorte se dibuja el fotograma entero y el rectángulo se
  // superpone en HTML: así se ve lo que se deja fuera.
  function layoutCropLayer() {
    var img = active();
    if (!cropping || !img) return;
    var r = viewport.getBoundingClientRect();
    var s = stage.getBoundingClientRect();
    cropLayer.style.left = (r.left - s.left) + 'px';
    cropLayer.style.top = (r.top - s.top) + 'px';
    cropLayer.style.width = r.width + 'px';
    cropLayer.style.height = r.height + 'px';

    var g = img.geo;
    cropBox.style.left = (g.x * 100) + '%';
    cropBox.style.top = (g.y * 100) + '%';
    cropBox.style.width = (g.w * 100) + '%';
    cropBox.style.height = (g.h * 100) + '%';
  }

  Array.prototype.forEach.call(cropBox.querySelectorAll('.crop-handle'), function (h) {
    h.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      startCropDrag(e, h.dataset.handle);
    });
  });
  cropBox.addEventListener('pointerdown', function (e) { startCropDrag(e, 'move'); });

  function startCropDrag(e, handle) {
    var img = active();
    if (!img) return;
    e.preventDefault();
    var r = cropLayer.getBoundingClientRect();
    cropDrag = {
      handle: handle,
      rect: r,
      startX: e.clientX,
      startY: e.clientY,
      geo: { x: img.geo.x, y: img.geo.y, w: img.geo.w, h: img.geo.h }
    };
    cropLayer.setPointerCapture(e.pointerId);
  }

  function moveCropDrag(e) {
    var img = active();
    if (!cropDrag || !img) return;
    var d = cropDrag;
    var dx = (e.clientX - d.startX) / d.rect.width;
    var dy = (e.clientY - d.startY) / d.rect.height;
    var g = img.geo;
    var o = d.geo;

    if (d.handle === 'move') {
      g.x = o.x + dx;
      g.y = o.y + dy;
    } else {
      var left = o.x, top = o.y, right = o.x + o.w, bottom = o.y + o.h;
      if (d.handle.indexOf('w') !== -1) left = Math.min(o.x + dx, right - 0.02);
      if (d.handle.indexOf('e') !== -1) right = Math.max(o.x + o.w + dx, left + 0.02);
      if (d.handle.indexOf('n') !== -1) top = Math.min(o.y + dy, bottom - 0.02);
      if (d.handle.indexOf('s') !== -1) bottom = Math.max(o.y + o.h + dy, top + 0.02);
      g.x = left; g.y = top; g.w = right - left; g.h = bottom - top;

      // Con proporción fija se recalcula el lado libre desde el anclado.
      var ratio = RV.RATIOS.filter(function (r) { return r.id === g.ratio; })[0];
      if (ratio && ratio.value !== null) {
        var im = RV.oriented(g, img.bitmap.width, img.bitmap.height);
        var target = ratio.value === 'orig' ? img.bitmap.width / img.bitmap.height : ratio.value;
        if (im.w < im.h && target > 1) target = 1 / target;
        var wpx = g.w * im.w;
        var hpx = wpx / target;
        var nh = hpx / im.h;
        if (d.handle.indexOf('n') !== -1) g.y = (g.y + g.h) - nh;
        g.h = nh;
      }
    }

    RV.normalizeCrop(g, img.bitmap.width, img.bitmap.height);
    layoutCropLayer();
    syncGeo();
  }

  cropLayer.addEventListener('pointermove', moveCropDrag);
  cropLayer.addEventListener('pointerup', function () { cropDrag = null; resize(); });
  cropLayer.addEventListener('pointercancel', function () { cropDrag = null; });

  /* ---- Zoom ---- */

  function setZoom(z, anchor) {
    var img = active();
    if (!img || cropping) return;
    if (z !== 'fit') {
      z = Math.max(RV.ZOOM_STEPS[0], Math.min(RV.ZOOM_STEPS[RV.ZOOM_STEPS.length - 1], z));
      if (z <= viewRect.fitPct + 0.5) z = 'fit';
    }
    if (anchor && z !== 'fit') {
      // Mantener bajo el puntero el mismo punto de la imagen.
      img.view.cx = viewRect.cx + (anchor.x - 0.5) * viewRect.w;
      img.view.cy = viewRect.cy + (anchor.y - 0.5) * viewRect.h;
    }
    img.view.zoom = z;
    resize();
  }

  function stepZoom(dir) {
    var current = viewRect.pct;
    var steps = RV.ZOOM_STEPS;
    if (dir > 0) {
      for (var i = 0; i < steps.length; i++) if (steps[i] > current + 0.5) return setZoom(steps[i]);
      setZoom(steps[steps.length - 1]);
    } else {
      for (var j = steps.length - 1; j >= 0; j--) if (steps[j] < current - 0.5) return setZoom(steps[j]);
      setZoom('fit');
    }
  }

  $('#zoom-in').addEventListener('click', function () { stepZoom(1); });
  $('#zoom-out').addEventListener('click', function () { stepZoom(-1); });
  $('#zoom-pct').addEventListener('click', function () {
    var img = active();
    if (!img) return;
    setZoom(img.view.zoom === 'fit' ? 100 : 'fit');
  });

  stage.addEventListener('wheel', function (e) {
    var img = active();
    if (!img || cropping) return;
    e.preventDefault();
    var r = viewport.getBoundingClientRect();
    var anchor = {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height
    };
    var factor = e.deltaY < 0 ? 1.25 : 0.8;
    var base = viewRect.pct;
    setZoom(base * factor, anchor);
  }, { passive: false });

  function canPan() {
    return !cropping && !activeBrush() && viewRect.w < 0.999;
  }

  function syncZoombar() {
    var img = active();
    zoombar.hidden = !img || cropping;
    viewbar.hidden = !img || cropping;
    $('#zoom-pct').textContent = !img ? 'Ajustar'
      : (img.view.zoom === 'fit' ? 'Ajustar' : Math.round(viewRect.pct) + ' %');
    app.classList.toggle('is-panning', canPan());
  }

  /* ---------- Comparación con divisoria ---------- */

  function setSplit(on) {
    var img = active();
    if (on && !img) { toast('Carga una imagen para comparar.', true); return; }
    split.on = !!on && !cropping;
    $('#split-toggle').setAttribute('aria-pressed', String(split.on));
    splitLayer.hidden = !split.on;
    renderer.setSplit(split.on ? split.x : -1);
    layoutSplit();
    requestRender();
  }

  function layoutSplit() {
    if (!split.on || !active()) return;
    var r = viewport.getBoundingClientRect();
    var st = stage.getBoundingClientRect();
    splitLayer.style.left = (r.left - st.left) + 'px';
    splitLayer.style.top = (r.top - st.top) + 'px';
    splitLayer.style.width = r.width + 'px';
    splitLayer.style.height = r.height + 'px';
    splitDiv.style.left = (split.x * 100) + '%';
  }

  splitDiv.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    splitDrag = true;
    splitLayer.setPointerCapture(e.pointerId);
  });

  splitLayer.addEventListener('pointermove', function (e) {
    if (!splitDrag) return;
    var r = splitLayer.getBoundingClientRect();
    split.x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    splitDiv.style.left = (split.x * 100) + '%';
    renderer.setSplit(split.x);
    requestRender();
  });

  function endSplitDrag() { splitDrag = false; }
  splitLayer.addEventListener('pointerup', endSplitDrag);
  splitLayer.addEventListener('pointercancel', endSplitDrag);

  $('#split-toggle').addEventListener('click', function () { setSplit(!split.on); });

  /* ---------- Pincel de deformación ---------- */

  // El tamaño va en escala logarítmica: entre el 0,3 % y el 60 % del
  // lado corto hay un factor 200, y en escala lineal el extremo fino
  // quedaría aplastado en los primeros píxeles del slider.
  var SIZE_MIN = 0.3, SIZE_MAX = 60;

  function sizeFromSlider(v) {
    return SIZE_MIN * Math.pow(SIZE_MAX / SIZE_MIN, (v - 1) / 99);
  }
  function sliderFromSize(pct) {
    return 1 + 99 * Math.log(pct / SIZE_MIN) / Math.log(SIZE_MAX / SIZE_MIN);
  }

  var BRUSH_SLIDERS = [
    {
      key: 'size', label: 'Tamaño', min: 1, max: 100, step: 1,
      toSlider: sliderFromSize,
      fromSlider: sizeFromSlider,
      // En píxeles se entiende mucho mejor que en porcentaje.
      format: function () {
        var img = active();
        if (!img) return brush.size.toFixed(1) + ' %';
        return Math.max(1, Math.round(brushScreenPx(img))) + ' px';
      }
    },
    {
      key: 'strength', label: 'Fuerza', min: 5, max: 100, step: 1,
      format: function () { return Math.round(brush.strength) + ''; }
    }
  ];

  /**
   * Monta los sliders de un pincel. `state` es el objeto que guarda sus
   * valores y `prefix` evita que los ids choquen entre los dos pinceles.
   */
  function buildBrushSliders(defs, state, container, prefix) {
    defs.forEach(function (def) {
      var row = document.createElement('div');
      row.className = 'ctl is-dirty';
      row.innerHTML = '<div class="ctl__top"><label class="ctl__label"></label>' +
                      '<span class="ctl__val"></span></div>' +
                      '<div class="ctl__track"><input type="range"></div>';
      var input = row.querySelector('input');
      var out = row.querySelector('.ctl__val');
      row.querySelector('.ctl__label').textContent = def.label;
      row.querySelector('.ctl__label').htmlFor = prefix + def.key;
      row.querySelector('.ctl__track').style.setProperty('--detent', '-10px');
      input.id = prefix + def.key;
      input.min = def.min; input.max = def.max; input.step = def.step;
      input.value = def.toSlider ? def.toSlider(state[def.key]) : state[def.key];
      out.textContent = def.format();

      input.addEventListener('input', function () {
        var raw = parseFloat(input.value);
        state[def.key] = def.fromSlider ? def.fromSlider(raw) : raw;
        out.textContent = def.format();
        if (lastPointer) moveRing(lastPointer.x, lastPointer.y);
      });

      def.refresh = function () { out.textContent = def.format(); };
      container.appendChild(row);
    });
  }

  buildBrushSliders(BRUSH_SLIDERS, brush, $('#warp-sliders'), 'brush-');

  var MASK_SLIDERS = [
    {
      key: 'size', label: 'Tamaño', min: 1, max: 100, step: 1,
      toSlider: sliderFromSize,
      fromSlider: sizeFromSlider,
      format: function () {
        var img = active();
        if (!img) return maskBrush.size.toFixed(1) + ' %';
        return Math.max(1, Math.round(brushScreenPx(img, maskBrush))) + ' px';
      }
    },
    {
      key: 'strength', label: 'Flujo', min: 5, max: 100, step: 1,
      format: function () { return Math.round(maskBrush.strength) + ''; }
    },
    {
      key: 'feather', label: 'Difuminado', min: 0, max: 100, step: 1,
      format: function () { return Math.round(maskBrush.feather) + ''; }
    }
  ];

  buildBrushSliders(MASK_SLIDERS, maskBrush, $('#mask-sliders'), 'maskbrush-');

  /* ---------- Ajuste local ---------- */

  /**
   * Los ajustes de la zona, o null si no hay nada que mezclar. Devolver
   * null cuando la selección está vacía o los valores están en reposo
   * no es sólo cosmético: le ahorra al shader evaluar el revelado dos
   * veces por píxel.
   */
  function localFor(img) {
    if (!img.local.field || img.local.field.isEmpty()) return null;
    if (RV.isLocalDefault(img.local.settings)) return null;
    return img.local.settings;
  }

  function setScope(next) {
    scope = next === 'local' ? 'local' : 'global';
    app.classList.toggle('is-local', scope === 'local');
    scopeLocal.hidden = scope !== 'local';

    Array.prototype.forEach.call(scopeSeg.children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.scope === scope));
    });

    // En modo zona sólo Luz, Color y Detalle tienen sentido: Encuadre y
    // Deformar cambian la foto entera, y Efectos no admite versión local.
    // En vez de dejarlos atenuados, se quitan del todo — no hay nada
    // que hacer ahí mientras se pinta una selección.
    Object.keys(groupSections).forEach(function (id) {
      var off = scope === 'local' && RV.LOCAL_GROUPS.indexOf(id) === -1;
      markGroupOff(groupSections[id], off);
    });
    markGroupOff(geoGroup, scope === 'local');
    markGroupOff(warpGroup, scope === 'local');
    if (scope === 'local') {
      warpGroup.dataset.open = 'false';
      warpGroup.querySelector('.group__head').setAttribute('aria-expanded', 'false');
    }

    if (scope === 'local') {
      var img = active();
      setTool(null);
      // Entrar en modo pincel no empieza a pintar solo: hay que pulsar
      // "Pintar" a propósito antes de que el trazo toque la foto.
      if (img) renderer.setMask(img.local.field || null);
      // Por defecto se ve la zona: es la ayuda visual que explica dónde
      // va a caer el retoque, y sin ella el modo pincel es más difícil
      // de seguir a ciegas.
      maskShowBox.checked = true;
      renderer.setShowMask(true);
    } else {
      // Salir del modo Pincel sin haber pulsado "Aplicar" no debe dejar
      // una zona a medio pintar colgando fuera del modo que la creó: se
      // fija sola, igual que si se hubiera pulsado el botón.
      applyPendingZone(active());
      maskEditing = false;
      setMaskTool(null);
      maskShowBox.checked = false;
      renderer.setShowMask(false);
    }

    refreshMaskHint();
    syncPanels();
    requestRender();
  }

  /**
   * Fija la zona pendiente si hay algo que fijar, o la descarta en
   * silencio si se pintó sin tocar ningún ajuste. La usan tanto el botón
   * "Aplicar" como el cambio de ámbito a "Toda la foto".
   */
  function applyPendingZone(img) {
    if (!img) return;
    var local = localFor(img);
    if (local) {
      var maskSnap = img.local.field.snapshotData();
      if (!renderer.bakeLocal(img.id, local)) {
        toast('No se ha podido fijar el ajuste de la zona.', true);
        return;
      }
      img.baked = true;
      img.local.settings = RV.localDefaults();
      img.local.field.snapshot();
      img.local.field.clear();
      renderer.setMask(img.local.field);
      markEdited(img);
      toast('Zona aplicada.');
      historyPush(img, 'Zona aplicada', { mask: maskSnap, local: cloneSettings(local) });
    } else if (img.local.field && !img.local.field.isEmpty()) {
      img.local.field.snapshot();
      img.local.field.clear();
      renderer.setMask(img.local.field);
    }
  }

  /** Quita un grupo entero del panel mientras no tiene sentido usarlo. */
  function markGroupOff(section, off) {
    section.hidden = off;
    // `hidden` ya lo saca del tabulador, pero se desactivan los controles
    // igualmente por si algún estilo lo volviera a mostrar sin querer.
    var controls = section.querySelectorAll('.group__body button, .group__body input');
    Array.prototype.forEach.call(controls, function (el) { el.disabled = off; });
  }

  function refreshMaskHint() {
    refreshMaskApply();
    var img = active();
    if (!img) { maskHint.textContent = 'Carga una imagen para seleccionar una zona.'; return; }
    var field = img.local.field;
    if (!field || field.isEmpty()) {
      maskHint.textContent = 'Pinta sobre la foto para elegir la zona. Después, los ' +
                             'ajustes de luz, color y detalle sólo actuarán ahí.';
      return;
    }
    var pct = Math.round(field.coverage() * 100);
    maskHint.textContent = (pct < 1
      ? 'Seleccionado menos del 1 % de la foto.'
      : 'Seleccionado el ' + pct + ' % de la foto.') +
      ' Lo que ajustes aquí se suma a lo de toda la foto.';
  }

  Array.prototype.forEach.call(scopeSeg.children, function (b) {
    b.addEventListener('click', function () { setScope(b.dataset.scope); });
  });

  (function () {
    var head = $('#mask-head');
    head.addEventListener('click', function () {
      var open = scopeLocal.dataset.open !== 'false';
      scopeLocal.dataset.open = String(!open);
      head.setAttribute('aria-expanded', String(!open));
    });
  })();

  /**
   * "Pintar" abre la sesión de selección: activa el pincel y se convierte
   * en "Aplicar". Pulsarlo de nuevo (ya como "Aplicar") fija la zona, la
   * borra para la siguiente y cierra la sesión. Repetir el ciclo es el
   * flujo normal para retocar varias zonas seguidas.
   */
  maskPaintBtn.addEventListener('click', function () {
    if (maskEditing) {
      applyPendingZone(active());
      maskEditing = false;
      setMaskTool(null);
    } else {
      maskEditing = true;
      setMaskTool('paint');
    }

    syncPanels();
    refreshMaskHint();
    requestRender();
  });

  // Borrar sólo tiene sentido dentro de una sesión abierta: alterna con
  // pintar para corregir sin cerrar la selección en curso.
  maskEraseBtn.addEventListener('click', function () {
    setMaskTool(maskBrush.tool === 'erase' ? 'paint' : 'erase');
  });

  maskShowBox.addEventListener('change', function () {
    renderer.setShowMask(maskShowBox.checked);
    requestRender();
  });

  $('#mask-all').addEventListener('click', function () {
    var img = active();
    if (!img) return;
    var mask = maskFor(img);
    mask.snapshot();
    mask.fill();
    afterMaskEdit(img);
  });

  $('#mask-invert').addEventListener('click', function () {
    var img = active();
    if (!img || !img.local.field) { toast('Todavía no hay ninguna zona seleccionada.', true); return; }
    img.local.field.snapshot();
    img.local.field.invert();
    afterMaskEdit(img);
  });

  $('#mask-clear').addEventListener('click', function () {
    var img = active();
    if (!img || !img.local.field) return;
    img.local.field.snapshot();
    img.local.field.clear();
    afterMaskEdit(img);
  });

  /**
   * Refleja la sesión de selección en los botones: mientras está abierta
   * (tras pulsar "Pintar"), aparece "Borrar" y el propio botón pasa a
   * "Aplicar"; cerrada, vuelve a "Pintar" y "Borrar" se oculta.
   */
  function refreshMaskApply() {
    maskEraseBtn.hidden = !maskEditing;
    maskPaintBtn.textContent = maskEditing ? 'Aplicar' : 'Pintar';
  }


  function afterMaskEdit(img) {
    renderer.setMask(img.local.field);
    markEdited(img);
    refreshMaskHint();
    refreshMaskApply();
    requestRender();
  }

  function maskUndo() {
    var img = active();
    if (!img || !img.local.field || !img.local.field.undo()) {
      toast('No queda ningún trazo de selección que deshacer.');
      return;
    }
    afterMaskEdit(img);
  }

  (function () {
    var head = warpGroup.querySelector('.group__head');
    head.addEventListener('click', function () {
      var open = warpGroup.dataset.open === 'true';
      warpGroup.dataset.open = String(!open);
      head.setAttribute('aria-expanded', String(!open));
    });
  })();

  // Presets e Histórico comparten la balda izquierda como dos secciones
  // apiladas: cada una se pliega por su cuenta, y las dos pueden estar
  // abiertas a la vez repartiéndose el alto disponible.
  [presetsGroup, historyGroup].forEach(function (section) {
    var head = section.querySelector('.group__head');
    head.addEventListener('click', function () {
      var open = section.dataset.open === 'true';
      section.dataset.open = String(!open);
      head.setAttribute('aria-expanded', String(!open));
      if (brush.tool) setTool(null);
    });
  });

  var TOOLS = { push: $('#tool-push'), smooth: $('#tool-smooth'), restore: $('#tool-restore') };

  Object.keys(TOOLS).forEach(function (name) {
    TOOLS[name].addEventListener('click', function () { setTool(brush.tool === name ? null : name); });
  });

  function setTool(name) {
    brush.tool = name;
    Object.keys(TOOLS).forEach(function (k) {
      TOOLS[k].setAttribute('aria-pressed', String(k === name));
    });
    // Deformar y seleccionar usan el mismo gesto sobre la foto: sólo
    // puede haber un pincel en la mano.
    if (name) setMaskTool(null);
    app.classList.toggle('is-brushing', !!activeBrush());
    if (name) {
      warpGroup.dataset.open = 'true';
      warpGroup.querySelector('.group__head').setAttribute('aria-expanded', 'true');
    }
  }

  function setMaskTool(name) {
    maskBrush.tool = name;
    maskPaintBtn.setAttribute('aria-pressed', String(name === 'paint'));
    maskEraseBtn.setAttribute('aria-pressed', String(name === 'erase'));
    if (name) {
      brush.tool = null;
      Object.keys(TOOLS).forEach(function (k) {
        TOOLS[k].setAttribute('aria-pressed', 'false');
      });
    }
    app.classList.toggle('is-brushing', !!activeBrush());
  }

  /** Crea el campo de deformación de la imagen activa la primera vez. */
  function warpFor(img) {
    if (!img.warp) {
      img.warp = new RV.WarpField(renderer.gl, img.bitmap.width, img.bitmap.height);
    }
    renderer.setWarp(img.warp);
    return img.warp;
  }

  /**
   * Radio del pincel en píxeles de la imagen. El tamaño del pincel es
   * fijo en pantalla: al acercar el zoom se ve menos imagen, así que el
   * radio en píxeles de imagen se reduce en la misma proporción y el aro
   * nunca cambia de tamaño.
   */
  function brushRadiusPx(img, b) {
    b = b || activeBrush() || brush;
    var out = RV.outputSize(img.geo, img.bitmap.width, img.bitmap.height);
    return (b.size / 100) * Math.min(out.w, out.h) * viewRect.w;
  }

  /** Píxeles de pantalla por píxel de imagen, contando recorte y zoom. */
  function viewScale(img) {
    var r = viewport.getBoundingClientRect();
    var out = RV.outputSize(img.geo, img.bitmap.width, img.bitmap.height);
    if (!r.width || !out.w || !viewRect.w) return 1;
    return r.width / (out.w * viewRect.w);
  }

  /** Diámetro del aro en píxeles de pantalla. Constante frente al zoom. */
  function brushScreenPx(img, b) {
    return brushRadiusPx(img, b) * 2 * viewScale(img);
  }

  /**
   * Del puntero a coordenadas de la imagen original. Sin esta conversión
   * el pincel empujaría en la dirección equivocada en cuanto la foto
   * estuviera girada, y en el sitio equivocado si estuviera recortada.
   */
  function pointerUV(e) {
    var img = active();
    var r = viewport.getBoundingClientRect();
    var vx = (e.clientX - r.left) / r.width;
    var vy = (e.clientY - r.top) / r.height;
    var src = img
      ? RV.toSource(vx, vy, img.geo, viewRect, img.bitmap.width, img.bitmap.height)
      : { x: vx, y: vy };
    return {
      x: src.x,
      y: src.y,
      inside: vx >= 0 && vx <= 1 && vy >= 0 && vy <= 1
    };
  }

  var lastPointer = null;

  function moveRing(clientX, clientY) {
    lastPointer = { x: clientX, y: clientY };
    var img = active();
    if (!img) return;
    var stageRect = stage.getBoundingClientRect();
    var d = brushScreenPx(img);
    brushRing.style.width = d + 'px';
    brushRing.style.height = d + 'px';
    brushRing.style.transform =
      'translate(' + (clientX - stageRect.left - d / 2) + 'px,' +
                     (clientY - stageRect.top - d / 2) + 'px)';
  }

  /** Crea la máscara del ajuste local la primera vez que hace falta. */
  function maskFor(img) {
    if (!img.local.field) {
      img.local.field = new RV.MaskField(renderer.gl, img.bitmap.width, img.bitmap.height);
    }
    renderer.setMask(img.local.field);
    return img.local.field;
  }

  /**
   * Sella el pincel a lo largo del segmento recorrido. Sin recorrerlo,
   * un arrastre rápido dejaría el trazo a lunares: entre dos eventos de
   * puntero puede haber mucha foto.
   */
  function applyMask(img, mask, x0, y0, x1, y1) {
    var r = brushRadiusPx(img, maskBrush);
    var f = maskBrush.strength / 100;
    var feather = maskBrush.feather / 100;
    var dx = (x1 - x0) * img.bitmap.width;
    var dy = (y1 - y0) * img.bitmap.height;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var steps = Math.max(1, Math.ceil(dist / Math.max(r / 3, 1)));

    for (var i = 1; i <= steps; i++) {
      var t = i / steps;
      var x = x0 + (x1 - x0) * t;
      var y = y0 + (y1 - y0) * t;
      if (maskBrush.tool === 'erase') mask.erase(x, y, r, f, feather);
      else mask.paint(x, y, r, f, feather);
    }

    markEdited(img);
    refreshMaskHint();
    requestRender();
  }

  function beginStroke(e) {
    var img = active();
    if (!img) return false;
    var p = pointerUV(e);
    if (!p.inside) return false;

    if (maskBrush.tool) {
      var mask = maskFor(img);
      mask.snapshot();
      stroke = { x: p.x, y: p.y, mask: true };
      viewport.setPointerCapture(e.pointerId);
      applyMask(img, mask, p.x, p.y, p.x, p.y);
      return true;
    }

    if (!brush.tool) return false;
    var field = warpFor(img);
    field.snapshot();
    stroke = { x: p.x, y: p.y, mask: false };
    viewport.setPointerCapture(e.pointerId);
    applyBrush(img, field, p.x, p.y, 0, 0);
    return true;
  }

  function continueStroke(e) {
    var img = active();
    if (!stroke || !img) return;
    var p = pointerUV(e);

    if (stroke.mask) {
      applyMask(img, maskFor(img), stroke.x, stroke.y, p.x, p.y);
    } else {
      applyBrush(img, img.warp, p.x, p.y, p.x - stroke.x, p.y - stroke.y);
    }
    stroke.x = p.x;
    stroke.y = p.y;
  }

  function applyBrush(img, field, x, y, dx, dy) {
    var r = brushRadiusPx(img);
    var f = brush.strength / 100;
    if (brush.tool === 'push') {
      if (dx === 0 && dy === 0) return;
      field.push(x, y, dx, dy, r, f);
    } else if (brush.tool === 'restore') {
      field.restore(x, y, r, f * 0.25);
    } else if (brush.tool === 'smooth') {
      field.smooth(x, y, r, f * 0.5);
    }
    markEdited(img);
    requestRender();
  }

  var WARP_LABELS = { push: 'Empujar', smooth: 'Suavizar', restore: 'Restaurar' };

  function endStroke() {
    var img = active();
    // El trazo de máscara no deja paso propio en el histórico: sólo
    // cuenta cuando la zona se fija con "Aplicar".
    var warpTool = stroke && !stroke.mask ? brush.tool : null;
    stroke = null;
    if (img && (img.warp || img.local.field)) requestRender();
    if (img && warpTool) historyPush(img, WARP_LABELS[warpTool] || 'Deformar');
  }

  function warpUndo() {
    var img = active();
    if (!img || !img.warp || !img.warp.undo()) { toast('No queda ningún trazo que deshacer.'); return; }
    renderer.setWarp(img.warp.isEmpty() ? null : img.warp);
    markEdited(img);
    requestRender();
  }

  function warpClear() {
    var img = active();
    if (!img || !img.warp || img.warp.isEmpty()) return;
    img.warp.snapshot();
    img.warp.clear();
    renderer.setWarp(null);
    markEdited(img);
    requestRender();
    toast('Deformación retirada.');
    historyPush(img, 'Quitar deformación');
  }

  /* ---------- Histórico ---------- */

  function cloneSettings(s) { return Object.assign({}, s); }
  function cloneGeo(g) { return Object.assign({}, g); }

  /** Entrada inicial de una foto recién cargada: el punto "Original". */
  function historyInit(img) {
    img.history = new RV.HistoryLog({
      label: 'Original',
      settings: cloneSettings(img.settings),
      geo: cloneGeo(img.geo),
      warp: null,
      bakes: []
    });
  }

  /**
   * Añade un paso al histórico con el estado actual de la foto. `bake`,
   * si se pasa, describe una zona local recién horneada — se acumula
   * sobre las que ya había, nunca las sustituye.
   */
  function historyPush(img, label, bake) {
    if (!img || !img.history) return;
    var prev = img.history.current();
    img.history.push({
      label: label,
      settings: cloneSettings(img.settings),
      geo: cloneGeo(img.geo),
      warp: (img.warp && !img.warp.isEmpty()) ? img.warp.snapshotData() : null,
      bakes: bake ? prev.bakes.concat([bake]) : prev.bakes
    });
    renderHistoryList(img);
  }

  /**
   * Salta a un paso ya registrado. Los ajustes y el encuadre se vuelcan
   * directamente; la deformación se reconstruye o se vacía; y las zonas
   * horneadas se rehacen desde el original en el mismo orden en que se
   * aplicaron, que es lo que ya hace "Restablecer todo" para deshacerlas.
   */
  function historyJump(img, i) {
    var snap = img.history.jump(i);
    if (!snap) return;

    img.settings = cloneSettings(snap.settings);
    img.geo = cloneGeo(snap.geo);
    img.view = RV.defaultView();

    if (img.warp) {
      if (snap.warp) img.warp.restoreData(snap.warp);
      else img.warp.clear();
      renderer.setWarp(img.warp.isEmpty() ? null : img.warp);
    }

    if (img.baked || snap.bakes.length) {
      renderer.restoreSource(img.id, img.bitmap);
      snap.bakes.forEach(function (bake) {
        if (!img.local.field) {
          img.local.field = new RV.MaskField(renderer.gl, img.bitmap.width, img.bitmap.height);
        }
        img.local.field.restoreData(bake.mask);
        renderer.setMask(img.local.field);
        renderer.bakeLocal(img.id, bake.local);
      });
      img.baked = snap.bakes.length > 0;
    }

    // El trazo de selección en curso no es parte del histórico: siempre
    // se vuelve con la zona vacía, lista para pintar otra.
    img.local.settings = RV.localDefaults();
    if (img.local.field) img.local.field.clear();
    renderer.setMask(img.local.field || null);
    maskEditing = false;
    setMaskTool(null);

    presetSel = null;
    amountBox.hidden = true;
    setActivePreset(null);

    syncPanels();
    syncGeo();
    BRUSH_SLIDERS.forEach(function (d) { if (d.refresh) d.refresh(); });
    MASK_SLIDERS.forEach(function (d) { if (d.refresh) d.refresh(); });
    refreshMaskHint();
    renderHistoryList(img);
    resize();
    requestRender();
  }

  function renderHistoryList(img) {
    historyList.innerHTML = '';
    if (!img || !img.history) return;

    // El más reciente arriba: es donde se está trabajando y así no hay
    // que desplazarse para ver el último paso.
    for (var i = img.history.entries.length - 1; i >= 0; i--) {
      (function (i) {
        var entry = img.history.entries[i];
        var li = document.createElement('li');

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'history-item';
        btn.textContent = entry.label;
        if (i === img.history.index) btn.setAttribute('aria-current', 'true');
        btn.addEventListener('click', function () { historyJump(img, i); });

        li.appendChild(btn);
        historyList.appendChild(li);
      })(i);
    }
  }

  function buildControl(adj) {
    var row = document.createElement('div');
    row.className = 'ctl';

    var top = document.createElement('div');
    top.className = 'ctl__top';

    var label = document.createElement('label');
    label.className = 'ctl__label';
    label.htmlFor = 'ctl-' + adj.id;
    label.textContent = adj.label;

    // El valor es un campo de texto: arrastrar el slider va bien para
    // buscar, pero para clavar un número hace falta escribirlo.
    var val = document.createElement('input');
    val.type = 'text';
    val.className = 'ctl__val';
    val.inputMode = 'decimal';
    val.autocomplete = 'off';
    val.spellcheck = false;
    val.value = RV.format(adj, adj.def);
    val.setAttribute('aria-label', adj.label + ' (valor)');

    val.addEventListener('focus', function () { val.select(); });
    val.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { commitTyped(); val.blur(); }
      if (e.key === 'Escape') {
        var img = active();
        syncControl(adj, img ? targetFor(img, adj)[adj.id] : adj.def);
        val.blur();
      }
    });
    val.addEventListener('blur', commitTyped);

    function commitTyped() {
      var img = active();
      if (!img) { val.value = RV.format(adj, adj.def); return; }
      // Se acepta la coma decimal y se ignora todo lo que no sea número.
      var n = parseFloat(String(val.value).replace(',', '.').replace(/[^0-9.+-]/g, ''));
      var t = targetFor(img, adj);
      if (!isFinite(n)) { syncControl(adj, t[adj.id]); return; }
      var before = t[adj.id];
      t[adj.id] = RV.clamp(n, adj.min, adj.max);
      syncControl(adj, t[adj.id]);
      markEdited(img);
      if (t === img.settings) {
        setActivePreset(null);
        if (t[adj.id] !== before) historyPush(img, adj.label + ' ' + RV.format(adj, t[adj.id]));
      }
      requestRender();
    }

    top.appendChild(label);
    top.appendChild(val);

    var track = document.createElement('div');
    track.className = 'ctl__track';
    // La marca de reposo se sitúa donde cae el valor por defecto.
    track.style.setProperty('--detent',
      (((adj.def - adj.min) / (adj.max - adj.min)) * 100).toFixed(2) + '%');

    var input = document.createElement('input');
    input.type = 'range';
    input.id = 'ctl-' + adj.id;
    input.min = adj.min;
    input.max = adj.max;
    input.step = adj.step;
    input.value = adj.def;

    input.addEventListener('input', function () {
      var img = active();
      if (!img) { input.value = adj.def; return; }
      var t = targetFor(img, adj);
      t[adj.id] = parseFloat(input.value);
      syncControl(adj, t[adj.id]);
      markEdited(img);
      // Un retoque local no invalida el preset: el preset es global.
      if (t === img.settings) setActivePreset(null);
      requestRender();
    });

    // El paso al histórico se registra al soltar, no en cada tick del
    // arrastre: si no, un solo gesto llenaría la lista de decenas de
    // entradas casi idénticas.
    input.addEventListener('change', function () {
      var img = active();
      if (!img || !img.history) return;
      var t = targetFor(img, adj);
      if (t === img.settings && t[adj.id] !== img.history.current().settings[adj.id]) {
        historyPush(img, adj.label + ' ' + RV.format(adj, t[adj.id]));
      }
    });

    // Doble clic sobre el slider: vuelta al valor por defecto.
    input.addEventListener('dblclick', function () { resetOne(adj); });

    track.appendChild(input);
    row.appendChild(top);
    row.appendChild(track);

    controls[adj.id] = { input: input, valueEl: val, row: row };
    return row;
  }

  function syncControl(adj, value) {
    var c = controls[adj.id];
    c.input.value = value;
    c.valueEl.value = RV.format(adj, value);
    c.row.classList.toggle('is-dirty', value !== adj.def);
  }

  /**
   * Dónde escribe este slider. Sólo luz, color y detalle admiten
   * versión local; los efectos van siempre al ajuste global aunque el
   * panel esté en modo zona (por eso su grupo se apaga).
   */
  function targetFor(img, adj) {
    return (scope === 'local' && RV.isLocal(adj.id)) ? img.local.settings : img.settings;
  }

  function syncAll(settings, localSettings) {
    RV.ALL.forEach(function (adj) {
      var src = (scope === 'local' && localSettings && RV.isLocal(adj.id))
        ? localSettings : settings;
      syncControl(adj, src[adj.id]);
    });
  }

  /** Vuelca en los sliders lo que corresponde a la imagen y al ámbito. */
  function syncPanels() {
    var img = active();
    syncAll(img ? img.settings : RV.defaults(), img ? img.local.settings : null);
  }

  function resetOne(adj) {
    var img = active();
    if (!img) return;
    var t = targetFor(img, adj);
    if (t[adj.id] === adj.def) return;
    t[adj.id] = adj.def;
    syncControl(adj, adj.def);
    markEdited(img);
    requestRender();
    if (t === img.settings) historyPush(img, adj.label + ' restablecido');
  }

  /* ---------- Biblioteca ---------- */

  function active() {
    return library.find(function (i) { return i.id === activeId; }) || null;
  }

  function addFiles(files) {
    var images = Array.prototype.filter.call(files, function (f) {
      return /^image\//.test(f.type);
    });
    var presets = Array.prototype.filter.call(files, function (f) {
      return /\.xmp$/i.test(f.name);
    });

    presets.forEach(loadPreset);

    if (!images.length) return;

    var jobs = images.map(function (file) {
      return decode(file).then(function (bitmap) {
        var item = {
          id: 'img-' + (++seq),
          name: file.name,
          bitmap: bitmap,
          thumbUrl: URL.createObjectURL(file),
          settings: RV.defaults(),
          // `field` se crea la primera vez que se pinta: una máscara por
          // imagen cargada sería memoria tirada en el caso normal.
          local: { field: null, settings: RV.localDefaults() },
          // Zonas ya aceptadas: van dentro de los píxeles, no en un ajuste.
          baked: false,
          geo: RV.defaultGeometry(),
          view: RV.defaultView()
        };
        historyInit(item);
        library.push(item);
        renderer.upload(item.id, bitmap);
        return item;
      }).catch(function () {
        toast('No se ha podido abrir ' + file.name, true);
        return null;
      });
    });

    Promise.all(jobs).then(function (items) {
      renderStrip();
      var first = items.filter(Boolean)[0];
      if (first && !activeId) select(first.id);
    });
  }

  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file);
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }

  function removeImage(id) {
    var index = -1;
    for (var i = 0; i < library.length; i++) if (library[i].id === id) index = i;
    if (index < 0) return;

    var item = library[index];
    if (item.warp) item.warp.dispose();
    if (item.local.field) item.local.field.dispose();
    renderer.release(id);
    URL.revokeObjectURL(item.thumbUrl);
    if (item.bitmap && item.bitmap.close) item.bitmap.close();
    library.splice(index, 1);

    if (activeId !== id) {
      renderStrip();
    } else {
      activeId = null;
      var next = library[index] || library[index - 1];
      if (next) select(next.id);
      else showEmpty();
    }
    toast('Se ha quitado ' + item.name);
  }

  function showEmpty() {
    activeId = null;
    renderer.select(null);
    renderer.setWarp(null);
    renderer.setMask(null);
    renderer.setFrame(null);
    renderer.setSplit(-1);
    split.on = false;
    splitLayer.hidden = true;
    $('#split-toggle').setAttribute('aria-pressed', 'false');
    setTool(null);
    maskEditing = false;
    setMaskTool(null);
    setCropping(false);
    syncGeo();
    syncZoombar();
    viewport.hidden = true;
    dropzone.hidden = false;
    filename.textContent = '';
    presetNote.hidden = true;
    setActivePreset(null);
    syncPanels();
    refreshMaskHint();
    drawHistogram(null);
    renderStrip();
    renderHistoryList(null);
  }

  function select(id) {
    activeId = id;
    var img = active();
    if (!img) return;

    renderer.select(id);
    renderer.setWarp(img.warp && !img.warp.isEmpty() ? img.warp : null);
    renderer.setMask(img.local.field || null);
    // Cada foto empieza su propia sesión: la de la anterior no se arrastra.
    maskEditing = false;
    setMaskTool(null);
    viewport.hidden = false;
    dropzone.hidden = true;
    filename.textContent = img.name + '  ·  ' + img.bitmap.width + '×' + img.bitmap.height;

    syncPanels();
    syncGeo();
    BRUSH_SLIDERS.forEach(function (d) { if (d.refresh) d.refresh(); });
    MASK_SLIDERS.forEach(function (d) { if (d.refresh) d.refresh(); });
    refreshMaskHint();
    presetNote.hidden = true;
    presetSel = null;
    amountBox.hidden = true;
    setActivePreset(null);
    renderStrip();
    renderHistoryList(img);
    resize();
  }

  function renderStrip() {
    strip.innerHTML = '';

    library.forEach(function (item) {
      // No es un <button> porque contiene otro botón (quitar), y anidarlos
      // no es marcado válido ni funciona bien con el teclado.
      var cell = document.createElement('div');
      cell.className = 'thumb' + (isPristine(item) ? '' : ' is-edited');
      cell.setAttribute('role', 'button');
      cell.tabIndex = 0;
      cell.title = item.name;
      cell.setAttribute('aria-current', String(item.id === activeId));

      var img = document.createElement('img');
      img.alt = '';
      img.src = item.thumbUrl;

      var dot = document.createElement('span');
      dot.className = 'dot';

      var del = document.createElement('button');
      del.className = 'thumb__del';
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Quitar de la biblioteca';
      del.setAttribute('aria-label', 'Quitar ' + item.name + ' de la biblioteca');
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        removeImage(item.id);
      });

      cell.appendChild(img);
      cell.appendChild(dot);
      cell.appendChild(del);
      cell.addEventListener('click', function () { select(item.id); });
      cell.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(item.id); }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeImage(item.id); }
      });

      strip.appendChild(cell);
    });

    var add = document.createElement('button');
    add.className = 'thumb thumb--add';
    add.type = 'button';
    add.title = 'Añadir imágenes';
    add.setAttribute('aria-label', 'Añadir imágenes a la biblioteca');
    add.innerHTML = '<span aria-hidden="true">+</span><small>Añadir</small>';
    add.addEventListener('click', function () { fileInput.click(); });
    strip.appendChild(add);
  }

  function isPristine(img) {
    return RV.isDefault(img.settings) &&
           RV.isDefaultGeometry(img.geo) &&
           (!img.warp || img.warp.isEmpty()) &&
           !localFor(img) && !img.baked;
  }

  function markEdited(img) {
    var index = library.indexOf(img);
    var node = strip.children[index];
    if (node) node.classList.toggle('is-edited', !isPristine(img));
    refreshMaskApply();
  }

  /* ---------- Render ---------- */

  function requestRender() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(function () {
      frameQueued = false;
      var img = active();
      if (!img) return;
      renderer.draw(img.settings, comparing, localFor(img));
      scheduleHistogram();
    });
  }

  function scheduleHistogram() {
    clearTimeout(histTimer);
    histTimer = setTimeout(function () {
      var img = active();
      if (!img) return;
      drawHistogram(renderer.histogram(img.settings, localFor(img)));
      // El histograma se pinta en un framebuffer aparte, así que
      // hay que devolver el resultado visible al lienzo.
      renderer.draw(img.settings, comparing, localFor(img));
    }, 70);
  }

  function resize() {
    var img = active();
    if (!img) { syncZoombar(); return; }

    var W = img.bitmap.width, H = img.bitmap.height;
    // Al recortar se muestra el fotograma entero: hay que poder ver lo
    // que se está dejando fuera.
    var geo = cropping ? RV.defaultGeometry() : img.geo;
    if (cropping) { geo.quarter = img.geo.quarter; geo.angle = img.geo.angle; }

    var out = RV.outputSize(geo, W, H);
    // El margen vertical es mayor: abajo viven las barras de vista y de
    // zoom, y la imagen se centra, así que hay que reservar a ambos lados.
    // Al recortar hace falta más hueco abajo: los tiradores sobresalen 8 px
    // del fotograma y la barra de Hecho / Cancelar ocupa esa franja.
    var padX = 60, padY = cropping ? 120 : 84;
    var box = renderer.fit(stage.clientWidth - padX, stage.clientHeight - padY, out.w, out.h);

    viewRect = cropping
      ? { cx: 0.5, cy: 0.5, w: 1, h: 1, pct: 100, fitPct: 100 }
      : RV.viewRect(img.view, geo, W, H, box.w);

    renderer.setFrame(geo, viewRect);
    layoutCropLayer();
    layoutSplit();
    syncZoombar();
    requestRender();
  }

  /* ---------- Histograma ---------- */

  var hctx = histCanvas.getContext('2d');

  function drawHistogram(data) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = histCanvas.clientWidth, h = histCanvas.clientHeight;
    histCanvas.width = Math.round(w * dpr);
    histCanvas.height = Math.round(h * dpr);
    hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    hctx.clearRect(0, 0, w, h);

    if (!data) return;

    var peak = 1;
    for (var i = 1; i < data.bins - 1; i++) {   // se ignoran los extremos recortados
      peak = Math.max(peak, data.r[i], data.g[i], data.b[i]);
    }

    hctx.globalCompositeOperation = 'lighter';
    plot(data.r, 'rgba(224, 86, 72, .62)');
    plot(data.g, 'rgba(96, 200, 116, .62)');
    plot(data.b, 'rgba(84, 138, 232, .62)');
    hctx.globalCompositeOperation = 'source-over';

    function plot(bins, color) {
      hctx.beginPath();
      hctx.moveTo(0, h);
      for (var i = 0; i < bins.length; i++) {
        var x = (i / (bins.length - 1)) * w;
        var y = h - Math.min(1, bins[i] / peak) * (h - 2);
        hctx.lineTo(x, y);
      }
      hctx.lineTo(w, h);
      hctx.closePath();
      hctx.fillStyle = color;
      hctx.fill();
    }
  }

  /* ---------- Presets ---------- */

  function loadPreset(file) {
    if (!active()) { toast('Carga una imagen antes de aplicar un preset.', true); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var result;
      try {
        result = RV.parseXMP(String(reader.result), file.name);
      } catch (err) {
        toast(err.message, true);
        return;
      }
      // Se trata como cualquier otro preset: se puede graduar y quitar.
      togglePreset({
        id: 'xmp-' + Date.now().toString(36),
        name: result.name,
        hint: result.applied.length + ' ajustes',
        values: result.values
      }, 'xmp');

      if (result.warnings.length) {
        presetNote.innerHTML += '<br>Sin aplicar: ' +
          escapeHtml(result.warnings.join(', ')) + '.';
      }
      toast('Preset aplicado: ' + result.name);
    };
    reader.onerror = function () { toast('No se ha podido leer el archivo.', true); };
    reader.readAsText(file);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ---------- Exportación ---------- */

  var modal      = $('#export-modal');
  var nameInput  = $('#export-name');
  var formatSel  = $('#export-format');
  var qualityIn  = $('#export-quality');
  var qualityOut = $('#quality-value');
  var qualityRow = $('#quality-field');
  var exportMeta = $('#export-meta');

  var EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };

  function openExport() {
    var img = active();
    if (!img) { toast('Carga una imagen antes de exportar.', true); return; }
    nameInput.value = img.name.replace(/\.[^.]+$/, '') + '-revelado';
    syncExportFields();
    modal.hidden = false;
    nameInput.focus();
    nameInput.select();
  }

  function closeExport() {
    modal.hidden = true;
  }

  function syncExportFields() {
    var img = active();
    var lossless = formatSel.value === 'image/png';
    qualityRow.style.display = lossless ? 'none' : '';
    qualityOut.textContent = qualityIn.value;
    syncQualitySeg();
    if (img) {
      var out = RV.outputSize(img.geo, img.bitmap.width, img.bitmap.height);
      exportMeta.textContent = out.w + ' × ' + out.h + ' px · ' +
        (nameInput.value.trim() || 'sin-nombre') + '.' + EXT[formatSel.value];
      if (cropping) exportMeta.textContent += ' · recorte en curso';
    }
  }

  var qualitySeg = $('#quality-seg');

  Array.prototype.forEach.call(qualitySeg.children, function (b) {
    b.addEventListener('click', function () {
      qualityIn.value = b.dataset.quality;
      syncExportFields();
    });
  });

  function syncQualitySeg() {
    var v = parseInt(qualityIn.value, 10);
    Array.prototype.forEach.call(qualitySeg.children, function (b) {
      b.setAttribute('aria-pressed', String(parseInt(b.dataset.quality, 10) === v));
    });
  }

  formatSel.addEventListener('change', syncExportFields);
  qualityIn.addEventListener('input', syncExportFields);
  nameInput.addEventListener('input', syncExportFields);
  nameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') runExport();
  });
  $('#export-cancel').addEventListener('click', closeExport);
  $('#export-confirm').addEventListener('click', runExport);
  modal.addEventListener('click', function (e) { if (e.target === modal) closeExport(); });

  // Los nombres de archivo no admiten separadores de ruta ni caracteres
  // reservados en Windows; se limpian en vez de rechazar el nombre.
  // Declarada como función para poder usarla desde el panel de presets,
  // que se monta antes que este bloque.
  function safeName(raw) {
    var name = String(raw).trim().replace(/[\/\\:*?"<>|]+/g, '-').replace(/^\.+/, '');
    return name.slice(0, 120) || 'revelado';
  }

  function runExport() {
    var img = active();
    if (!img) return;

    var mime = formatSel.value;
    var quality = mime === 'image/png' ? undefined : parseInt(qualityIn.value, 10) / 100;
    var name = safeName(nameInput.value) + '.' + EXT[mime];

    closeExport();
    if (cropping) setCropping(false);
    renderer.setFrame(img.geo, viewRect);
    var btn = $('#btn-export');
    btn.disabled = true;
    btn.textContent = 'Exportando…';

    renderer.exportBlob(img.settings, quality, mime, localFor(img)).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var kb = Math.round(blob.size / 1024);

      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 120000);

      // Dentro de un iframe la descarga directa puede estar bloqueada,
      // así que se ofrece además un enlace para abrir el JPG aparte.
      if (window.self !== window.top) {
        toastHTML(name + ' · ' + kb + ' kB · <a href="' + url +
          '" target="_blank" rel="noopener">abrir en otra pestaña</a> si no se ha descargado');
      } else {
        toast('Guardado ' + name + ' · ' + kb + ' kB');
      }
    }).catch(function (err) {
      toast(err.message, true);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Exportar…';
      resize();
    });
  }

  /* ---------- Eventos ---------- */

  var shelfToggle   = $('#shelf-toggle');
  var shelfBackdrop = $('#shelf-backdrop');

  function toggleShelf(force) {
    var open = typeof force === 'boolean' ? force : app.dataset.shelf !== 'open';
    app.dataset.shelf = open ? 'open' : 'closed';
    shelfToggle.setAttribute('aria-expanded', String(open));
    shelf.inert = !open;
    setTimeout(resize, 200);   // la columna cambia de ancho con transición
  }
  shelfToggle.addEventListener('click', function () { toggleShelf(); });
  // En móvil la balda se superpone (mismo corte de 940px que styles.css) en
  // vez de empujar el escenario, así que abrirla de entrada taparía casi
  // toda la pantalla nada más cargar. En escritorio sí hay sitio de sobra.
  shelfBackdrop.addEventListener('click', function () { toggleShelf(false); });
  toggleShelf(window.innerWidth > 940);

  $('#btn-preset').addEventListener('click', function () { xmpInput.click(); });
  $('#btn-export').addEventListener('click', openExport);
  $('#btn-reset').addEventListener('click', function () {
    var img = active();
    if (!img) return;
    img.settings = RV.defaults();
    img.local.settings = RV.localDefaults();
    img.geo = RV.defaultGeometry();
    img.view = RV.defaultView();
    if (img.warp) { img.warp.snapshot(); img.warp.clear(); renderer.setWarp(null); }
    if (img.local.field) { img.local.field.snapshot(); img.local.field.clear(); }
    // Las zonas aceptadas están dentro de la textura: hay que volver a
    // subir el original para deshacerlas.
    if (img.baked) { renderer.restoreSource(img.id, img.bitmap); img.baked = false; }
    setScope('global');
    syncPanels();
    syncGeo();
    BRUSH_SLIDERS.forEach(function (d) { if (d.refresh) d.refresh(); });
    MASK_SLIDERS.forEach(function (d) { if (d.refresh) d.refresh(); });
    refreshMaskHint();
    presetNote.hidden = true;
    presetSel = null;
    amountBox.hidden = true;
    setActivePreset(null);
    resize();
    historyPush(img, 'Restablecido');
  });

  fileInput.addEventListener('change', function () { addFiles(fileInput.files); fileInput.value = ''; });
  xmpInput.addEventListener('change', function () {
    Array.prototype.forEach.call(xmpInput.files, loadPreset);
    xmpInput.value = '';
  });

  dropzone.addEventListener('click', function () { fileInput.click(); });

  ['dragenter', 'dragover'].forEach(function (ev) {
    window.addEventListener(ev, function (e) {
      e.preventDefault();
      app.classList.add('is-dragging');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    window.addEventListener(ev, function (e) {
      e.preventDefault();
      if (ev === 'dragleave' && e.relatedTarget) return;
      app.classList.remove('is-dragging');
    });
  });
  window.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  // Comparar con el original: mantener pulsado sobre la imagen, o la tecla \.
  function setCompare(on) {
    if (comparing === on) return;
    comparing = on;
    app.classList.toggle('is-comparing', on);
    requestRender();
  }
  viewport.addEventListener('pointerdown', function (e) {
    if (activeBrush()) { if (beginStroke(e)) e.preventDefault(); return; }
    if (canPan()) {
      var img = active();
      panDrag = { x: e.clientX, y: e.clientY, cx: viewRect.cx, cy: viewRect.cy };
      img.view.cx = viewRect.cx;
      img.view.cy = viewRect.cy;
      app.classList.add('is-dragging-view');
      viewport.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    setCompare(true);
  });
  viewport.addEventListener('pointermove', function (e) {
    if (panDrag) {
      var img = active();
      var r = viewport.getBoundingClientRect();
      img.view.cx = panDrag.cx - ((e.clientX - panDrag.x) / r.width) * viewRect.w;
      img.view.cy = panDrag.cy - ((e.clientY - panDrag.y) / r.height) * viewRect.h;
      resize();
      e.preventDefault();
      return;
    }
    if (!activeBrush()) return;
    moveRing(e.clientX, e.clientY);
    if (stroke) { continueStroke(e); e.preventDefault(); }
  });
  window.addEventListener('pointerup', function () {
    if (panDrag) { panDrag = null; app.classList.remove('is-dragging-view'); return; }
    if (stroke) { endStroke(); return; }
    setCompare(false);
  });
  window.addEventListener('pointercancel', endStroke);

  stage.addEventListener('pointermove', function (e) {
    if (activeBrush() && !stroke) moveRing(e.clientX, e.clientY);
  });

  $('#btn-warp-undo').addEventListener('click', warpUndo);
  $('#btn-warp-clear').addEventListener('click', warpClear);
  window.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if (e.key === '\\') setCompare(true);
    if (e.key === 'Escape') {
      // Dentro del recorte, Escape sólo lo cancela: cerrar de paso el
      // panel o la herramienta sería un efecto sorpresa.
      if (cropping) { setCropping(false, true); return; }
      toggleShelf(false); setTool(null);
      maskEditing = false; setMaskTool(null); refreshMaskApply();
      closeExport(); closePresetModal();
    }
    if (e.key === 'Enter' && cropping) { setCropping(false); return; }
    if (e.key === '0' && !e.ctrlKey && !e.metaKey) setZoom('fit');
    if (e.key === '1' && !e.ctrlKey && !e.metaKey) setZoom(100);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (maskBrush.tool || scope === 'local') maskUndo(); else warpUndo();
    }
  });
  window.addEventListener('keyup', function (e) {
    if (e.key === '\\') setCompare(false);
  });

  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);

  /* ---------- Aviso ---------- */

  var toastTimer = 0;

  function show(ms) {
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, ms);
  }

  function toast(message, isError) {
    toastEl.textContent = message;
    toastEl.classList.toggle('is-error', !!isError);
    show(3200);
  }

  // Sólo para avisos con enlace generados por la propia aplicación.
  function toastHTML(html) {
    toastEl.innerHTML = html;
    toastEl.classList.remove('is-error');
    show(12000);
  }
})();
