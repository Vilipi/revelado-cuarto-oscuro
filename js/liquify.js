/* ============================================================
   Revelado — campo de deformación (pincel)

   La rejilla vive en CPU como Float32Array en unidades UV y se
   sube a la GPU cuantizada a 8 bits por canal. Mantener el
   original en coma flotante evita que los trazos sucesivos
   acumulen el error de cuantización.

   El campo es una lectura INVERSA: para que el píxel que está en
   A aparezca en B, en B se guarda el vector que apunta a A. Por
   eso empujar con delta Δ resta Δ del campo.

   La rejilla es densa (512 en el lado mayor) para que quepan
   pinceles pequeños, así que nada recorre el campo entero por
   trazo: cada operación toca sólo el rectángulo del pincel, y a
   la GPU sube sólo la zona sucia.
   ============================================================ */

window.RV = window.RV || {};

// Desplazamiento máximo codificable, en fracción de la imagen.
RV.WARP_RANGE = 0.14;

// Lado mayor de la rejilla. Marca el pincel más fino que tiene
// efecto: por debajo de ~2 celdas de radio el trazo se diluye.
RV.WARP_GRID = 512;

// Pasos de deshacer. Se guardan como Int16 (7,6 MB en total para una
// rejilla de 512×384, frente a 30 MB en coma flotante); la pérdida de
// precisión queda muy por debajo de lo visible.
RV.WARP_HISTORY = 12;

RV.WarpField = function (gl, imgW, imgH) {
  var long = RV.WARP_GRID;
  this.gl = gl;
  this.w = imgW >= imgH ? long : Math.max(32, Math.round(long * imgW / imgH));
  this.h = imgW >= imgH ? Math.max(32, Math.round(long * imgH / imgW)) : long;
  this.imgW = imgW;
  this.imgH = imgH;

  this.data = new Float32Array(this.w * this.h * 2);
  this.history = [];
  this.empty = true;

  // Rectángulo pendiente de subir, en celdas.
  this.dirty = null;
  this.patch = new Uint8Array(this.w * this.h * 4);

  this.tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, this.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.w, this.h, 0, gl.RGBA,
                gl.UNSIGNED_BYTE, neutral(this.w, this.h));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
};

function neutral(w, h) {
  var b = new Uint8Array(w * h * 4);
  for (var i = 0; i < b.length; i += 4) {
    b[i] = 128; b[i + 1] = 128; b[i + 2] = 0; b[i + 3] = 255;
  }
  return b;
}

