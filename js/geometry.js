/* ============================================================
   Revelado — geometría

   Todo el encuadre es un cambio de coordenadas en el muestreo:
   ni se recortan píxeles ni se rota ningún búfer. La cadena, de
   la pantalla hacia la imagen original, es

     pantalla → zoom → recorte → enderezado → volteos → giros

   `toSource()` reproduce en JS exactamente lo que hace el shader.
   Hace falta para que el pincel siga cayendo donde toca cuando la
   foto está girada, recortada o ampliada.
   ============================================================ */

window.RV = window.RV || {};

RV.RATIOS = [
  { id: 'libre',  label: 'Libre',    value: null },
  { id: 'orig',   label: 'Original', value: 'orig' },
  { id: '1:1',    label: '1:1',      value: 1 },
  { id: '4:5',    label: '4:5',      value: 4 / 5 },
  { id: '3:2',    label: '3:2',      value: 3 / 2 },
  { id: '16:9',   label: '16:9',     value: 16 / 9 }
];

RV.ZOOM_STEPS = [25, 50, 75, 100, 150, 200, 400, 800];

RV.defaultGeometry = function () {
  return {
    x: 0, y: 0, w: 1, h: 1,   // recorte, normalizado sobre la imagen orientada
    angle: 0,                 // enderezado en grados, -45..45
    quarter: 0,               // giros de 90° en sentido horario, 0..3
    flipH: false,
    flipV: false,
    ratio: 'libre'
  };
};

RV.isDefaultGeometry = function (g) {
  return g.x === 0 && g.y === 0 && g.w === 1 && g.h === 1 &&
         g.angle === 0 && g.quarter === 0 && !g.flipH && !g.flipV;
};

/** Tamaño de la imagen una vez aplicados los giros de 90°. */
RV.oriented = function (geo, imgW, imgH) {
  return geo.quarter % 2
    ? { w: imgH, h: imgW }
    : { w: imgW, h: imgH };
};

/** Tamaño en píxeles del resultado recortado: lo que se exporta. */
RV.outputSize = function (geo, imgW, imgH) {
  var o = RV.oriented(geo, imgW, imgH);
  return {
    w: Math.max(1, Math.round(geo.w * o.w)),
    h: Math.max(1, Math.round(geo.h * o.h))
  };
};

