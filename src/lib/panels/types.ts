import { z } from "zod";

/**
 * Tipos de panel. Cada tipo declara su esquema de datos, su estado vacío y
 * sus operaciones (funciones puras datos → datos). Los agentes, la edición
 * manual y los tests usan exactamente las mismas operaciones.
 *
 * Añadir un tipo nuevo = añadir una entrada aquí (y su vista). La base de
 * datos guarda `data` como JSON, así que no hay que tocarla.
 */

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);
}

export interface PanelOp<D> {
  description: string;
  args: z.ZodType;
  apply: (data: D, args: never) => D;
}

export interface PanelType<D = unknown> {
  type: string;
  label: string;
  /** Breve guía para el modelo (cómo usar los datos y operaciones). */
  guide: string;
  schema: z.ZodType<D>;
  empty: () => D;
  ops: Record<string, PanelOp<D>>;
  /** Resumen de una línea (para listados y para el prompt). */
  summary: (data: D) => string;
}

function op<D, A extends z.ZodType>(description: string, args: A, apply: (data: D, args: z.infer<A>) => D): PanelOp<D> {
  return { description, args, apply: apply as (data: D, args: never) => D };
}

function notFound(what: string, id: string): never {
  throw new Error(`No existe ${what} con id «${id}».`);
}

const dateRe = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const dateStr = z.string().regex(dateRe, "Fecha en formato AAAA-MM-DD o AAAA-MM-DDTHH:MM");

// ───────────────────────── Calendario ─────────────────────────

export const calendarEvent = z.object({
  id: z.string(),
  title: z.string(),
  start: dateStr,
  end: dateStr.optional(),
  allDay: z.boolean().optional(),
  location: z.string().optional(),
  notes: z.string().optional(),
  color: z.string().optional(),
});
export type CalendarEvent = z.infer<typeof calendarEvent>;
const calendarSchema = z.object({
  events: z.array(calendarEvent).default([]),
  view: z.enum(["semana", "mes", "agenda"]).default("semana"),
  focus: z.string().optional(),
});
export type CalendarData = z.infer<typeof calendarSchema>;

const eventInput = calendarEvent.omit({ id: true }).extend({ id: z.string().optional() });

const calendar: PanelType<CalendarData> = {
  type: "calendario",
  label: "Calendario",
  guide: "Eventos con start/end en hora local (AAAA-MM-DDTHH:MM) o día completo (AAAA-MM-DD, allDay:true). focus = fecha que se muestra.",
  schema: calendarSchema,
  empty: () => ({ events: [], view: "semana" }),
  ops: {
    add_event: op("Añade un evento", eventInput, (d, a) => ({
      ...d,
      events: [...d.events, { ...a, id: a.id ?? newId(), allDay: a.allDay ?? !a.start.includes("T") }],
    })),
    update_event: op("Cambia campos de un evento", eventInput.partial().extend({ id: z.string() }), (d, a) => {
      if (!d.events.some((e) => e.id === a.id)) notFound("el evento", a.id);
      return { ...d, events: d.events.map((e) => (e.id === a.id ? { ...e, ...a } : e)) };
    }),
    remove_event: op("Quita un evento", z.object({ id: z.string() }), (d, a) => ({ ...d, events: d.events.filter((e) => e.id !== a.id) })),
    set_view: op("Cambia la vista y la fecha mostrada", z.object({ view: z.enum(["semana", "mes", "agenda"]).optional(), focus: z.string().optional() }), (d, a) => ({
      ...d,
      ...a,
    })),
  },
  summary: (d) => `${d.events.length} evento(s)`,
};

// ───────────────────────── Kanban ─────────────────────────

const card = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().optional(),
  due: z.string().optional(),
  tags: z.array(z.string()).optional(),
  priority: z.enum(["baja", "media", "alta"]).optional(),
});
export type KanbanCard = z.infer<typeof card>;
const column = z.object({ id: z.string(), title: z.string(), cards: z.array(card).default([]) });
const kanbanSchema = z.object({ columns: z.array(column).default([]) });
export type KanbanData = z.infer<typeof kanbanSchema>;
const cardInput = card.omit({ id: true }).extend({ id: z.string().optional() });

