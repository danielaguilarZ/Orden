/**
 * Nombres comprensibles de cada tipo de panel y plantillas rápidas para
 * crear uno con un clic. Sin dependencias de servidor (los usa la interfaz).
 */

export interface PanelTypeInfo {
  /** Nombre corto y claro. */
  name: string;
  /** Para qué sirve, en una frase. */
  hint: string;
  icon: string;
}

/** En el orden en que se ofrecen al crear un panel en blanco. */
export const TYPE_INFO: Record<string, PanelTypeInfo> = {
  lista: { name: "Lista", hint: "Cosas que marcar como hechas", icon: "☑" },
  kanban: { name: "Tablero", hint: "Tarjetas en columnas: por hacer, haciendo, hecho", icon: "▥" },
  calendario: { name: "Calendario", hint: "Citas y eventos por día", icon: "▦" },
  tabla: { name: "Tabla", hint: "Filas y columnas con totales (gastos, inventario…)", icon: "▤" },
  notas: { name: "Notas", hint: "Texto libre", icon: "✎" },
  habitos: { name: "Hábitos", hint: "Marca cada día lo que quieres repetir", icon: "✓" },
  grafico: { name: "Gráfico", hint: "Barras, líneas o tarta", icon: "▟" },
};

export interface PanelTemplate {
  id: string;
  name: string;
  hint: string;
  type: string;
  /** Título con el que se crea (se puede cambiar después). */
  title: string;
  data: unknown;
}

/** Plantillas rápidas. `today` (AAAA-MM-DD) centra el calendario en hoy. */
export function panelTemplates(today: string): PanelTemplate[] {
  return [
    {
      id: "tareas",
      name: "Tareas de la semana",
      hint: "Tablero con «Por hacer», «Haciendo» y «Hecho»",
      type: "kanban",
      title: "Tareas de la semana",
      data: {
        columns: [
          { id: "por-hacer", title: "Por hacer", cards: [] },
          { id: "haciendo", title: "Haciendo", cards: [] },
          { id: "hecho", title: "Hecho", cards: [] },
        ],
      },
    },
    {
      id: "compra",
      name: "Lista de la compra",
      hint: "Lista con casillas para ir tachando",
      type: "lista",
      title: "Lista de la compra",
      data: { items: [], checkable: true },
    },
    {
      id: "agenda",
      name: "Agenda",
      hint: "Calendario semanal para tus citas",
      type: "calendario",
      title: "Agenda",
      data: { events: [], view: "semana", focus: today },
    },
    {
      id: "gastos",
      name: "Gastos del mes",
      hint: "Tabla con concepto, categoría, fecha e importe (con total)",
      type: "tabla",
      title: "Gastos del mes",
      data: {
        columns: [
          { key: "concepto", label: "Concepto", type: "texto" },
          { key: "categoria", label: "Categoría", type: "texto" },
          { key: "fecha", label: "Fecha", type: "fecha" },
          { key: "importe", label: "Importe", type: "moneda", total: true },
        ],
        rows: [],
        currency: "EUR",
      },
    },
    {
      id: "habitos",
      name: "Hábitos diarios",
      hint: "Agua, ejercicio y lectura, con registro por día",
      type: "habitos",
      title: "Hábitos diarios",
      data: {
        habits: [
          { id: "agua", name: "Beber agua", goal: 8, unit: "vasos", log: {} },
          { id: "ejercicio", name: "Hacer ejercicio", log: {} },
          { id: "leer", name: "Leer 20 minutos", log: {} },
        ],
      },
    },
    {
      id: "notas",
      name: "Notas",
      hint: "Una hoja en blanco para apuntar ideas",
      type: "notas",
      title: "Notas",
      data: { markdown: "" },
    },
  ];
}

/** Nombre claro de un tipo (o el propio tipo si no se conoce). */
export function typeName(type: string): string {
  return TYPE_INFO[type]?.name ?? type;
}
