/* ============================================================
   Revelado — lectura de ajustes preestablecidos .xmp
   Un .xmp de Lightroom es XMP/RDF. Los valores viven en el
   espacio de nombres `crs` (Camera Raw Settings) y aparecen de
   dos formas equivalentes:

     <rdf:Description crs:Exposure2012="+0.35" crs:Contrast2012="12"/>

     <rdf:Description>
       <crs:Exposure2012>+0.35</crs:Exposure2012>
     </rdf:Description>

   Este parser acepta las dos, ignora el prefijo real del espacio
   de nombres y avisa de lo que el editor todavía no reproduce.
   ============================================================ */

window.RV = window.RV || {};

/* ---- Conversores ------------------------------------------------------- */

// Camera Raw guarda la temperatura de dos maneras: en kelvin (presets
// pensados para RAW) o como incremento -100..100 (para JPEG). Se distinguen
// por la magnitud del número.
function kelvinToSlider(k) {
  var base = 5500;
  if (k <= base) return RV.clamp(((k - base) / 3500) * 100, -100, 0);
  return RV.clamp(((k - base) / 4500) * 100, 0, 100);
}

function absoluteTintToSlider(t) {
  return RV.clamp((t / 150) * 100, -100, 100);
}

var passthrough = function (v) { return v; };

/* ---- Tabla de correspondencias ---------------------------------------- */

// clave crs (sin prefijo) → { id del slider, conversor }
RV.XMP_MAP = {
  // Luz
  Exposure2012:   { id: 'exposure',   fn: passthrough },
  Exposure:       { id: 'exposure',   fn: passthrough },        // presets PV2003/2010
  Contrast2012:   { id: 'contrast',   fn: passthrough },
  Contrast:       { id: 'contrast',   fn: passthrough },
  Highlights2012: { id: 'highlights', fn: passthrough },
  HighlightRecovery: { id: 'highlights', fn: function (v) { return -v; } },
  Shadows2012:    { id: 'shadows',    fn: passthrough },
  FillLight:      { id: 'shadows',    fn: passthrough },
  Whites2012:     { id: 'whites',     fn: passthrough },
  Blacks2012:     { id: 'blacks',     fn: passthrough },

  // Color
  Temperature:            { id: 'temp', fn: function (v) {
                              return Math.abs(v) > 1000 ? kelvinToSlider(v) : v;
                            } },
  IncrementalTemperature: { id: 'temp', fn: passthrough },
  Tint:                   { id: 'tint', fn: function (v) {
                              return Math.abs(v) > 100 ? absoluteTintToSlider(v) : v;
                            } },
  IncrementalTint:        { id: 'tint', fn: passthrough },
  Vibrance:               { id: 'vibrance',   fn: passthrough },
  Saturation:             { id: 'saturation', fn: passthrough },

  // Detalle
  Texture:     { id: 'texture', fn: passthrough },
  Clarity2012: { id: 'clarity', fn: passthrough },
  Clarity:     { id: 'clarity', fn: passthrough },
  Sharpness:   { id: 'sharpen', fn: passthrough },
  LuminanceSmoothing: { id: 'denoise', fn: passthrough },

  // Efectos
  Dehaze:                  { id: 'dehaze',   fn: passthrough },
  DehazeAmount:            { id: 'dehaze',   fn: passthrough },
  PostCropVignetteAmount:  { id: 'vignette', fn: passthrough },
  VignetteAmount:          { id: 'vignette', fn: passthrough },
  GrainAmount:             { id: 'grain',    fn: passthrough }
};

