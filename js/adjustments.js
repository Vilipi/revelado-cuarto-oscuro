/* ============================================================
   Revelado — catálogo de ajustes
   Una sola fuente de verdad: la interfaz, el shader y el parser
   de .xmp leen todos de aquí.
   ============================================================ */

window.RV = window.RV || {};

// `uniform` es el nombre en el shader. `detent` es el valor donde se
// dibuja la marca de reposo del slider.
RV.GROUPS = [
  {
    id: 'luz',
    label: 'Luz',
    items: [
      { id: 'exposure',   uniform: 'uExposure',   label: 'Exposición',    min: -5,   max: 5,   step: 0.01, def: 0, decimals: 2, sign: true },
      { id: 'contrast',   uniform: 'uContrast',   label: 'Contraste',     min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true },
      { id: 'highlights', uniform: 'uHighlights', label: 'Iluminaciones', min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true },
      { id: 'shadows',    uniform: 'uShadows',    label: 'Sombras',       min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true },
      { id: 'whites',     uniform: 'uWhites',     label: 'Blancos',       min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true },
      { id: 'blacks',     uniform: 'uBlacks',     label: 'Negros',        min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true }
    ]
  },
  {
    id: 'color',
    label: 'Color',
    items: [
      { id: 'temp',       uniform: 'uTemp',       label: 'Temperatura',   min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true },
      { id: 'tint',       uniform: 'uTint',       label: 'Matiz',         min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true },
      { id: 'hue',        uniform: 'uHue',        label: 'Tono',          min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true },
      { id: 'vibrance',   uniform: 'uVibrance',   label: 'Intensidad',    min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true },
      { id: 'saturation', uniform: 'uSaturation', label: 'Saturación',    min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true }
    ]
  },
  {
    id: 'detalle',
    label: 'Detalle',
    items: [
      { id: 'texture',    uniform: 'uTexture',    label: 'Textura',       min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true },
      { id: 'clarity',    uniform: 'uClarity',    label: 'Claridad',      min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true },
      { id: 'sharpen',    uniform: 'uSharpen',    label: 'Enfoque',       min: 0,    max: 150, step: 1,    def: 0, decimals: 0, sign: false },
      { id: 'denoise',    uniform: 'uDenoise',    label: 'Reducir ruido', min: 0,    max: 100, step: 1,    def: 0, decimals: 0, sign: false }
    ]
  },
  {
    id: 'efectos',
    label: 'Efectos',
    items: [
      { id: 'dehaze',     uniform: 'uDehaze',     label: 'Neblina',       min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true },
      { id: 'vignette',   uniform: 'uVignette',   label: 'Viñeteado',     min: -100, max: 100, step: 1,    def: 0, decimals: 0, sign: true },
      { id: 'grain',      uniform: 'uGrain',      label: 'Grano',         min: 0,    max: 100, step: 1,    def: 0, decimals: 0, sign: false }
    ]
  }
];

RV.ALL = RV.GROUPS.reduce(function (acc, g) { return acc.concat(g.items); }, []);

/* ---- Ajuste local ------------------------------------------------------- */

// Grupos que se pueden aplicar sólo sobre la zona pintada con el pincel.
// Los efectos quedan fuera a propósito: un viñeteado o un grano dentro
// de una máscara no significan nada, se definen sobre el fotograma entero.
RV.LOCAL_GROUPS = ['luz', 'color', 'detalle'];

RV.LOCAL = RV.GROUPS
  .filter(function (g) { return RV.LOCAL_GROUPS.indexOf(g.id) !== -1; })
  .reduce(function (acc, g) { return acc.concat(g.items); }, []);

// El resto viaja como uniform suelto: el shader sólo los evalúa una vez.
RV.GLOBAL_ONLY = RV.ALL.filter(function (a) { return RV.LOCAL.indexOf(a) === -1; });

RV.isLocal = function (id) {
  return RV.LOCAL.some(function (a) { return a.id === id; });
};

/** Ajustes locales en su valor de reposo: la máscara nace sin efecto. */
RV.localDefaults = function () {
  var s = {};
  RV.LOCAL.forEach(function (a) { s[a.id] = a.def; });
  return s;
};

RV.isLocalDefault = function (settings) {
  return RV.LOCAL.every(function (a) { return settings[a.id] === a.def; });
};

RV.BY_ID = RV.ALL.reduce(function (acc, a) { acc[a.id] = a; return acc; }, {});

RV.defaults = function () {
  var s = {};
  RV.ALL.forEach(function (a) { s[a.id] = a.def; });
  return s;
};

RV.isDefault = function (settings) {
  return RV.ALL.every(function (a) { return settings[a.id] === a.def; });
};

RV.clamp = function (v, min, max) {
  return v < min ? min : (v > max ? max : v);
};

RV.format = function (adj, value) {
  var v = value.toFixed(adj.decimals);
  if (adj.sign && value > 0) v = '+' + v;
  return v;
};

/* ---- Presets incluidos ------------------------------------------------- */

// Valores parciales: lo que no se menciona vuelve a su defecto al aplicar,
// igual que un preset de Lightroom. `hint` es la línea que ve el usuario.
RV.PRESETS = [
  {
    id: 'plata',
    name: 'Plata',
    hint: 'Blanco y negro neutro, medios abiertos',
    values: { saturation: -100, contrast: 16, highlights: -18, shadows: 24,
              blacks: -10, whites: 8, clarity: 14, sharpen: 40, vignette: -12 }
  },
  {
    id: 'carbon',
    name: 'Carbón',
    hint: 'Blanco y negro duro, negros cerrados',
    values: { saturation: -100, contrast: 48, highlights: -30, shadows: -12,
              blacks: -34, whites: 22, texture: 20, clarity: 30, sharpen: 62,
              dehaze: 20, vignette: -28, grain: 22 }
  },
  {
    id: 'tarde-calida',
    name: 'Tarde cálida',
    hint: 'Luz de última hora, sombras levantadas',
    values: { exposure: 0.28, contrast: 18, highlights: -42, shadows: 35,
              whites: 12, blacks: -16, temp: 20, tint: 9, vibrance: 22,
              saturation: -6, texture: 14, clarity: 10, sharpen: 45,
              vignette: -14, grain: 10 }
  },
  {
    id: 'nocturno',
    name: 'Nocturno',
    hint: 'Frío y desaturado, aire de cine',
    values: { exposure: 0.1, contrast: 14, highlights: -28, shadows: 18,
              blacks: -24, temp: -20, tint: 6, vibrance: 12, saturation: -14,
              clarity: 12, sharpen: 30, dehaze: 14, vignette: -30 }
  },
  {
    id: 'contraluz',
    name: 'Contraluz',
    hint: 'Rescata la silueta sin quemar el cielo',
    values: { exposure: 0.45, highlights: -62, shadows: 58, whites: 6,
              blacks: -12, temp: 6, vibrance: 14, clarity: 8, sharpen: 25, dehaze: 22 }
  },
  {
    id: 'piel',
    name: 'Piel suave',
    hint: 'Retrato: menos textura, más aire',
    values: { exposure: 0.15, contrast: -8, highlights: -26, shadows: 22,
              temp: 8, tint: 4, vibrance: 16, saturation: -5,
              texture: -16, clarity: -10, sharpen: 22, denoise: 18, vignette: -10 }
  }
];

