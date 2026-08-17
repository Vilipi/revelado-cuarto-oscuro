/* ============================================================
   Revelado — motor WebGL
   Un programa, un quad, una textura por imagen. El render es
   síncrono y barato: subir uniforms y pintar.
   ============================================================ */

window.RV = window.RV || {};

RV.Renderer = function (canvas) {
  var gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true   // necesario para toBlob() al exportar
  }) || canvas.getContext('experimental-webgl');

  if (!gl) throw new Error('Este navegador no expone WebGL.');

  this.gl = gl;
  this.canvas = canvas;
  this.textures = Object.create(null);   // id de imagen → { tex, w, h }
  this.current = null;

  this.program = compile(gl, RV.VERTEX_SRC, RV.FRAGMENT_SRC);
  gl.useProgram(this.program);

  // Quad a pantalla completa.
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(this.program, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  // Cache de localizaciones de uniforms.
  this.u = {};
  var self = this;
  ['uImage', 'uWarp', 'uTexel', 'uAspect', 'uBypass', 'uWarpOn', 'uWarpRange',
   'uView', 'uCrop', 'uOriented', 'uAngle', 'uQuarter', 'uFlip', 'uSplit']
    .concat(RV.ALL.map(function (a) { return a.uniform; }))
    .forEach(function (name) {
      self.u[name] = gl.getUniformLocation(self.program, name);
    });
  gl.uniform1i(this.u.uImage, 0);
  gl.uniform1i(this.u.uWarp, 1);
  gl.uniform1f(this.u.uWarpRange, RV.WARP_RANGE);

  // Campo neutro para cuando la imagen no está deformada: evita
  // muestrear una unidad de textura sin nada enlazado.
  this.blankWarp = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, this.blankWarp);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                new Uint8Array([128, 128, 0, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  this.warp = null;
  this.frame = null;   // { geo, rect } — lo fija la aplicación antes de dibujar
  this.split = -1;     // posición de la divisoria antes/después, o -1

  this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);

  // Destino reducido para calcular el histograma sin leer todo el lienzo.
  this.hist = createTarget(gl, 160, 160);
  this.histPixels = new Uint8Array(160 * 160 * 4);
};

