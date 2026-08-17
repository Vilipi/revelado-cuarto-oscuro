# Revelado

Editor fotográfico web al estilo Lightroom. Render en WebGL, importación de
presets `.xmp` de Camera Raw y exportación a JPG a resolución nativa.

## Cómo ejecutarlo

Doble clic en `index.html`. No hace falta servidor: los scripts son clásicos
(sin `type="module"`) precisamente para que funcione desde `file://`, y las
imágenes entran por `<input type="file">`, así que el lienzo nunca se
contamina y `toBlob()` sigue funcionando.

Si prefieres servidor: `npx serve .`

## Estructura

```
revelado/
├─ index.html            Marcado: barra, balda de presets, escenario, panel, tira
├─ css/
│  └─ styles.css         Tokens de color/tipografía + rejilla + sliders
├─ js/
│  ├─ adjustments.js     Catálogo de ajustes + presets incluidos
│  ├─ shaders.js         GLSL: vértice + fragmento con todo el revelado
│  ├─ geometry.js        Recorte, ángulo, giros, volteos y encuadre de zoom
│  ├─ liquify.js         Campo de deformación del pincel (rejilla + historial)
│  ├─ renderer.js        Contexto WebGL, texturas, histograma, exportación
│  ├─ xmp.js             Parser de .xmp y mapeo crs:* → sliders
│  └─ app.js             Interfaz, biblioteca, eventos, bucle de render
└─ presets/
   └─ Tarde-calida.xmp   Preset de ejemplo para probar el importador
```

`adjustments.js` es la única fuente de verdad. Añadir un control nuevo son
tres pasos: una entrada en `RV.GROUPS`, un `uniform` en el fragment shader con
ese mismo nombre, y (si aplica) una fila en `RV.XMP_MAP`. La interfaz y el
mapeo de uniforms se generan solos.

## Pipeline de imagen

Una sola pasada de fragmento, sin render targets intermedios:

1. **Detalle** — máscara de enfoque sobre la luminancia a tres radios
   (enfoque ≈1 px, textura ≈2,5 px, claridad ≈9 px con máscara de medios tonos).
2. **Linealizar** — de sRGB a luz lineal.
3. **Balance de blancos** — ganancias por canal a partir de temperatura y matiz.
4. **Luz** — exposición como `exp2(pasos)`; sombras y negros suman luz,
   iluminaciones y blancos multiplican. Es deliberado: multiplicar un negro
   puro no lo levanta nunca.
5. **Volver a sRGB** — y ahí el contraste (curva en S) y el color
   (intensidad protegiendo lo ya saturado, luego saturación global).

El radio de los desenfoques se expresa en texels de la **imagen original**, no
del lienzo, para que la vista previa y el JPG exportado coincidan. Como
contrapartida, el enfoque en vista ajustada se aprecia poco: hay que juzgarlo
sobre el archivo exportado, igual que en Lightroom fuera del 1:1.

## Encuadre y zoom

Ni el recorte ni el giro tocan un solo píxel: son un cambio de coordenadas en
el muestreo. La cadena, de la pantalla hacia la imagen original, es

    pantalla → zoom → recorte → enderezado → volteos → giros de 90°

y vive dos veces: en `sourceUV()` dentro del fragment shader, y en
`RV.toSource()` dentro de `geometry.js`. **Son gemelas y hay que tocarlas a la
vez** — la versión JS es la que permite que el pincel siga cayendo donde el
usuario apunta cuando la foto está girada o ampliada.

El enderezado rota en espacio de píxeles, no de UV, o el ángulo se deformaría
con la proporción del fotograma. Y al enderezar, `normalizeCrop()` encoge el
recorte hasta que sus cuatro esquinas vuelven a caber, igual que Lightroom: a
12° sobre un 4:3 el recorte baja al 79,6 %.

El zoom no cambia el tamaño del lienzo, sólo la ventana `uView` que se muestrea:
el lienzo siempre encaja el recorte en el escenario. Eso mantiene la exportación
al margen del zoom y evita reasignar búferes al ampliar. `RV.ZOOM_STEPS` define
los saltos; rueda del ratón para acercar sobre el puntero, arrastrar para
desplazar, `0` para ajustar y `1` para el 100 %. El porcentaje de la barra
alterna entre ajustar y 100 % al pulsarlo.

En modo recorte se dibuja el fotograma entero y el rectángulo se superpone en
HTML, para que se vea lo que se está dejando fuera. El velo son cuatro sombras
de una sola caja (`box-shadow: 0 0 0 9999px`), más barato que recortar una
máscara.

## Comparar antes y después