// Claves que existen en muchos presets pero que este editor aún no reproduce.
// Se agrupan para poder decírselo al usuario en una sola frase.
RV.XMP_UNSUPPORTED = [
  // ToneCurveName por sí solo no implica curva: se descarta el nombre.
  { test: /^ToneCurve(?!Name)/,    label: 'curva de tonos' },
  { test: /^(Hue|Sat|Lum)Adjustment/, label: 'mezclador de color (HSL)' },
  { test: /^SplitToning|^ColorGrade/, label: 'graduación de color' },
  { test: /^Camera(Profile|Calibration)|^(Red|Green|Blue)Hue|^(Red|Green|Blue)Sat/, label: 'calibración de cámara' },
  { test: /^ColorNoise|^Defringe/, label: 'ruido de color y aberraciones' },
  { test: /^(Mask|CircularGradient|GradientBased|PaintBased|RetouchAreas)/, label: 'ajustes locales y máscaras' },
  { test: /^Crop|^Straighten/,     label: 'recorte' }
];

/* ---- Parser ------------------------------------------------------------ */

/**
 * Lee el texto de un .xmp y devuelve:
 *   { name, values, applied, ignored, warnings }
 * `values` contiene solo ids de slider válidos, ya recortados a su rango.
 * Lanza Error si el archivo no es XML o no contiene ajustes crs.
 */
RV.parseXMP = function (text, filename) {
  var doc = new DOMParser().parseFromString(text, 'application/xml');

  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('El archivo no es XML válido.');
  }

  var raw = Object.create(null);   // clave crs → texto

  // 1) Atributos de cualquier <rdf:Description>
  var descriptions = doc.getElementsByTagNameNS('*', 'Description');
  for (var d = 0; d < descriptions.length; d++) {
    var attrs = descriptions[d].attributes;
    for (var a = 0; a < attrs.length; a++) {
      var attr = attrs[a];
      if (isCrs(attr)) raw[localName(attr)] = attr.value;
    }
  }

  // 2) Elementos hijo con el mismo espacio de nombres
  var nodes = doc.getElementsByTagName('*');
  for (var n = 0; n < nodes.length; n++) {
    var node = nodes[n];
    if (!isCrs(node)) continue;
    var key = localName(node);
    if (key in raw) continue;
    // Solo texto directo: si tiene hijos es una estructura (curvas, máscaras).
    if (node.children.length === 0) {
      var t = (node.textContent || '').trim();
      if (t) raw[key] = t;
    } else {
      raw[key] = null;   // presente pero no interpretable
    }
  }

  var keys = Object.keys(raw);
  if (!keys.length) {
    throw new Error('No se han encontrado ajustes de Camera Raw en el archivo.');
  }

  var values = Object.create(null);
  var applied = [];
  var ignored = [];

  keys.forEach(function (key) {
    var map = RV.XMP_MAP[key];
    if (!map) { ignored.push(key); return; }

    var num = parseFloat(String(raw[key]).replace(',', '.'));
    if (!isFinite(num)) { ignored.push(key); return; }

    var adj = RV.BY_ID[map.id];
    values[map.id] = RV.clamp(map.fn(num), adj.min, adj.max);
    applied.push(adj.label);
  });

  if (!applied.length) {
    throw new Error('El preset no contiene ningún ajuste que este editor pueda aplicar.');
  }

  // Agrupa lo descartado en familias legibles.
  var warnings = [];
  RV.XMP_UNSUPPORTED.forEach(function (rule) {
    if (ignored.some(function (k) { return rule.test.test(k); })) warnings.push(rule.label);
  });

  return {
    name: presetName(doc, filename),
    values: values,
    applied: applied,
    ignored: ignored,
    warnings: warnings
  };
};

/**
 * Fusiona un preset sobre unos ajustes. Todo lo que el preset no
 * menciona vuelve a su valor por defecto, que es como se comporta
 * Lightroom al aplicar un preset completo.
 */
RV.applyPreset = function (values) {
  var next = RV.defaults();
  Object.keys(values).forEach(function (id) { next[id] = values[id]; });
  return next;
};

/* ---- Auxiliares -------------------------------------------------------- */