RV.WarpField.prototype = {

  isEmpty: function () {
    return this.empty;
  },

  /**
   * Rectángulo de celdas que cubre el pincel. Se garantiza al menos
   * una celda: con pinceles muy finos el rectángulo exacto puede no
   * contener ningún centro de celda y el trazo se perdería.
   */
  bounds: function (cx, cy, radiusPx) {
    var rx = radiusPx / this.imgW * (this.w - 1);
    var ry = radiusPx / this.imgH * (this.h - 1);
    var px = cx * (this.w - 1), py = cy * (this.h - 1);
    return {
      i0: Math.max(0, Math.floor(px - rx)),
      i1: Math.min(this.w - 1, Math.ceil(px + rx)),
      j0: Math.max(0, Math.floor(py - ry)),
      j1: Math.min(this.h - 1, Math.ceil(py + ry))
    };
  },

  /**
   * Recorre las celdas del pincel y llama a `fn(índice, atenuación)`.
   * La distancia se mide en píxeles de imagen para que el pincel sea
   * redondo aunque la foto no lo sea.
   */
  forEachInBrush: function (cx, cy, radiusPx, fn) {
    var b = this.bounds(cx, cy, radiusPx);
    var r2 = radiusPx * radiusPx;
    var hit = false;

    for (var j = b.j0; j <= b.j1; j++) {
      var dy = (j / (this.h - 1) - cy) * this.imgH;
      for (var i = b.i0; i <= b.i1; i++) {
        var dx = (i / (this.w - 1) - cx) * this.imgW;
        var d2 = (dx * dx + dy * dy) / r2;
        if (d2 >= 1) continue;
        // Atenuación suave: plana en el centro, nula y con derivada
        // nula en el borde, así el trazo no deja escalón.
        var t = 1 - d2;
        fn((j * this.w + i) * 2, t * t);
        hit = true;
      }
    }

    // Pincel más fino que una celda: se aplica sobre la más cercana
    // para que siga respondiendo, aunque suavizado por el filtrado.
    if (!hit) {
      var i2 = Math.min(this.w - 1, Math.max(0, Math.round(cx * (this.w - 1))));
      var j2 = Math.min(this.h - 1, Math.max(0, Math.round(cy * (this.h - 1))));
      fn((j2 * this.w + i2) * 2, 1);
      b = { i0: i2, i1: i2, j0: j2, j1: j2 };
    }

    this.touch(b);
    return b;
  },

  /** Empuja el contenido en la dirección (dxUV, dyUV). */
  push: function (cx, cy, dxUV, dyUV, radiusPx, strength) {
    var data = this.data, max = RV.WARP_RANGE;
    this.forEachInBrush(cx, cy, radiusPx, function (k, fall) {
      var f = fall * strength;
      data[k]     = Math.max(-max, Math.min(max, data[k]     - dxUV * f));
      data[k + 1] = Math.max(-max, Math.min(max, data[k + 1] - dyUV * f));
    });
    this.empty = false;
  },

  /** Devuelve la zona hacia su estado sin deformar. */
  restore: function (cx, cy, radiusPx, strength) {
    var data = this.data;
    this.forEachInBrush(cx, cy, radiusPx, function (k, fall) {
      var keep = 1 - fall * strength;
      data[k]     *= keep;
      data[k + 1] *= keep;
    });
  },

  /**
   * Promedia cada celda con sus ocho vecinas: funde los escalones que
   * dejan los empujes bruscos. Copia sólo el trozo que necesita, no el
   * campo entero — con 512 celdas de lado eso sería 1,5 MB por evento
   * de puntero.
   */
  smooth: function (cx, cy, radiusPx, strength) {
    var b = this.bounds(cx, cy, radiusPx);
    var i0 = Math.max(0, b.i0 - 1), i1 = Math.min(this.w - 1, b.i1 + 1);
    var j0 = Math.max(0, b.j0 - 1), j1 = Math.min(this.h - 1, b.j1 + 1);
    var pw = i1 - i0 + 1;

    var src = new Float32Array((i1 - i0 + 1) * (j1 - j0 + 1) * 2);
    for (var j = j0; j <= j1; j++) {
      var from = (j * this.w + i0) * 2;
      src.set(this.data.subarray(from, from + pw * 2), (j - j0) * pw * 2);
    }

    var w = this.w, data = this.data;
    this.forEachInBrush(cx, cy, radiusPx, function (k, fall) {
      var cell = k / 2, x = cell % w, y = (cell - x) / w;
      for (var ch = 0; ch < 2; ch++) {
        var sum = 0, n = 0;
        for (var oy = -1; oy <= 1; oy++) {
          for (var ox = -1; ox <= 1; ox++) {
            var nx = x + ox, ny = y + oy;
            if (nx < i0 || ny < j0 || nx > i1 || ny > j1) continue;
            sum += src[((ny - j0) * pw + (nx - i0)) * 2 + ch];
            n++;
          }
        }
        var own = src[((y - j0) * pw + (x - i0)) * 2 + ch];
        data[k + ch] += (sum / n - own) * fall * strength;
      }
    });
  },

  clear: function () {
    this.data.fill(0);
    this.empty = true;
    this.touch({ i0: 0, i1: this.w - 1, j0: 0, j1: this.h - 1 });
  },

  touch: function (b) {
    if (!this.dirty) { this.dirty = { i0: b.i0, i1: b.i1, j0: b.j0, j1: b.j1 }; return; }
    var d = this.dirty;
    if (b.i0 < d.i0) d.i0 = b.i0;
    if (b.i1 > d.i1) d.i1 = b.i1;
    if (b.j0 < d.j0) d.j0 = b.j0;
    if (b.j1 > d.j1) d.j1 = b.j1;
  },

  /* ---- Historial ---- */

  snapshot: function () {
    var k = 32767 / RV.WARP_RANGE;
    var snap = new Int16Array(this.data.length);
    for (var i = 0; i < this.data.length; i++) snap[i] = Math.round(this.data[i] * k);
    this.history.push(snap);
    if (this.history.length > RV.WARP_HISTORY) this.history.shift();
  },

  undo: function () {
    if (!this.history.length) return false;
    var snap = this.history.pop();
    var k = RV.WARP_RANGE / 32767;
    var empty = true;
    for (var i = 0; i < snap.length; i++) {
      this.data[i] = snap[i] * k;
      if (snap[i] !== 0) empty = false;
    }
    this.empty = empty;
    this.touch({ i0: 0, i1: this.w - 1, j0: 0, j1: this.h - 1 });
    return true;
  },

  /* ---- GPU ---- */

  /** Sube sólo el rectángulo modificado desde la última llamada. */
  upload: function () {
    var d = this.dirty;
    if (!d) return;
    this.dirty = null;

    var gl = this.gl, data = this.data, patch = this.patch;
    var k = 0.5 / RV.WARP_RANGE;
    var pw = d.i1 - d.i0 + 1, ph = d.j1 - d.j0 + 1;
    var p = 0;

    for (var j = d.j0; j <= d.j1; j++) {
      var row = j * this.w;
      for (var i = d.i0; i <= d.i1; i++) {
        var s = (row + i) * 2;
        patch[p]     = clamp255((data[s]     * k + 0.5) * 255);
        patch[p + 1] = clamp255((data[s + 1] * k + 0.5) * 255);
        patch[p + 2] = 0;
        patch[p + 3] = 255;
        p += 4;
      }
    }

    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, d.i0, d.j0, pw, ph, gl.RGBA,
                     gl.UNSIGNED_BYTE, this.patch.subarray(0, pw * ph * 4));
  },

  dispose: function () {
    this.gl.deleteTexture(this.tex);
    this.history.length = 0;
  }
};

function clamp255(v) {
  v = Math.round(v);
  return v < 0 ? 0 : (v > 255 ? 255 : v);
}