function clamp(v, lo, hi) {
  if (lo > hi) return (lo + hi) / 2;
  return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * Encoge y recoloca el recorte para que, con el ángulo actual, sus
 * cuatro esquinas sigan cayendo dentro del fotograma. Es lo que hace
 * Lightroom al enderezar: el recorte se estrecha en lugar de dejar
 * esquinas vacías.
 */
RV.normalizeCrop = function (geo, imgW, imgH) {
  var o = RV.oriented(geo, imgW, imgH);
  var a = Math.abs(geo.angle) * Math.PI / 180;
  var ca = Math.cos(a), sa = Math.sin(a);

  geo.w = clamp(geo.w, 0.02, 1);
  geo.h = clamp(geo.h, 0.02, 1);

  // El centro se guarda ANTES de encoger: si no, reducir el ancho
  // arrastraría el recorte hacia la izquierda en cada ajuste.
  var cx = geo.x + geo.w / 2;
  var cy = geo.y + geo.h / 2;

  var wpx = geo.w * o.w, hpx = geo.h * o.h;
  var fit = Math.min(o.w / (wpx * ca + hpx * sa),
                     o.h / (wpx * sa + hpx * ca));
  // Sólo se encoge si de verdad no cabe, y con un pelo de margen: a
  // tamaño exacto el redondeo deja asomar el borde del fotograma.
  if (fit < 1) {
    var s = fit * 0.9995;
    geo.w *= s; geo.h *= s; wpx *= s; hpx *= s;
  }

  // Medio ancho y medio alto del rectángulo YA girado.
  var mw = (wpx * ca + hpx * sa) / o.w / 2;
  var mh = (wpx * sa + hpx * ca) / o.h / 2;

  geo.x = clamp(cx, mw, 1 - mw) - geo.w / 2;
  geo.y = clamp(cy, mh, 1 - mh) - geo.h / 2;
  return geo;
};

/** Ajusta el recorte a una proporción, conservando el centro. */
RV.applyRatio = function (geo, imgW, imgH, ratioId) {
  geo.ratio = ratioId;
  var def = RV.RATIOS.filter(function (r) { return r.id === ratioId; })[0];
  if (!def || def.value === null) return geo;

  var o = RV.oriented(geo, imgW, imgH);
  var target = def.value === 'orig' ? imgW / imgH : def.value;
  // Si el fotograma está de pie, la proporción se entiende de pie.
  if (o.w < o.h && target > 1) target = 1 / target;

  var cx = geo.x + geo.w / 2, cy = geo.y + geo.h / 2;
  // Rectángulo mayor con esa proporción que cabe en el fotograma.
  var wpx = o.w, hpx = wpx / target;
  if (hpx > o.h) { hpx = o.h; wpx = hpx * target; }

  geo.w = wpx / o.w;
  geo.h = hpx / o.h;
  geo.x = cx - geo.w / 2;
  geo.y = cy - geo.h / 2;
  return RV.normalizeCrop(geo, imgW, imgH);
};

/** Proporción actual del recorte, en píxeles. */
RV.cropAspect = function (geo, imgW, imgH) {
  var o = RV.oriented(geo, imgW, imgH);
  return (geo.w * o.w) / (geo.h * o.h);
};

/* ---- Encuadre de zoom ---------------------------------------------------- */

RV.defaultView = function () {
  return { zoom: 'fit', cx: 0.5, cy: 0.5 };
};

/**
 * Traduce el estado de zoom a la ventana visible sobre el recorte.
 * `cssW` es el ancho del lienzo en píxeles CSS.
 * Devuelve { cx, cy, w, h, pct, fitPct }.
 */
RV.viewRect = function (view, geo, imgW, imgH, cssW) {
  var out = RV.outputSize(geo, imgW, imgH);
  var fitPct = (cssW / out.w) * 100;

  if (view.zoom === 'fit') {
    return { cx: 0.5, cy: 0.5, w: 1, h: 1, pct: fitPct, fitPct: fitPct };
  }

  var pct = view.zoom;
  var size = clamp(fitPct / pct, 0.02, 1);   // fracción visible del recorte
  var half = size / 2;
  return {
    cx: clamp(view.cx, half, 1 - half),
    cy: clamp(view.cy, half, 1 - half),
    w: size,
    h: size,
    pct: pct,
    fitPct: fitPct
  };
};

/* ---- Mismo mapeo que el shader, en JS ------------------------------------ */

/**
 * De coordenadas del lienzo (0..1, origen arriba a la izquierda) a
 * coordenadas de la imagen original. Espejo exacto de `sourceUV()`
 * en el fragment shader: si se toca uno, hay que tocar el otro.
 */
RV.toSource = function (vx, vy, geo, rect, imgW, imgH) {
  var o = RV.oriented(geo, imgW, imgH);

  var ux = rect.cx + (vx - 0.5) * rect.w;
  var uy = rect.cy + (vy - 0.5) * rect.h;

  ux = geo.x + ux * geo.w;
  uy = geo.y + uy * geo.h;

  var a = geo.angle * Math.PI / 180;
  var s = Math.sin(a), c = Math.cos(a);
  var px = (ux - 0.5) * o.w, py = (uy - 0.5) * o.h;
  ux = (c * px - s * py) / o.w + 0.5;
  uy = (s * px + c * py) / o.h + 0.5;

  if (geo.flipH) ux = 1 - ux;
  if (geo.flipV) uy = 1 - uy;

  var q = geo.quarter;
  if (q === 1)      return { x: uy, y: 1 - ux };
  else if (q === 2) return { x: 1 - ux, y: 1 - uy };
  else if (q === 3) return { x: 1 - uy, y: ux };
  return { x: ux, y: uy };
};

/**
 * Convierte un desplazamiento del puntero en el lienzo a un
 * desplazamiento en la imagen original. El pincel lo necesita para
 * empujar en la dirección correcta cuando la foto está girada.
 */
RV.deltaToSource = function (dvx, dvy, geo, rect, imgW, imgH) {
  var a = RV.toSource(0.5, 0.5, geo, rect, imgW, imgH);
  var b = RV.toSource(0.5 + dvx, 0.5 + dvy, geo, rect, imgW, imgH);
  return { x: b.x - a.x, y: b.y - a.y };
};

