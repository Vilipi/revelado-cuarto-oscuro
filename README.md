# Revelado

Editor fotográfico web al estilo Lightroom. Render en WebGL, importación de
presets `.xmp` de Camera Raw, exportación a JPG a resolución nativa, y
retoque local con pincel de selección.

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
├─ styles.css            Tokens de color/tipografía + rejilla + sliders
├─ js/
│  ├─ adjustments.js     Catálogo de ajustes globales y locales + presets
│  ├─ shaders.js         GLSL: vértice + fragmento con pipeline de revelado
│  ├─ geometry.js        Recorte, ángulo, giros, volteos y encuadre de zoom
│  ├─ liquify.js         Campo de deformación del pincel (rejilla + historial)
│  ├─ mask.js            Máscara de selección para ajustes locales (rejilla)
│  ├─ history.js         Histórico de ediciones: pasos y salto entre ellos
│  ├─ renderer.js        Contexto WebGL, texturas, histograma, exportación
│  ├─ xmp.js             Parser de .xmp y mapeo crs:* → sliders
│  └─ app.js             Interfaz, biblioteca, eventos, bucle de render
└─ presets/
   └─ Tarde-calida.xmp   Preset de ejemplo para probar el importador
```

`adjustments.js` es la única fuente de verdad de los ajustes. Añadir un control
nuevo son tres pasos: una entrada en `RV.GROUPS`, un `uniform` en el fragment
shader con ese mismo nombre, y (si aplica) una fila en `RV.XMP_MAP`. La
interfaz y el mapeo de uniforms se generan solos.

## Ajustes globales y locales

Los ajustes se dividen en dos categorías:

### Globales (toda la foto)

Luz, Color, Detalle, Encuadre y Deformar aplican a la imagen completa. Se
puede acceder a ellos por el botón «Toda la foto» del selector de alcance.

### Locales (zona con pincel)

Luz, Color y Detalle también disponibles por zona: selecciona el botón «Pincel»
en el selector de alcance y pinta la zona sobre la que quieres aplicar
ajustes locales.

**Flujo de trabajo:**

1. Cambia a modo «Pincel»
2. Pinta la zona con el pincel (ajusta el tamaño con el slider)
3. La zona se ve teñida en rojo (desactiva «Ver la zona seleccionada» para
   ocultarla)
4. Ajusta Luz, Color y Detalle: solo afectan la zona pintada
5. Cuando estés satisfecho, haz clic en «Aplicar» para fijar la zona
6. La máscara se borra y puedes pintar otra zona, sin perder los retoques
   anteriores

El retoque local suma aditivamente con los ajustes globales, limitado a los
rangos de cada slider para evitar saturación.

**Salir sin pulsar «Aplicar».** Cambiar a «Toda la foto» con una zona
pintada todavía pendiente la fija sola, exactamente como si se hubiera
pulsado el botón — no hay forma de dejarla a medias colgando fuera del modo
que la creó. Si se pintó una zona pero no se tocó ningún ajuste, se
descarta en silencio en vez de fijar un horneado sin ningún efecto detrás.

## Pipeline de imagen

Una sola pasada de fragmento, sin render targets intermedios (excepto durante
el baking de zonas locales):

1. **Detalle** — máscara de enfoque sobre la luminancia a tres radios
   (enfoque ≈1 px, textura ≈2,5 px, claridad ≈9 px con máscara de medios tonos).
2. **Linealizar** — de sRGB a luz lineal.
3. **Balance de blancos** — ganancias por canal a partir de temperatura y matiz.
4. **Luz** — exposición como `exp2(pasos)`; sombras y negros suman luz,
   iluminaciones y blancos multiplican. Es deliberado: multiplicar un negro
   puro no lo levanta nunca.
5. **Ajustes locales** — si hay máscara activa, suma los ajustes locales a los
   globales en cada píxel (solo luz, color y detalle).
6. **Volver a sRGB** — y ahí el contraste (curva en S) y el color
   (intensidad protegiendo lo ya saturado, luego saturación global).
7. **Viñeteado y grano** — efectos finales que se aplican una sola vez después
   de mezclar.

Al aceptar una zona local («Aplicar»), se dibuja el resultado de los ajustes
sobre un framebuffer con la máscara, se reorienta según la deformación
acumulada, y se reescribe la textura de la imagen. Los píxeles enmascarados
quedan con el retoque fijo; los no enmascarados vuelven al original.

## Máscara de selección local

Vive en `mask.js` como `Float32Array` en una rejilla de 768 px de lado mayor
(escala adaptada al aspecto de la imagen), con precisión de un trazo suave:
cada celda guarda 0..1 cuánto se aplica ahí el ajuste local. Se sube a GPU
cuantizada a 8 bits con `upload()`.

**No recorre la rejilla entera por trazo.** Cada pincelada toca solo su
rectángulo, y `texSubImage2D` sube ese rectángulo solamente: un trazo pequeño
mueve unos pocos KB en lugar de la textura completa. El radio del pincel se
expresa en píxeles de imagen para que salga redondo aunque la foto no sea
cuadrada.

Cuatro herramientas de pincel:

- **Pintar**: suma zona a la selección; insistir suavemente satura en lugar de
  desbordar.
- **Borrar**: resta zona de la selección.
- **Todo**: selecciona la imagen entera (punto de partida para ir restando).
- **Invertir**: invierte la selección.

Cada trazo hace `snapshot()` antes de empezar: `Ctrl+Z` deshace hasta 12.

Cuando haces clic en «Pintar», el botón cambia a «Aplicar» y aparece el botón
«Borrar» al lado. Esto te recuerda que tienes zona pintada y lista para fijar.

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

Nota: Deformar y el pincel de selección no pueden usarse a la vez — es el mismo
gesto sobre la foto. Al cambiar a modo «Pincel», el grupo Deformar desaparece
del panel entero, junto con Encuadre y Efectos: ninguno de los tres admite
ajuste local, así que no hay nada que hacer ahí mientras se pinta una zona.

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
- Las máscaras de selección local usan texturas 8-bit: cada trazo sube solo el
  rectángulo del pincel, no el campo entero.

## Presets

La balda izquierda (abierta por defecto; el tirador pegado al borde de la
foto la abre y la cierra, `Esc` también la cierra) lista seis presets
incluidos definidos en `RV.PRESETS`, dentro de `adjustments.js`. Cada uno es
un objeto parcial: lo que no menciona vuelve a su valor por defecto al
aplicarse, igual que en Lightroom.

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

## Histórico

Panel «Histórico» en la balda izquierda, debajo de Presets — las dos
secciones se pliegan por separado y, si se abren a la vez, se reparten el
alto disponible en vez de superponerse. Es la que se ve por defecto al
arrancar (Presets empieza plegado). Al estilo del panel de historial de
Lightroom: cada paso de edición queda como una línea con su etiqueta
(«Exposición +0,50», «Recortar», «Preset: Tarde cálida», «Zona aplicada»…), el
más reciente arriba, y pulsar cualquiera de ellas vuelve la foto exactamente a
ese punto — sliders, encuadre, deformación y zonas locales horneadas incluidos.
Si desde un paso antiguo se hace un cambio nuevo, lo que había después se
descarta, igual que el «rehacer» de cualquier editor.

Vive en `history.js` como `RV.HistoryLog`, una por foto. Cada paso es una
fotografía completa del estado, no una diferencia respecto al anterior:
saltar a cualquier punto es aplicar ese estado directamente, sin reproducir
los pasos intermedios. Lo único que se guarda por delta son las zonas locales
horneadas — una copia de la foto entera en cada paso sería demasiado caro —,
así que cada entrada guarda la lista de zonas aplicadas hasta ese momento
(máscara cuantizada a 8 bits + ajustes) y volver atrás las rehace desde el
original en el mismo orden, el mismo camino que ya usa «Restablecer todo»
para deshacerlas.

Qué genera un paso: soltar un slider global (no cada tick del arrastre, sólo
al soltar), aplicar o quitar un preset y mover su intensidad, cualquier cambio
de encuadre (recorte, ángulo, proporción, giro, volteo), una zona de pincel
aplicada, un trazo de deformación, y «Restablecer todo». Lo que queda fuera a
propósito: el trazo en curso del pincel de selección —sólo cuenta al pulsar
«Aplicar»— y el deshacer contextual con `Ctrl+Z` de deformación y máscara, que
conserva su propio historial corto de siempre y no interactúa con éste.

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
  `mask` → `history` → `renderer` → `xmp` → `app`. `renderer.js` usa
  `RV.oriented` y `RV.outputSize`, así que `geometry.js` tiene que ir antes.
  `mask.js` crea la clase `RV.MaskField` que usa `renderer.js`. `history.js`
  no depende de ningún otro módulo, sólo lo usa `app.js`.
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
- Nombrar los pasos del histórico a mano, y marcar uno como «instantánea» para
  no perderlo cuando el límite de `RV.HISTORY_MAX` empiece a descartar los
  más antiguos.