function compile(gl, vsSrc, fsSrc) {
  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('Error al compilar el shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }
  var p = gl.createProgram();
  gl.attachShader(p, shader(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Error al enlazar el programa: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

function createTarget(gl, w, h) {
  var tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  var fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo: fbo, tex: tex, w: w, h: h };
}

RV.Renderer.prototype = {

  /** Sube un ImageBitmap/HTMLImageElement a la GPU y lo cachea por id. */
  upload: function (id, source) {
    var gl = this.gl;
    if (this.textures[id]) return this.textures[id];

    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    // Sin mipmaps: las dimensiones no son potencia de dos.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    var entry = { tex: tex, w: source.width, h: source.height };
    this.textures[id] = entry;
    return entry;
  },

  release: function (id) {
    var entry = this.textures[id];
    if (!entry) return;
    this.gl.deleteTexture(entry.tex);
    delete this.textures[id];
  },

  select: function (id) {
    this.current = this.textures[id] || null;
    return this.current;
  },

  /**
   * Tamaño del lienzo que encaja el resultado en el contenedor.
   * `outW`/`outH` son las dimensiones del recorte; si no se pasan, se
   * usa la imagen entera.
   */
  fit: function (boxW, boxH, outW, outH) {
    if (!this.current) return { w: 0, h: 0 };
    var w = outW || this.current.w, h = outH || this.current.h;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var scale = Math.min(boxW / w, boxH / h, 1);
    var cssW = Math.max(1, Math.round(w * scale));
    var cssH = Math.max(1, Math.round(h * scale));
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    return { w: cssW, h: cssH };
  },

  /** Asocia un RV.WarpField (o null) al render actual. */
  setWarp: function (field) {
    this.warp = field || null;
  },

  /**
   * Fija el encuadre: `geo` es una geometría de geometry.js y `rect` la
   * ventana de zoom devuelta por RV.viewRect. Pasar null vuelve al
   * fotograma completo, que es lo que usa la exportación.
   */
  /** Posición de la divisoria antes/después en 0..1, o -1 para apagarla. */
  setSplit: function (x) {
    this.split = (typeof x === 'number' && x >= 0) ? x : -1;
  },

  setFrame: function (geo, rect) {
    this.frame = geo ? { geo: geo, rect: rect || { cx: 0.5, cy: 0.5, w: 1, h: 1 } } : null;
  },

  applyUniforms: function (settings, bypass) {
    var gl = this.gl, u = this.u;
    gl.useProgram(this.program);
    gl.uniform1f(u.uBypass, bypass ? 1 : 0);
    gl.uniform2f(u.uTexel, 1 / this.current.w, 1 / this.current.h);
    gl.uniform1f(u.uWarpOn, this.warp ? 1 : 0);
    gl.uniform1f(u.uSplit, this.split);

    var f = this.frame;
    if (f) {
      var o = RV.oriented(f.geo, this.current.w, this.current.h);
      gl.uniform4f(u.uView, f.rect.cx, f.rect.cy, f.rect.w, f.rect.h);
      gl.uniform4f(u.uCrop, f.geo.x, f.geo.y, f.geo.w, f.geo.h);
      gl.uniform2f(u.uOriented, o.w, o.h);
      gl.uniform1f(u.uAngle, f.geo.angle * Math.PI / 180);
      gl.uniform1f(u.uQuarter, f.geo.quarter);
      gl.uniform2f(u.uFlip, f.geo.flipH ? 1 : 0, f.geo.flipV ? 1 : 0);
      // El viñeteado necesita la proporción del recorte, no la del original.
      gl.uniform1f(u.uAspect, (f.geo.w * o.w) / (f.geo.h * o.h));
    } else {
      gl.uniform4f(u.uView, 0.5, 0.5, 1, 1);
      gl.uniform4f(u.uCrop, 0, 0, 1, 1);
      gl.uniform2f(u.uOriented, this.current.w, this.current.h);
      gl.uniform1f(u.uAngle, 0);
      gl.uniform1f(u.uQuarter, 0);
      gl.uniform2f(u.uFlip, 0, 0);
      gl.uniform1f(u.uAspect, this.current.w / this.current.h);
    }
    for (var i = 0; i < RV.ALL.length; i++) {
      var a = RV.ALL[i];
      gl.uniform1f(u[a.uniform], settings[a.id]);
    }
  },

  draw: function (settings, bypass) {
    if (!this.current) return;
    var gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.bindTextures();
    this.applyUniforms(settings, bypass);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  },

  bindTextures: function () {
    var gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.current.tex);
    gl.activeTexture(gl.TEXTURE1);
    if (this.warp) this.warp.upload();
    gl.bindTexture(gl.TEXTURE_2D, this.warp ? this.warp.tex : this.blankWarp);
    gl.activeTexture(gl.TEXTURE0);
  },

  /** Devuelve 3 arrays de 64 bins (R, G, B) leídos de un render reducido. */
  histogram: function (settings) {
    if (!this.current) return null;
    var gl = this.gl, t = this.hist;

    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    this.bindTextures();
    this.applyUniforms(settings, false);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, this.histPixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    var bins = 64;
    var r = new Uint32Array(bins), g = new Uint32Array(bins), b = new Uint32Array(bins);
    var px = this.histPixels;
    for (var i = 0; i < px.length; i += 4) {
      r[px[i]     >> 2]++;
      g[px[i + 1] >> 2]++;
      b[px[i + 2] >> 2]++;
    }
    return { r: r, g: g, b: b, bins: bins };
  },

  /**
   * Renderiza a resolución nativa y devuelve un Blob JPG.
   * Cambia el tamaño del lienzo temporalmente; quien llame debe
   * volver a ajustar y redibujar la vista previa después.
   */
  exportBlob: function (settings, quality, mime) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!self.current) return reject(new Error('No hay imagen activa.'));
      var geo = self.frame ? self.frame.geo : null;
      var out = geo
        ? RV.outputSize(geo, self.current.w, self.current.h)
        : { w: self.current.w, h: self.current.h };

      var cap = Math.min(self.maxTexture, 16384);
      var scale = Math.min(1, cap / Math.max(out.w, out.h));
      var w = Math.max(1, Math.round(out.w * scale));
      var h = Math.max(1, Math.round(out.h * scale));

      // Se exporta el recorte entero: el zoom es sólo de pantalla.
      var saved = self.frame;
      var savedSplit = self.split;
      self.split = -1;
      if (geo) self.setFrame(geo, { cx: 0.5, cy: 0.5, w: 1, h: 1 });

      self.canvas.width = w;
      self.canvas.height = h;
      self.draw(settings, false);
      self.frame = saved;
      self.split = savedSplit;
      self.gl.finish();

      var type = mime || 'image/jpeg';
      self.canvas.toBlob(function (blob) {
        if (blob && blob.type === type) return resolve(blob);
        if (blob) return reject(new Error('Este navegador no sabe escribir ' + type + '.'));
        reject(new Error('El navegador no pudo generar el archivo.'));
      }, type, quality);
    });
  }
};