Dos formas, y hacen cosas distintas. Mantener pulsado sobre la foto (o la tecla
`\`) sustituye toda la vista por el original. El botón **Antes / después** bajo
la foto añade una divisoria vertical arrastrable: a su izquierda el original, a
su derecha el revelado.

Ambas conservan el encuadre a propósito — se comparan los ajustes, no el
reencuadre —, y ninguna llega al archivo exportado. La divisoria es el uniform
`uSplit`: por debajo de cero está apagada; si no, marca el corte en coordenadas
de pantalla.

La zona de agarre mide 21 px pero la línea visible es de uno solo: la anchura
está en el elemento y la marca en su pseudoelemento.

## Pincel de deformación

Empuja el contenido de la imagen como el Licuar de Photoshop. El campo de
desplazamiento vive en `liquify.js` como `Float32Array` en unidades UV sobre
una rejilla de 512 px de lado mayor, y se sube a la GPU cuantizado a 8 bits.
Mantener el original en coma flotante es lo que evita que veinte trazos
seguidos acumulen el error de cuantización.

La rejilla es densa para que quepan pinceles finos —el mínimo son 7 px de
diámetro sobre una foto de 1200 px de lado corto—, así que **nada recorre el
campo entero por trazo**. Cada operación toca sólo el rectángulo del pincel, y
`upload()` sube ese rectángulo con `texSubImage2D`: un trazo pequeño mueve
0,1 kB en lugar de los 768 kB de la textura completa. `smooth()` copia
únicamente su parche, no el campo.

El tamaño del pincel va en escala logarítmica (0,3 % a 60 % del lado corto):
entre los dos extremos hay un factor 200, y en escala lineal todo el rango fino
se aplastaría en los primeros píxeles del slider. La lectura se muestra en
píxeles, que es lo que uno tiene en la cabeza al retocar.

El campo es una lectura **inversa**: para que el píxel de A aparezca en B, en B
se guarda el vector que apunta de vuelta a A. Por eso `push()` **resta** el
delta del arrastre. Es el detalle que más se atraganta al implementar esto: si
lo sumas, la imagen se mueve al revés.

Tres herramientas. **Empujar** arrastra el contenido con el puntero.
**Suavizar** promedia cada celda con sus ocho vecinas, lo que quita las aristas
que dejan los empujes bruscos sin devolver la zona a su sitio: es el intermedio
entre empujar y restaurar. **Restaurar** sí devuelve la zona a su estado sin
deformar, de forma gradual. El radio se mide en píxeles
de imagen, no de pantalla, así que el pincel es redondo aunque la foto no sea
cuadrada, y el trazo sale igual en la vista previa que en el archivo exportado.

Cada trazo hace `snapshot()` antes de empezar: `Ctrl+Z` deshace hasta 12. Las
copias se guardan como `Int16Array` — 9 MB de historial por foto en vez de 30, y
el error al deshacer queda en 0,003 px, muy por debajo de lo visible.
El desplazamiento máximo es ±14 % de la imagen (`RV.WARP_RANGE`); pasado eso el
estirado empieza a verse. `RV.WARP_GRID` fija la finura de la rejilla y con ella
el pincel más pequeño que tiene efecto.

Como el campo se resuelve antes de cualquier muestreo, todo lo demás —enfoque,
claridad, ruido— trabaja ya sobre la imagen deformada, que es el orden
correcto. El viñeteado es la excepción deliberada: usa la posición real del
fotograma para no curvarse con la deformación.

## Escribir los valores

El número de cada slider es un campo de texto, no una etiqueta: arrastrar va
bien para buscar, pero para clavar «exposición −0,33» hace falta escribirlo.
`Enter` confirma, `Esc` descarta, y se acepta la coma decimal. El estilo sólo
delata que es editable al acercarse, para que el panel se siga leyendo como una
lista de valores y no como un formulario. El ángulo del recorte funciona igual.

## Rendimiento

- Una textura por imagen, cacheada en `renderer.textures` y reutilizada al
  cambiar de foto. Editar solo sube uniforms y pinta un triángulo.
- Los `input` de los sliders van a un `requestAnimationFrame` con guarda, así
  que arrastrar rápido nunca encola más de un frame.
- El histograma se calcula en un framebuffer de 160×160 con `readPixels`
  (~100 kB) y va debounced a 70 ms. Leer el lienzo completo en cada frame sería
  lo que tumbaría la interactividad.
- La vista previa se limita a `devicePixelRatio` 2. La exportación sube el
  lienzo a resolución nativa, dibuja, genera el blob y lo devuelve al tamaño de
  vista. El diálogo permite elegir nombre, formato (JPG, WebP, PNG) y calidad;
  el nombre se limpia de separadores de ruta y caracteres reservados.
- El grano se genera a partir de `gl_FragCoord`, así que su tamaño va en
  píxeles de pantalla: en el JPG exportado se ve más fino que en la vista
  previa. Es la única parte del pipeline que no es resolución-independiente.

## Presets

La balda izquierda (interruptor «Presets» en la barra, `Esc` para cerrarla)
lista seis presets incluidos definidos en `RV.PRESETS`, dentro de
`adjustments.js`. Cada uno es un objeto parcial: lo que no menciona vuelve a su
valor por defecto al aplicarse, igual que en Lightroom.

**Intensidad y quitar.** Al aplicar un preset se guarda el estado previo en
`presetSel.before`. Con eso, el slider de intensidad mezcla entre ese estado y
el preset completo (al 100 % es exactamente el preset; al 0 %, lo que había), y
volver a pulsar el preset activo lo retira devolviendo el estado anterior. Tocar
cualquier slider a mano suelta el preset: a partir de ahí ya no es él.

Los `.xmp` importados entran por el mismo camino, así que también se gradúan y
se quitan.

**Guardar y exportar.** «Guardar ajustes como preset» recoge todo lo que difiere
del valor por defecto y lo añade a la lista «Míos», con botones para exportarlo
como `.xmp` (↓) o borrarlo (×). La escritura la hace `RV.toXMP()` en `xmp.js`,
el camino inverso al parser; hay una prueba de ida y vuelta que comprueba que
todo lo escrito se vuelve a leer idéntico. La excepción es **Tono**, que no
tiene equivalente en Camera Raw —allí el tono se ajusta por franjas de color, no
en bloque—, así que se queda fuera y se avisa al exportar.

La persistencia usa la API de almacenamiento de artefactos si existe, el
navegador si no, y sólo la sesión en último caso. Guardar nunca debe romper la
aplicación, así que todo va envuelto.

En estrecho (<940 px) la balda se superpone en lugar de empujar el escenario.

## Biblioteca

La tira inferior gestiona el conjunto: la última celda abre el selector de
archivos y cada miniatura muestra una × al pasar por encima. Con el foco en una
miniatura, `Supr` la quita y `Enter` la selecciona. Al quitar una imagen se
libera su textura de la GPU, se revoca el object URL y se cierra el
`ImageBitmap`; si era la activa, pasa a la siguiente o vuelve al estado vacío.

## Formato .xmp

`RV.parseXMP(texto, nombre)` devuelve `{ name, values, applied, ignored, warnings }`.

Cubre las dos formas en que Camera Raw guarda los valores (atributos de
`rdf:Description` y elementos hijo), resuelve por espacio de nombres en vez de
por prefijo, y distingue la temperatura absoluta en kelvin (presets para RAW)
de la incremental −100..100 (presets para JPEG) por la magnitud del número:
6400 K se convierte a +20 en el slider tomando 5500 K como neutro.

Lo que el preset trae y aún no se reproduce —curva de tonos, HSL, graduación
de color, grano, viñeteado, máscaras— se agrupa en `warnings` y se muestra bajo
los paneles, para que nadie crea que está viendo el preset completo.

## Si quieres portarlo

- **Tailwind**: los sliders (`::-webkit-slider-thumb`, la marca de reposo con
  `--detent`) y el histograma necesitan CSS real de todos modos. Lo razonable
  es mover a utilidades el layout y la barra, y dejar `.ctl` como componente en
  una capa `@layer components`.
- **Orden de carga**: `adjustments` → `shaders` → `geometry` → `liquify` →
  `renderer` → `xmp` → `app`. `renderer.js` usa `RV.oriented` y
  `RV.outputSize`, así que `geometry.js` tiene que ir antes.
- **Vite / ESM**: cambia los `window.RV` por `export`/`import` y añade
  `type="module"` en `index.html`. Los ficheros ya están separados por
  responsabilidad, no hay dependencias cruzadas más allá de `adjustments.js`.

## Siguientes pasos naturales

- Curva de tonos: LUT 1D de 256 px como segunda textura, aplicada antes del
  bloque de color. Es lo que más acerca el resultado al preset original.
- HSL: convertir a HSV en el shader y modular por sectores de tono.
- Recorte y rotación: pasa por transformar el UV en el vértice, no por tocar
  el fragmento.
- Copiar y pegar ajustes entre fotos de la biblioteca: el estado ya vive por
  imagen en `item.settings`, es solo interfaz.