function findColumn(d: KanbanData, ref: string) {
  const c = d.columns.find((c) => c.id === ref) ?? d.columns.find((c) => c.title.toLowerCase() === ref.toLowerCase());
  return c ?? notFound("la columna", ref);
}

const kanban: PanelType<KanbanData> = {
  type: "kanban",
  label: "Tablero",
  guide: "Columnas con tarjetas. Las columnas se pueden referir por id o por título.",
  schema: kanbanSchema,
  empty: () => ({
    columns: [
      { id: "pendiente", title: "Pendiente", cards: [] },
      { id: "en-curso", title: "En curso", cards: [] },
      { id: "hecho", title: "Hecho", cards: [] },
    ],
  }),
  ops: {
    add_column: op("Añade una columna", z.object({ title: z.string(), id: z.string().optional() }), (d, a) => ({
      columns: [...d.columns, { id: a.id ?? newId(), title: a.title, cards: [] }],
    })),
    rename_column: op("Renombra una columna", z.object({ column: z.string(), title: z.string() }), (d, a) => {
      const col = findColumn(d, a.column);
      return { columns: d.columns.map((c) => (c.id === col.id ? { ...c, title: a.title } : c)) };
    }),
    remove_column: op("Quita una columna y sus tarjetas", z.object({ column: z.string() }), (d, a) => {
      const col = findColumn(d, a.column);
      return { columns: d.columns.filter((c) => c.id !== col.id) };
    }),
    add_card: op("Añade una tarjeta a una columna", cardInput.extend({ column: z.string() }), (d, a) => {
      const col = findColumn(d, a.column);
      const { column: _c, ...rest } = a;
      return { columns: d.columns.map((c) => (c.id === col.id ? { ...c, cards: [...c.cards, { ...rest, id: rest.id ?? newId() }] } : c)) };
    }),
    update_card: op("Cambia campos de una tarjeta", cardInput.partial().extend({ id: z.string() }), (d, a) => {
      if (!d.columns.some((c) => c.cards.some((k) => k.id === a.id))) notFound("la tarjeta", a.id);
      return { columns: d.columns.map((c) => ({ ...c, cards: c.cards.map((k) => (k.id === a.id ? { ...k, ...a } : k)) })) };
    }),
    move_card: op(
      "Mueve una tarjeta a otra columna (y posición opcional)",
      z.object({ id: z.string(), column: z.string(), index: z.number().int().optional() }),
      (d, a) => {
        const target = findColumn(d, a.column);
        const moving = d.columns.flatMap((c) => c.cards).find((k) => k.id === a.id) ?? notFound("la tarjeta", a.id);
        const columns = d.columns.map((c) => ({ ...c, cards: c.cards.filter((k) => k.id !== a.id) }));
        return {
          columns: columns.map((c) => {
            if (c.id !== target.id) return c;
            const cards = c.cards.slice();
            cards.splice(a.index ?? cards.length, 0, moving);
            return { ...c, cards };
          }),
        };
      },
    ),
    remove_card: op("Quita una tarjeta", z.object({ id: z.string() }), (d, a) => ({
      columns: d.columns.map((c) => ({ ...c, cards: c.cards.filter((k) => k.id !== a.id) })),
    })),
  },
  summary: (d) => d.columns.map((c) => `${c.title}: ${c.cards.length}`).join(" · "),
};

// ───────────────────────── Lista ─────────────────────────

const item = z.object({ id: z.string(), text: z.string(), done: z.boolean().default(false), notes: z.string().optional(), due: z.string().optional() });
export type ListItem = z.infer<typeof item>;
const listSchema = z.object({ items: z.array(item).default([]), checkable: z.boolean().default(true) });
export type ListData = z.infer<typeof listSchema>;
const itemInput = item.omit({ id: true }).extend({ id: z.string().optional(), done: z.boolean().optional() });

