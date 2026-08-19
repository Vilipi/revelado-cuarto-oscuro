/* ============================================================
   Revelado — histórico de ediciones

   Un histórico por foto, al estilo del panel de historial de
   Lightroom: cada paso es una fotografía completa del estado —
   ajustes globales, encuadre, deformación y qué zonas locales
   están ya horneadas — no un delta respecto al anterior. Saltar a
   cualquier punto es entonces aplicar ese estado directamente, sin
   tener que deshacer ni rehacer nada paso a paso.

   Lo que SÍ se guarda por delta son las zonas horneadas: en vez de
   una copia de la foto entera en cada paso (carísimo), cada entrada
   guarda la lista de zonas aplicadas hasta ese momento. Volver atrás
   reconstruye los píxeles desde el original repitiendo esa lista, el
   mismo camino que ya usa "Restablecer todo".

   Lo que queda fuera a propósito: el trazo en curso del pincel de
   selección (sólo cuenta cuando se pulsa "Aplicar"), y el deshacer
   contextual con Ctrl+Z de deformación/máscara, que ya tenía su
   propio historial corto y sigue funcionando igual.
   ============================================================ */

window.RV = window.RV || {};

// Pasos que se conservan por foto. Cada uno pesa poco (números sueltos
// más, como mucho, un campo de deformación cuantizado), así que se
// puede permitir bastante más que el historial corto de un solo pincel.
RV.HISTORY_MAX = 200;

/**
 * `first` es la entrada inicial ("Original"), ya construida por quien
 * llama — el histórico no sabe nada de ajustes por defecto ni de cómo
 * son los campos de deformación.
 */
RV.HistoryLog = function (first) {
  this.entries = [first];
  this.index = 0;
};

RV.HistoryLog.prototype = {

  current: function () {
    return this.entries[this.index];
  },

  /**
   * Añade un paso nuevo a partir de la posición actual. Si el punto
   * actual no era el último (se había saltado hacia atrás), lo que
   * había después se descarta: es la misma regla que cualquier editor
   * con deshacer/rehacer al hacer un cambio nuevo a mitad de camino.
   */
  push: function (entry) {
    this.entries.length = this.index + 1;
    this.entries.push(entry);
    this.index++;
    if (this.entries.length > RV.HISTORY_MAX) {
      this.entries.shift();
      this.index--;
    }
  },

  /** Mueve el puntero a `i` y devuelve esa entrada, o null si no existe. */
  jump: function (i) {
    if (i < 0 || i >= this.entries.length || i === this.index) return null;
    this.index = i;
    return this.entries[i];
  }
};
