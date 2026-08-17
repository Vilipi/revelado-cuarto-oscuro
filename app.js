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
  var warpGroup  = $('#group-warp');
  var geoGroup   = $('#group-geo');
  var cropLayer  = $('#crop-overlay');
  var cropBox    = $('#crop-box');
  var zoombar    = $('#zoombar');
  var viewbar    = $('#viewbar');
  var splitLayer = $('#split-overlay');
  var splitDiv   = $('#split-divider');
  var brushRing  = $('#brush-ring');
  var presetList = $('#preset-list');

  var fileInput  = $('#file-input');
  var xmpInput   = $('#xmp-input');

  var library = [];       // { id, name, bitmap, thumbUrl, settings }
  var activeId = null;
  var comparing = false;
  var activePreset = null;

  // Pincel de deformación
  var brush = { tool: null, size: 16, strength: 55 };
  var stroke = null;

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
    });

    var body = document.createElement('div');
    body.className = 'group__body';

    group.items.forEach(function (adj) {
      body.appendChild(buildControl(adj));
    });

    section.appendChild(head);
    section.appendChild(body);
    panels.insertBefore(section, warpGroup);
  });

  /* ---------- Presets incluidos ---------- */

  RV.PRESETS.forEach(function (preset) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.className = 'preset';
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    b.dataset.preset = preset.id;
    b.innerHTML = '<b></b><small></small>';
    b.querySelector('b').textContent = preset.name;
    b.querySelector('small').textContent = preset.hint;
    b.addEventListener('click', function () { applyBuiltin(preset); });
    li.appendChild(b);
    presetList.appendChild(li);
  });

  function applyBuiltin(preset) {
    var img = active();
    if (!img) { toast('Carga una imagen antes de aplicar un preset.', true); return; }
    img.settings = RV.applyPreset(preset.values);
    syncAll(img.settings);
    markEdited(img);
    requestRender();
    setActivePreset(preset.id);
    presetNote.hidden = false;
    presetNote.innerHTML = '<b>' + escapeHtml(preset.name) + '</b> · preset incluido';
  }

  function setActivePreset(id) {
    activePreset = id;
    Array.prototype.forEach.call(presetList.querySelectorAll('.preset'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.preset === id));
    });
  }

  /* ---------- Encuadre: zoom, recorte y giros ---------- */

  (function () {
    var head = geoGroup.querySelector('.group__head');
    head.addEventListener('click', function () {
      var open = geoGroup.dataset.open === 'true';
      geoGroup.dataset.open = String(!open);
      head.setAttribute('aria-expanded', String(!open));
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
    });
    $('#ratio-seg').appendChild(b);
  });

  // Enderezado: es el único control de este panel con forma de slider.
  var angleInput;
  (function () {
    var row = document.createElement('div');
    row.className = 'ctl';
    row.innerHTML = '<div class="ctl__top"><label class="ctl__label" for="geo-angle">Ángulo</label>' +
                    '<span class="ctl__val">0.0°</span></div>' +
                    '<div class="ctl__track"><input type="range" id="geo-angle" ' +
                    'min="-45" max="45" step="0.1" value="0"></div>';
    angleInput = row.querySelector('input');
    var out = row.querySelector('.ctl__val');

    angleInput.addEventListener('input', function () {
      var img = active();
      if (!img) { angleInput.value = 0; return; }
      img.geo.angle = parseFloat(angleInput.value);
      RV.normalizeCrop(img.geo, img.bitmap.width, img.bitmap.height);
      out.textContent = img.geo.angle.toFixed(1) + '°';
      row.classList.toggle('is-dirty', img.geo.angle !== 0);
      markEdited(img);
      resize();
    });
    angleInput.addEventListener('dblclick', function () {
      var img = active();
      if (!img) return;
      img.geo.angle = 0;
      RV.normalizeCrop(img.geo, img.bitmap.width, img.bitmap.height);
      syncGeo();
      resize();
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
  }

  $('#rot-left').addEventListener('click', function () { rotate(-1); });
  $('#rot-right').addEventListener('click', function () { rotate(1); });

  $('#flip-h').addEventListener('click', function () {
    var img = active();
    if (!img) return;
    img.geo.flipH = !img.geo.flipH;
    syncGeo();
    requestRender();
  });
  $('#flip-v').addEventListener('click', function () {
    var img = active();
    if (!img) return;
    img.geo.flipV = !img.geo.flipV;
    syncGeo();
    requestRender();
  });

  $('#crop-reset').addEventListener('click', function () {
    var img = active();
    if (!img) return;
    img.geo = RV.defaultGeometry();
    img.view = RV.defaultView();
    syncGeo();
    resize();
  });

  $('#crop-toggle').addEventListener('click', function () { setCropping(!cropping); });

  function setCropping(on) {
    var img = active();
    if (on && !img) { toast('Carga una imagen antes de recortar.', true); return; }
    cropping = on;
    $('#crop-toggle').setAttribute('aria-pressed', String(on));
    cropLayer.hidden = !on;
    if (on) {
      setTool(null);
      if (split.on) setSplit(false);
      geoGroup.dataset.open = 'true';
      geoGroup.querySelector('.group__head').setAttribute('aria-expanded', 'true');
      if (img) img.view = RV.defaultView();
    }
    resize();
  }

  function syncGeo() {
    var img = active();
    var g = img ? img.geo : RV.defaultGeometry();
    angleInput.value = g.angle;
    angleInput.out.textContent = g.angle.toFixed(1) + '°';
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
  $('#zoom-fit').addEventListener('click', function () { setZoom('fit'); });
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
    return !cropping && !brush.tool && viewRect.w < 0.999;
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
        return Math.max(1, Math.round(brushRadiusPx(img) * 2)) + ' px';
      }
    },
    {
      key: 'strength', label: 'Fuerza', min: 5, max: 100, step: 1,
      format: function () { return Math.round(brush.strength) + ''; }
    }
  ];

  BRUSH_SLIDERS.forEach(function (def) {
    var row = document.createElement('div');
    row.className = 'ctl is-dirty';
    row.innerHTML = '<div class="ctl__top"><label class="ctl__label"></label>' +
                    '<span class="ctl__val"></span></div>' +
                    '<div class="ctl__track"><input type="range"></div>';
    var input = row.querySelector('input');
    var out = row.querySelector('.ctl__val');
    row.querySelector('.ctl__label').textContent = def.label;
    row.querySelector('.ctl__label').htmlFor = 'brush-' + def.key;
    row.querySelector('.ctl__track').style.setProperty('--detent', '-10px');
    input.id = 'brush-' + def.key;
    input.min = def.min; input.max = def.max; input.step = def.step;
    input.value = def.toSlider ? def.toSlider(brush[def.key]) : brush[def.key];
    out.textContent = def.format();

    input.addEventListener('input', function () {
      var raw = parseFloat(input.value);
      brush[def.key] = def.fromSlider ? def.fromSlider(raw) : raw;
      out.textContent = def.format();
      if (lastPointer) moveRing(lastPointer.x, lastPointer.y);
    });

    def.refresh = function () { out.textContent = def.format(); };
    $('#warp-sliders').appendChild(row);
  });

  (function () {
    var head = warpGroup.querySelector('.group__head');
    head.addEventListener('click', function () {
      var open = warpGroup.dataset.open === 'true';
      warpGroup.dataset.open = String(!open);
      head.setAttribute('aria-expanded', String(!open));
    });
  })();

  var TOOLS = { push: $('#tool-push'), smooth: $('#tool-smooth'), restore: $('#tool-restore') };

  Object.keys(TOOLS).forEach(function (name) {
    TOOLS[name].addEventListener('click', function () { setTool(brush.tool === name ? null : name); });
  });

  function setTool(name) {
    brush.tool = name;
    Object.keys(TOOLS).forEach(function (k) {
      TOOLS[k].setAttribute('aria-pressed', String(k === name));
    });
    app.classList.toggle('is-brushing', !!name);
    if (name) {
      warpGroup.dataset.open = 'true';
      warpGroup.querySelector('.group__head').setAttribute('aria-expanded', 'true');
    }
  }

  /** Crea el campo de deformación de la imagen activa la primera vez. */
  function warpFor(img) {
    if (!img.warp) {
      img.warp = new RV.WarpField(renderer.gl, img.bitmap.width, img.bitmap.height);
    }
    renderer.setWarp(img.warp);
    return img.warp;
  }

  /** Radio del pincel en píxeles de la imagen. */
  function brushRadiusPx(img) {
    return (brush.size / 100) * Math.min(img.bitmap.width, img.bitmap.height);
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
    var r = viewport.getBoundingClientRect();
    var stageRect = stage.getBoundingClientRect();
    // Píxeles de pantalla por píxel de imagen, contando recorte y zoom.
    var out = RV.outputSize(img.geo, img.bitmap.width, img.bitmap.height);
    var scale = r.width / (out.w * viewRect.w);
    var d = brushRadiusPx(img) * 2 * scale;
    brushRing.style.width = d + 'px';
    brushRing.style.height = d + 'px';
    brushRing.style.transform =
      'translate(' + (clientX - stageRect.left - d / 2) + 'px,' +
                     (clientY - stageRect.top - d / 2) + 'px)';
  }

  function beginStroke(e) {
    var img = active();
    if (!img || !brush.tool) return false;
    var p = pointerUV(e);
    if (!p.inside) return false;

    var field = warpFor(img);
    field.snapshot();
    stroke = { x: p.x, y: p.y };
    viewport.setPointerCapture(e.pointerId);
    applyBrush(img, field, p.x, p.y, 0, 0);
    return true;
  }

  function continueStroke(e) {
    var img = active();
    if (!stroke || !img) return;
    var p = pointerUV(e);
    var dx = p.x - stroke.x;
    var dy = p.y - stroke.y;
    applyBrush(img, img.warp, p.x, p.y, dx, dy);
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

  function endStroke() {
    var img = active();
    stroke = null;
    if (img && img.warp) requestRender();
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
    if (!img || !img.warp) return;
    img.warp.snapshot();
    img.warp.clear();
    renderer.setWarp(null);
    markEdited(img);
    requestRender();
    toast('Deformación retirada.');
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

    var val = document.createElement('span');
    val.className = 'ctl__val';
    val.textContent = RV.format(adj, adj.def);

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
      img.settings[adj.id] = parseFloat(input.value);
      syncControl(adj, img.settings[adj.id]);
      markEdited(img);
      setActivePreset(null);
      requestRender();
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
    c.valueEl.textContent = RV.format(adj, value);
    c.row.classList.toggle('is-dirty', value !== adj.def);
  }

  function syncAll(settings) {
    RV.ALL.forEach(function (adj) { syncControl(adj, settings[adj.id]); });
  }

  function resetOne(adj) {
    var img = active();
    if (!img) return;
    img.settings[adj.id] = adj.def;
    syncControl(adj, adj.def);
    markEdited(img);
    requestRender();
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
          geo: RV.defaultGeometry(),
          view: RV.defaultView()
        };
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
    renderer.setFrame(null);
    renderer.setSplit(-1);
    split.on = false;
    splitLayer.hidden = true;
    $('#split-toggle').setAttribute('aria-pressed', 'false');
    setTool(null);
    setCropping(false);
    syncGeo();
    syncZoombar();
    viewport.hidden = true;
    dropzone.hidden = false;
    filename.textContent = '';
    presetNote.hidden = true;
    setActivePreset(null);
    syncAll(RV.defaults());
    drawHistogram(null);
    renderStrip();
  }

  function select(id) {
    activeId = id;
    var img = active();
    if (!img) return;

    renderer.select(id);
    renderer.setWarp(img.warp && !img.warp.isEmpty() ? img.warp : null);
    viewport.hidden = false;
    dropzone.hidden = true;
    filename.textContent = img.name + '  ·  ' + img.bitmap.width + '×' + img.bitmap.height;

    syncAll(img.settings);
    syncGeo();
    BRUSH_SLIDERS.forEach(function (d) { if (d.refresh) d.refresh(); });
    presetNote.hidden = true;
    setActivePreset(null);
    renderStrip();
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
           (!img.warp || img.warp.isEmpty());
  }

  function markEdited(img) {
    var index = library.indexOf(img);
    var node = strip.children[index];
    if (node) node.classList.toggle('is-edited', !isPristine(img));
  }

  /* ---------- Render ---------- */

  function requestRender() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(function () {
      frameQueued = false;
      var img = active();
      if (!img) return;
      renderer.draw(img.settings, comparing);
      scheduleHistogram();
    });
  }

  function scheduleHistogram() {
    clearTimeout(histTimer);
    histTimer = setTimeout(function () {
      var img = active();
      if (!img) return;
      drawHistogram(renderer.histogram(img.settings));
      // El histograma se pinta en un framebuffer aparte, así que
      // hay que devolver el resultado visible al lienzo.
      renderer.draw(img.settings, comparing);
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
    var pad = 60;
    var box = renderer.fit(stage.clientWidth - pad, stage.clientHeight - pad, out.w, out.h);

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
      var img = active();
      img.settings = RV.applyPreset(result.values);
      syncAll(img.settings);
      markEdited(img);
      setActivePreset(null);
      requestRender();

      presetNote.hidden = false;
      presetNote.innerHTML = '<b>' + escapeHtml(result.name) + '</b> · ' +
        result.applied.length + ' ajustes aplicados' +
        (result.warnings.length
          ? '.<br>Sin aplicar: ' + escapeHtml(result.warnings.join(', ')) + '.'
          : '.');
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
    if (img) {
      var out = RV.outputSize(img.geo, img.bitmap.width, img.bitmap.height);
      exportMeta.textContent = out.w + ' × ' + out.h + ' px · ' +
        (nameInput.value.trim() || 'sin-nombre') + '.' + EXT[formatSel.value];
      if (cropping) exportMeta.textContent += ' · recorte en curso';
    }
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

    renderer.exportBlob(img.settings, quality, mime).then(function (blob) {
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

  var shelfBtn = $('#btn-shelf');

  function toggleShelf(force) {
    var open = typeof force === 'boolean' ? force : app.dataset.shelf !== 'open';
    app.dataset.shelf = open ? 'open' : 'closed';
    shelfBtn.setAttribute('aria-expanded', String(open));
    shelf.inert = !open;
    setTimeout(resize, 200);   // la columna cambia de ancho con transición
  }
  shelfBtn.addEventListener('click', function () { toggleShelf(); });
  toggleShelf(false);

  $('#btn-preset').addEventListener('click', function () { xmpInput.click(); });
  $('#btn-export').addEventListener('click', openExport);
  $('#btn-reset').addEventListener('click', function () {
    var img = active();
    if (!img) return;
    img.settings = RV.defaults();
    img.geo = RV.defaultGeometry();
    img.view = RV.defaultView();
    if (img.warp) { img.warp.snapshot(); img.warp.clear(); renderer.setWarp(null); }
    syncAll(img.settings);
    syncGeo();
    BRUSH_SLIDERS.forEach(function (d) { if (d.refresh) d.refresh(); });
    presetNote.hidden = true;
    setActivePreset(null);
    resize();
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
    if (brush.tool) { if (beginStroke(e)) e.preventDefault(); return; }
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
    if (!brush.tool) return;
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
    if (brush.tool && !stroke) moveRing(e.clientX, e.clientY);
  });

  $('#btn-warp-undo').addEventListener('click', warpUndo);
  $('#btn-warp-clear').addEventListener('click', warpClear);
  window.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if (e.key === '\\') setCompare(true);
    if (e.key === 'Escape') { toggleShelf(false); setTool(null); setCropping(false); closeExport(); }
    if (e.key === '0' && !e.ctrlKey && !e.metaKey) setZoom('fit');
    if (e.key === '1' && !e.ctrlKey && !e.metaKey) setZoom(100);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); warpUndo(); }
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