const list: PanelType<ListData> = {
  type: "lista",
  label: "Lista",
  guide: "Elementos con casilla (checkable:false para listas sin casillas).",
  schema: listSchema,
  empty: () => ({ items: [], checkable: true }),
  ops: {
    add_item: op("Añade un elemento", itemInput.extend({ index: z.number().int().optional() }), (d, a) => {
      const { index, ...rest } = a;
      const items = d.items.slice();
      items.splice(index ?? items.length, 0, { ...rest, id: rest.id ?? newId(), done: rest.done ?? false });
      return { ...d, items };
    }),
    update_item: op("Cambia un elemento", itemInput.partial().extend({ id: z.string() }), (d, a) => {
      if (!d.items.some((i) => i.id === a.id)) notFound("el elemento", a.id);
      return { ...d, items: d.items.map((i) => (i.id === a.id ? { ...i, ...a } : i)) };
    }),
    toggle_item: op("Marca o desmarca un elemento", z.object({ id: z.string(), done: z.boolean().optional() }), (d, a) => ({
      ...d,
      items: d.items.map((i) => (i.id === a.id ? { ...i, done: a.done ?? !i.done } : i)),
    })),
    move_item: op("Mueve un elemento a otra posición", z.object({ id: z.string(), index: z.number().int() }), (d, a) => {
      const it = d.items.find((i) => i.id === a.id) ?? notFound("el elemento", a.id);
      const items = d.items.filter((i) => i.id !== a.id);
      items.splice(a.index, 0, it);
      return { ...d, items };
    }),
    remove_item: op("Quita un elemento", z.object({ id: z.string() }), (d, a) => ({ ...d, items: d.items.filter((i) => i.id !== a.id) })),
    set_checkable: op("Activa o quita las casillas", z.object({ checkable: z.boolean() }), (d, a) => ({ ...d, checkable: a.checkable })),
  },
  summary: (d) => `${d.items.filter((i) => i.done).length}/${d.items.length} hechos`,
};

// ───────────────────────── Tabla ─────────────────────────

const colType = z.enum(["texto", "numero", "moneda", "fecha", "si/no", "porcentaje"]);
const tableColumn = z.object({ key: z.string(), label: z.string(), type: colType.default("texto"), total: z.boolean().optional() });
export type TableColumn = z.infer<typeof tableColumn>;
const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const row = z.object({ id: z.string(), cells: z.record(z.string(), cellValue) });
export type TableRow = z.infer<typeof row>;
const tableSchema = z.object({ columns: z.array(tableColumn).default([]), rows: z.array(row).default([]), currency: z.string().default("EUR") });
export type TableData = z.infer<typeof tableSchema>;

const table: PanelType<TableData> = {
  type: "tabla",
  label: "Tabla",
  guide: "columns: [{key,label,type(texto|numero|moneda|fecha|si/no|porcentaje),total?}]; rows: [{cells:{key:valor}}]. total:true suma la columna.",
  schema: tableSchema,
  empty: () => ({ columns: [{ key: "concepto", label: "Concepto", type: "texto" }], rows: [], currency: "EUR" }),
  ops: {
    set_columns: op("Define las columnas", z.object({ columns: z.array(tableColumn) }), (d, a) => ({ ...d, columns: a.columns })),
    add_column: op("Añade una columna", tableColumn, (d, a) => ({ ...d, columns: [...d.columns.filter((c) => c.key !== a.key), a] })),
    remove_column: op("Quita una columna", z.object({ key: z.string() }), (d, a) => ({
      ...d,
      columns: d.columns.filter((c) => c.key !== a.key),
      rows: d.rows.map((r) => {
        const { [a.key]: _x, ...cells } = r.cells;
        return { ...r, cells };
      }),
    })),
    add_row: op("Añade una fila", z.object({ id: z.string().optional(), cells: z.record(z.string(), cellValue) }), (d, a) => ({
      ...d,
      rows: [...d.rows, { id: a.id ?? newId(), cells: a.cells }],
    })),
    update_row: op("Cambia celdas de una fila", z.object({ id: z.string(), cells: z.record(z.string(), cellValue) }), (d, a) => {
      if (!d.rows.some((r) => r.id === a.id)) notFound("la fila", a.id);
      return { ...d, rows: d.rows.map((r) => (r.id === a.id ? { ...r, cells: { ...r.cells, ...a.cells } } : r)) };
    }),
    remove_row: op("Quita una fila", z.object({ id: z.string() }), (d, a) => ({ ...d, rows: d.rows.filter((r) => r.id !== a.id) })),
    set_currency: op("Moneda (EUR, USD…)", z.object({ currency: z.string() }), (d, a) => ({ ...d, currency: a.currency })),
  },
  summary: (d) => `${d.rows.length} fila(s), ${d.columns.length} columna(s)`,
};

