/* ============================================================
   Revelado — shaders
   Todo el revelado ocurre en una sola pasada de fragmento.
   Orden: deformación → ruido → detalle → neblina → linealizar →
          balance de blancos → luz → sRGB → contraste → color →
          viñeteado y grano.
   ============================================================ */

window.RV = window.RV || {};

RV.VERTEX_SRC = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  // El quad va de -1 a 1; la textura se voltea en Y porque las
  // imágenes llegan con el origen arriba a la izquierda.
  vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

RV.FRAGMENT_SRC = `
precision highp float;

varying vec2 vUV;

uniform sampler2D uImage;
uniform sampler2D uWarp;   // campo de desplazamiento del pincel (RG)
uniform vec2  uTexel;      // 1.0 / tamaño de la imagen en píxeles
uniform float uAspect;     // ancho / alto
uniform float uWarpOn;
uniform float uWarpRange;  // desplazamiento máximo codificable, en UV
uniform float uBypass;     // 1.0 = mostrar el original
uniform float uSplit;      // < 0 desactivado; si no, corte vertical en 0..1

uniform vec4  uView;       // cx, cy, ancho, alto de la ventana de zoom
uniform vec4  uCrop;       // x, y, ancho, alto del recorte
uniform vec2  uOriented;   // tamaño de la imagen tras los giros de 90°
uniform float uAngle;      // enderezado, en radianes
uniform float uQuarter;    // giros de 90° horarios, 0..3
uniform vec2  uFlip;       // 0 o 1 por eje

uniform float uExposure;   // pasos de diafragma, -5..5
uniform float uContrast;   // -100..100
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;

uniform float uTemp;       // -100..100 (frío → cálido)
uniform float uTint;       // -100..100 (verde → magenta)
uniform float uHue;        // -100..100 → ±60°
uniform float uVibrance;
uniform float uSaturation;

uniform float uTexture;
uniform float uClarity;
uniform float uSharpen;    // 0..150
uniform float uDenoise;    // 0..100

uniform float uDehaze;     // -100..100
uniform float uVignette;   // -100..100 (negativo oscurece esquinas)
uniform float uGrain;      // 0..100

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float luma(vec3 c) { return dot(c, LUMA); }

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

vec3 toSRGB(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

// Rotación de tono alrededor del eje acromático: más barata que pasar
// por HSV y sin la discontinuidad del ángulo.
vec3 hueShift(vec3 c, float angle) {
  const vec3 k = vec3(0.57735027);
  float ca = cos(angle);
  return c * ca + cross(k, c) * sin(angle) + k * dot(k, c) * (1.0 - ca);
}

// Desenfoque gaussiano aproximado de la luminancia (9 muestras, pesos 1-2-4).
float blurLuma(vec2 uv, float radius) {
  vec2 o = uTexel * radius;
  float s = luma(texture2D(uImage, uv).rgb) * 4.0;
  s += luma(texture2D(uImage, uv + vec2( o.x, 0.0)).rgb) * 2.0;
  s += luma(texture2D(uImage, uv + vec2(-o.x, 0.0)).rgb) * 2.0;
  s += luma(texture2D(uImage, uv + vec2( 0.0,  o.y)).rgb) * 2.0;
  s += luma(texture2D(uImage, uv + vec2( 0.0, -o.y)).rgb) * 2.0;
  s += luma(texture2D(uImage, uv + vec2( o.x,  o.y)).rgb);
  s += luma(texture2D(uImage, uv + vec2(-o.x, -o.y)).rgb);
  s += luma(texture2D(uImage, uv + vec2( o.x, -o.y)).rgb);
  s += luma(texture2D(uImage, uv + vec2(-o.x,  o.y)).rgb);
  return s / 16.0;
}

// La misma cruz, pero en color: hace falta para la reducción de ruido.
vec3 blurRGB(vec2 uv, float radius) {
  vec2 o = uTexel * radius;
  vec3 s = texture2D(uImage, uv).rgb * 4.0;
  s += texture2D(uImage, uv + vec2( o.x, 0.0)).rgb * 2.0;
  s += texture2D(uImage, uv + vec2(-o.x, 0.0)).rgb * 2.0;
  s += texture2D(uImage, uv + vec2( 0.0,  o.y)).rgb * 2.0;
  s += texture2D(uImage, uv + vec2( 0.0, -o.y)).rgb * 2.0;
  s += texture2D(uImage, uv + vec2( o.x,  o.y)).rgb;
  s += texture2D(uImage, uv + vec2(-o.x, -o.y)).rgb;
  s += texture2D(uImage, uv + vec2( o.x, -o.y)).rgb;
  s += texture2D(uImage, uv + vec2(-o.x,  o.y)).rgb;
  return s / 16.0;
}

/**
 * De coordenadas del lienzo a coordenadas de la imagen original.
 * El gemelo de esta función vive en geometry.js (RV.toSource): si se
 * cambia una, hay que cambiar la otra o el pincel dejará de caer donde
 * el usuario apunta.
 */
vec2 sourceUV(vec2 v) {
  // Zoom y encuadre, sobre el recorte.
  vec2 uv = uView.xy + (v - 0.5) * uView.zw;

  // Recorte, sobre la imagen orientada.
  uv = uCrop.xy + uv * uCrop.zw;

  // Enderezado: la rotación se hace en píxeles, no en UV, o el ángulo
  // se deformaría con la proporción del fotograma.
  vec2 p = (uv - 0.5) * uOriented;
  float s = sin(uAngle), c = cos(uAngle);
  uv = vec2(c * p.x - s * p.y, s * p.x + c * p.y) / uOriented + 0.5;

  uv = mix(uv, vec2(1.0) - uv, uFlip);

  if (uQuarter > 2.5)      uv = vec2(1.0 - uv.y, uv.x);
  else if (uQuarter > 1.5) uv = vec2(1.0) - uv;
  else if (uQuarter > 0.5) uv = vec2(uv.y, 1.0 - uv.x);

  return uv;
}

float noise(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  // ---- Encuadre: zoom, recorte, enderezado y giros ----
  vec2 base = sourceUV(vUV);

  // ---- Deformación ----
  // El campo guarda una lectura inversa: para llevar el píxel A a la
  // posición B, en B se almacena el vector que apunta de vuelta a A.
  vec2 uv = base;
  if (uWarpOn > 0.5) {
    vec2 d = texture2D(uWarp, base).rg * 2.0 - 1.0;
    uv = clamp(base + d * uWarpRange, 0.0, 1.0);
  }

  // Comparar con el original conserva el encuadre: se comparan los
  // ajustes, no el reencuadre. uSplit hace lo mismo pero sólo a la
  // izquierda de la divisoria.
  if (uBypass > 0.5 || (uSplit >= 0.0 && vUV.x < uSplit)) {
    gl_FragColor = vec4(texture2D(uImage, base).rgb, 1.0);
    return;
  }

  vec3 c = texture2D(uImage, uv).rgb;
  float l0 = luma(c);

  // ---- Reducción de ruido ----
  // Se toma la crominancia del desenfoque y se devuelve la luminancia
  // original: limpia el color sin fundir el detalle.
  if (uDenoise > 0.0) {
    float a = uDenoise / 100.0;
    vec3 b = blurRGB(uv, 1.6);
    c = mix(c, b + vec3(l0 - luma(b)), a);
    c = mix(c, b, a * 0.30);
    l0 = luma(c);
  }

  // ---- Detalle: máscara de enfoque a tres radios ----
  if (uSharpen > 0.0) {
    c += vec3(l0 - blurLuma(uv, 1.0)) * (uSharpen / 100.0) * 1.6;
  }
  if (uTexture != 0.0) {
    c += vec3(l0 - blurLuma(uv, 2.5)) * (uTexture / 100.0) * 1.1;
  }
  if (uClarity != 0.0) {
    // La claridad solo actúa en los medios tonos, como en Camera Raw.
    float mid = 1.0 - pow(abs(l0 * 2.0 - 1.0), 1.6);
    c += vec3(l0 - blurLuma(uv, 9.0)) * (uClarity / 100.0) * 1.3 * mid;
  }
  c = clamp(c, 0.0, 1.0);

  // ---- Neblina: contraste local de radio muy amplio + punto de negro ----
  if (uDehaze != 0.0) {
    float a = uDehaze / 100.0;
    c += vec3(luma(c) - blurLuma(uv, 22.0)) * a * 0.85;
    c = clamp(c, 0.0, 1.0);
    c = clamp((c - 0.035 * a) / max(1.0 - 0.035 * a, 0.25), 0.0, 1.0);
  }

  // ---- A luz lineal para exposición y balance de blancos ----
  vec3 lin = toLinear(c);

  float t = uTemp / 100.0;
  float g = uTint / 100.0;
  lin.r *= 1.0 + 0.32 * t + 0.10 * g;
  lin.g *= 1.0 - 0.14 * g;
  lin.b *= 1.0 - 0.32 * t + 0.10 * g;

  lin *= exp2(uExposure);

  // Sombras y negros suman luz (multiplicar no levanta un negro puro);
  // luces y blancos multiplican, que es como se comportan al recortar.
  float l = luma(lin);
  lin += (uShadows / 100.0) * (1.0 - smoothstep(0.0, 0.45, l)) * 0.10;
  lin += (uBlacks  / 100.0) * (1.0 - smoothstep(0.0, 0.16, l)) * 0.05;
  lin *= 1.0 + (uHighlights / 100.0) * smoothstep(0.25, 1.00, l) * 0.80;
  lin *= 1.0 + (uWhites     / 100.0) * smoothstep(0.45, 1.60, l) * 0.70;

  c = clamp(toSRGB(max(lin, 0.0)), 0.0, 1.0);

  // ---- Contraste: curva en S sobre valores de pantalla ----
  float k = uContrast / 100.0;
  if (k > 0.0) {
    c = mix(c, c * c * (3.0 - 2.0 * c), k * 0.9);
  } else {
    c = mix(c, (c - 0.5) * 0.5 + 0.5, -k);
  }

  // ---- Color ----
  if (uHue != 0.0) {
    c = clamp(hueShift(c, (uHue / 100.0) * 1.0472), 0.0, 1.0);
  }

  float lc  = luma(c);
  float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
  // La intensidad protege lo que ya está saturado (y de paso los tonos de piel).
  c = mix(vec3(lc), c, 1.0 + (uVibrance / 100.0) * (1.0 - sat));
  c = mix(vec3(lc), c, 1.0 + uSaturation / 100.0 + max(uDehaze, 0.0) / 100.0 * 0.20);

  // ---- Viñeteado: sobre la posición real del fotograma, no la deformada ----
  if (uVignette != 0.0) {
    vec2 frame = uView.xy + (vUV - 0.5) * uView.zw;
    vec2 p = (frame - 0.5) * vec2(uAspect, 1.0);
    float r = length(p) / (length(vec2(uAspect, 1.0)) * 0.5);
    c *= 1.0 + (uVignette / 100.0) * smoothstep(0.35, 1.05, r) * 0.90;
  }

  // ---- Grano: más presente en los medios tonos, como el de película ----
  if (uGrain > 0.0) {
    float n = noise(gl_FragCoord.xy) - 0.5;
    float mid = 1.0 - pow(abs(luma(c) * 2.0 - 1.0), 2.0);
    c += n * (uGrain / 100.0) * 0.16 * mid;
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