function isCrs(node) {
  var ns = node.namespaceURI || '';
  if (ns.indexOf('/camera-raw-settings/') !== -1) return true;
  // Algunos archivos declaran el prefijo sin URI resoluble.
  return (node.prefix || '') === 'crs';
}

function localName(node) {
  return node.localName || String(node.nodeName).split(':').pop();
}

function presetName(doc, filename) {
  var nodes = doc.getElementsByTagNameNS('*', 'Name');
  for (var i = 0; i < nodes.length; i++) {
    var t = (nodes[i].textContent || '').trim();
    if (t) return t;
  }
  return String(filename || 'Preset').replace(/\.xmp$/i, '');
}

/* ---- Escritura ---------------------------------------------------------- */

// Camino inverso al de RV.XMP_MAP. Se eligen las claves incrementales de
// temperatura y matiz porque son las que entienden los presets pensados
// para JPEG, que es lo que edita esta aplicación.
RV.CRS_OUT = {
  exposure:   'Exposure2012',
  contrast:   'Contrast2012',
  highlights: 'Highlights2012',
  shadows:    'Shadows2012',
  whites:     'Whites2012',
  blacks:     'Blacks2012',
  temp:       'IncrementalTemperature',
  tint:       'IncrementalTint',
  vibrance:   'Vibrance',
  saturation: 'Saturation',
  texture:    'Texture',
  clarity:    'Clarity2012',
  sharpen:    'Sharpness',
  denoise:    'LuminanceSmoothing',
  dehaze:     'Dehaze',
  vignette:   'PostCropVignetteAmount',
  grain:      'GrainAmount'
};

// `hue` no tiene equivalente en Camera Raw: allí el tono se ajusta por
// franjas de color, no en bloque. Se avisa al exportar en vez de
// inventar una correspondencia.
RV.CRS_UNMAPPED = ['hue'];

function xmpNumber(id, value) {
  var adj = RV.BY_ID[id];
  var v = adj.decimals ? value.toFixed(adj.decimals) : String(Math.round(value));
  return value > 0 ? '+' + v : v;
}

function xmpEscape(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

/**
 * Serializa unos ajustes como preset .xmp de Camera Raw.
 * Devuelve { text, skipped }: `skipped` lista los ajustes que no tienen
 * equivalente y se han quedado fuera.
 */
RV.toXMP = function (name, settings) {
  var lines = [];
  var skipped = [];

  RV.ALL.forEach(function (adj) {
    var v = settings[adj.id];
    if (v === adj.def) return;                    // sólo lo que se ha tocado
    var key = RV.CRS_OUT[adj.id];
    if (!key) { skipped.push(adj.label); return; }
    lines.push('    crs:' + key + '="' + xmpNumber(adj.id, v) + '"');
  });

  var text =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Revelado">\n' +
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '  <rdf:Description rdf:about=""\n' +
    '    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"\n' +
    '    crs:PresetType="Normal"\n' +
    '    crs:Cluster=""\n' +
    '    crs:SupportsAmount="True"\n' +
    '    crs:SupportsColor="True"\n' +
    '    crs:SupportsMonochrome="True"\n' +
    '    crs:Version="15.0"\n' +
    '    crs:ProcessVersion="11.0"\n' +
    (lines.length ? lines.join('\n') + '\n' : '') +
    '    crs:HasSettings="True">\n' +
    '   <crs:Name>\n' +
    '    <rdf:Alt>\n' +
    '     <rdf:li xml:lang="x-default">' + xmpEscape(name) + '</rdf:li>\n' +
    '    </rdf:Alt>\n' +
    '   </crs:Name>\n' +
    '   <crs:Group>\n' +
    '    <rdf:Alt>\n' +
    '     <rdf:li xml:lang="x-default">Revelado</rdf:li>\n' +
    '    </rdf:Alt>\n' +
    '   </crs:Group>\n' +
    '  </rdf:Description>\n' +
    ' </rdf:RDF>\n' +
    '</x:xmpmeta>\n';

  return { text: text, skipped: skipped };
};
