/* ============================================================
   Revelado — máscara de ajuste local (pincel de selección)

   Misma idea que el campo de deformación de liquify.js, pero con
   un solo canal: cada celda guarda cuánto se aplica ahí el ajuste
   local, de 0 (nada) a 1 (del todo).

   La rejilla vive en CPU como Float32Array y sube a la GPU en 8
   bits. Mantener el original en coma flotante importa: un trazo
   de pincel suma poco a poco, y con 8 bits las pasadas suaves se
   quedarían atascadas por el redondeo.

   Nada recorre la rejilla entera por trazo: cada pincelada toca
   sólo su rectángulo, y a la GPU sube sólo la zona sucia.
   ============================================================ */

window.RV = window.RV || {};

// Lado mayor de la rejilla. Más densa que la de deformación: el ojo
// perdona un empujón impreciso, pero no un borde de máscara dentado.
RV.MASK_GRID = 768;

// Pasos de deshacer. Se guardan en 8 bits, que es la misma precisión
// con la que la máscara llega al shader.
RV.MASK_HISTORY = 12;

RV.MaskField = function (gl, imgW, imgH) {
  var long = RV.MASK_GRID;
  this.gl = gl;
  this.w = imgW >= imgH ? long : Math.max(32, Math.round(long * imgW / imgH));
  this.h = imgW >= imgH ? Math.max(32, Math.round(long * imgH / imgW)) : long;
  this.imgW = imgW;
  this.imgH = imgH;

  this.data = new Float32Array(this.w * this.h);
  this.history = [];
  this.empty = true;

  // Rectángulo pendiente de subir, en celdas.
  this.dirty = null;
  this.patch = new Uint8Array(this.w * this.h * 4);

  this.tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, this.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.w, this.h, 0, gl.RGBA,
                gl.UNSIGNED_BYTE, new Uint8Array(this.w * this.h * 4));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
};

RV.MaskField.prototype = {

  isEmpty: function () {
    return this.empty;
  },

  /** Rectángulo de celdas que cubre el pincel, al menos una. */
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
   * La distancia se mide en píxeles de imagen para que el pincel salga
   * redondo aunque la foto no lo sea.
   *
   * `feather` es la fracción exterior del radio en la que el trazo se
   * desvanece: a 0 el borde es duro, a 1 el degradado ocupa todo el
   * pincel. La curva es suave en ambos extremos, así que las pasadas
   * sucesivas no dejan escalón.
   */
  forEachInBrush: function (cx, cy, radiusPx, feather, fn) {
    var b = this.bounds(cx, cy, radiusPx);
    var inner = RV.clamp(1 - feather, 0, 0.999);
    var hit = false;

    for (var j = b.j0; j <= b.j1; j++) {
      var dy = (j / (this.h - 1) - cy) * this.imgH;
      for (var i = b.i0; i <= b.i1; i++) {
        var dx = (i / (this.w - 1) - cx) * this.imgW;
        var d = Math.sqrt(dx * dx + dy * dy) / radiusPx;
        if (d >= 1) continue;
        var t = d <= inner ? 1 : 1 - (d - inner) / (1 - inner);
        fn(j * this.w + i, t * t * (3 - 2 * t));
        hit = true;
      }
    }

    // Pincel más fino que una celda: se aplica sobre la más cercana
    // para que siga respondiendo, aunque el filtrado lo suavice.
    if (!hit) {
      var i2 = Math.min(this.w - 1, Math.max(0, Math.round(cx * (this.w - 1))));
      var j2 = Math.min(this.h - 1, Math.max(0, Math.round(cy * (this.h - 1))));
      fn(j2 * this.w + i2, 1);
      b = { i0: i2, i1: i2, j0: j2, j1: j2 };
    }

    this.touch(b);
    return b;
  },

  /**
   * Añade zona a la selección. La celda se acerca a 1 sin pasarse, así
   * que insistir sobre el mismo sitio satura en vez de desbordar y el
   * trazo se puede construir en varias pasadas suaves.
   */
  paint: function (cx, cy, radiusPx, strength, feather) {
    var data = this.data;
    this.forEachInBrush(cx, cy, radiusPx, feather, function (k, fall) {
      // El techo de la celda es la atenuación del pincel en ese punto:
      // repasar acerca el valor a ese techo pero nunca lo supera, así
      // que el borde difuminado sigue difuminado por mucho que se insista.
      var v = Math.min(fall, data[k] + fall * strength);
      data[k] = v > data[k] ? v : data[k];
    });
    this.empty = false;
  },

  /** Quita zona de la selección. */
  erase: function (cx, cy, radiusPx, strength, feather) {
    var data = this.data;
    var any = false;
    this.forEachInBrush(cx, cy, radiusPx, feather, function (k, fall) {
      data[k] *= 1 - fall * strength;
      if (data[k] > 0.002) any = true;
    });
    // `any` sólo mira el rectángulo del pincel: si queda algo fuera, el
    // repintado completo lo detecta en el siguiente recuento.
    if (!any) this.refreshEmpty();
  },

  /** Selecciona la imagen entera: punto de partida para ir restando. */
  fill: function () {
    this.data.fill(1);
    this.empty = false;
    this.touch({ i0: 0, i1: this.w - 1, j0: 0, j1: this.h - 1 });
  },

  /** Invierte la selección. */
  invert: function () {
    var data = this.data;
    for (var i = 0; i < data.length; i++) data[i] = 1 - data[i];
    this.refreshEmpty();
    this.touch({ i0: 0, i1: this.w - 1, j0: 0, j1: this.h - 1 });
  },

  clear: function () {
    this.data.fill(0);
    this.empty = true;
    this.touch({ i0: 0, i1: this.w - 1, j0: 0, j1: this.h - 1 });
  },

  /** Fracción de la imagen seleccionada, 0..1. Para la pista de la interfaz. */
  coverage: function () {
    var data = this.data, sum = 0;
    for (var i = 0; i < data.length; i++) sum += data[i];
    return sum / data.length;
  },

  refreshEmpty: function () {
    var data = this.data;
    for (var i = 0; i < data.length; i++) {
      if (data[i] > 0.002) { this.empty = false; return; }
    }
    this.empty = true;
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
    var snap = new Uint8Array(this.data.length);
    for (var i = 0; i < this.data.length; i++) snap[i] = Math.round(this.data[i] * 255);
    this.history.push(snap);
    if (this.history.length > RV.MASK_HISTORY) this.history.shift();
  },

  undo: function () {
    if (!this.history.length) return false;
    var snap = this.history.pop();
    var empty = true;
    for (var i = 0; i < snap.length; i++) {
      this.data[i] = snap[i] / 255;
      if (snap[i] > 0) empty = false;
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
    var pw = d.i1 - d.i0 + 1, ph = d.j1 - d.j0 + 1;
    var p = 0;

    for (var j = d.j0; j <= d.j1; j++) {
      var row = j * this.w;
      for (var i = d.i0; i <= d.i1; i++) {
        var v = clamp255(data[row + i] * 255);
        patch[p] = v; patch[p + 1] = v; patch[p + 2] = v; patch[p + 3] = 255;
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