export function tableTotals(d: TableData): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of d.columns) {
    if (!c.total) continue;
    out[c.key] = d.rows.reduce((s, r) => s + (Number(r.cells[c.key]) || 0), 0);
  }
  return out;
}

// ───────────────────────── Notas ─────────────────────────

const notesSchema = z.object({ markdown: z.string().default("") });
export type NotesData = z.infer<typeof notesSchema>;

const notes: PanelType<NotesData> = {
  type: "notas",
  label: "Notas",
  guide: "Texto en markdown.",
  schema: notesSchema,
  empty: () => ({ markdown: "" }),
  ops: {
    set_text: op("Sustituye todo el texto", z.object({ markdown: z.string() }), (_d, a) => ({ markdown: a.markdown })),
    append_text: op("Añade texto al final", z.object({ markdown: z.string() }), (d, a) => ({
      markdown: d.markdown ? `${d.markdown.replace(/\s+$/, "")}\n\n${a.markdown}` : a.markdown,
    })),
    replace_text: op("Reemplaza un fragmento exacto", z.object({ find: z.string(), replace: z.string() }), (d, a) => {
      if (!d.markdown.includes(a.find)) throw new Error("No encuentro ese fragmento en las notas.");
      return { markdown: d.markdown.replace(a.find, a.replace) };
    }),
  },
  summary: (d) => `${d.markdown.split(/\s+/).filter(Boolean).length} palabras`,
};

// ───────────────────────── Gráfico ─────────────────────────

const series = z.object({ name: z.string(), values: z.array(z.number()), color: z.string().optional() });
const chartSchema = z.object({
  kind: z.enum(["barras", "lineas", "area", "tarta"]).default("barras"),
  labels: z.array(z.string()).default([]),
  series: z.array(series).default([]),
  unit: z.string().optional(),
});
export type ChartData = z.infer<typeof chartSchema>;

const chart: PanelType<ChartData> = {
  type: "grafico",
  label: "Gráfico",
  guide: "kind: barras|lineas|area|tarta. labels (eje X o porciones) y series con un valor por etiqueta.",
  schema: chartSchema,
  empty: () => ({ kind: "barras", labels: [], series: [] }),
  ops: {
    set_chart: op("Define el gráfico entero", chartSchema.partial(), (d, a) => ({ ...d, ...a })),
    add_point: op(
      "Añade una etiqueta con un valor por serie",
      z.object({ label: z.string(), values: z.record(z.string(), z.number()) }),
      (d, a) => ({
        ...d,
        labels: [...d.labels, a.label],
        series: d.series.map((s) => ({ ...s, values: [...s.values, a.values[s.name] ?? 0] })),
      }),
    ),
    set_series: op("Añade o sustituye una serie", series, (d, a) => ({ ...d, series: [...d.series.filter((s) => s.name !== a.name), a] })),
    remove_series: op("Quita una serie", z.object({ name: z.string() }), (d, a) => ({ ...d, series: d.series.filter((s) => s.name !== a.name) })),
  },
  summary: (d) => `${d.kind}, ${d.labels.length} punto(s), ${d.series.length} serie(s)`,
};

// ───────────────────────── Hábitos y progreso ─────────────────────────

const habit = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.number().optional(),
  unit: z.string().optional(),
  color: z.string().optional(),
  /** Registro por día: true/false o cantidad. */
  log: z.record(z.string(), z.union([z.boolean(), z.number()])).default({}),
});
export type Habit = z.infer<typeof habit>;
const habitsSchema = z.object({ habits: z.array(habit).default([]) });
export type HabitsData = z.infer<typeof habitsSchema>;

const habits: PanelType<HabitsData> = {
  type: "habitos",
  label: "Hábitos",
  guide: "Hábitos con registro diario (log por fecha AAAA-MM-DD: true/false o cantidad). goal+unit para progreso (p. ej. 8 vasos).",
  schema: habitsSchema,
  empty: () => ({ habits: [] }),
  ops: {
    add_habit: op(
      "Añade un hábito",
      habit.omit({ id: true, log: true }).extend({ id: z.string().optional() }),
      (d, a) => ({ habits: [...d.habits, { ...a, id: a.id ?? newId(), log: {} }] }),
    ),
    update_habit: op("Cambia un hábito", habit.omit({ log: true }).partial().extend({ id: z.string() }), (d, a) => ({
      habits: d.habits.map((h) => (h.id === a.id ? { ...h, ...a } : h)),
    })),
    log: op(
      "Registra un día (value: true/false o cantidad)",
      z.object({ id: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), value: z.union([z.boolean(), z.number()]) }),
      (d, a) => {
        if (!d.habits.some((h) => h.id === a.id)) notFound("el hábito", a.id);
        return { habits: d.habits.map((h) => (h.id === a.id ? { ...h, log: { ...h.log, [a.date]: a.value } } : h)) };
      },
    ),
    remove_habit: op("Quita un hábito", z.object({ id: z.string() }), (d, a) => ({ habits: d.habits.filter((h) => h.id !== a.id) })),
  },
  summary: (d) => `${d.habits.length} hábito(s)`,
};

/** Racha actual de días cumplidos hasta `today` (incluido si ya está hecho). */
export function habitStreak(h: Habit, today: string): number {
  const done = (v: boolean | number | undefined) => (typeof v === "number" ? (h.goal ? v >= h.goal : v > 0) : Boolean(v));
  let streak = 0;
  const d = new Date(today + "T12:00:00");
  if (!done(h.log[today])) d.setDate(d.getDate() - 1);
  while (done(h.log[d.toISOString().slice(0, 10)])) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

// ───────────────────────── Registro ─────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PANEL_TYPES: Record<string, PanelType<any>> = {
  calendario: calendar,
  kanban,
  lista: list,
  tabla: table,
  notas: notes,
  grafico: chart,
  habitos: habits,
};

export function getPanelType(type: string): PanelType {
  const t = PANEL_TYPES[type];
  if (!t) throw new Error(`Tipo de panel desconocido: ${type}. Tipos: ${Object.keys(PANEL_TYPES).join(", ")}.`);
  return t;
}

/** Valida y normaliza datos de un tipo (rellena valores por defecto). */
export function normalizeData(type: string, data: unknown): unknown {
  const t = getPanelType(type);
  const parsed = t.schema.safeParse(data ?? t.empty());
  if (!parsed.success) throw new Error(`Datos no válidos para ${t.label}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export interface OpInput {
  op: string;
  [k: string]: unknown;
}

/** Aplica una operación (validando argumentos) y devuelve los datos nuevos. */
export function applyOp(type: string, data: unknown, input: OpInput): unknown {
  const t = getPanelType(type);
  const { op: name, ...args } = input;
  const def = t.ops[name];
  if (!def) throw new Error(`Operación «${name}» no existe en ${t.label}. Disponibles: ${Object.keys(t.ops).join(", ")}.`);
  const parsed = def.args.safeParse(args);
  if (!parsed.success) throw new Error(`Argumentos de ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return normalizeData(type, def.apply(data as never, parsed.data as never));
}

/** Firma legible de los argumentos de una operación: add_event(title, start, end?). */
function signature(name: string, schema: z.ZodType): string {
  const shape = (schema as unknown as { shape?: Record<string, z.ZodType> }).shape;
  if (!shape) return `${name}(…)`;
  const args = Object.entries(shape).map(([k, v]) => (v.safeParse(undefined).success ? `${k}?` : k));
  return `${name}(${args.join(", ")})`;
}

/** Guía compacta de todos los tipos y operaciones (para el modelo). */
export function opsGuide(): string {
  return Object.values(PANEL_TYPES)
    .map((t) => `- ${t.type}: ${t.guide}\n  ops: ${Object.entries(t.ops).map(([n, o]) => signature(n, o.args)).join("; ")}`)
    .join("\n");
}
