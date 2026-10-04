import { z } from "zod";

/**
 * Horarios de rutinas (en la hora local del PC). Sin cron críptico: tipos
 * pensados para un formulario y para que un agente los entienda.
 */

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora en formato HH:MM");

export const scheduleSchema = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("diaria"), hora: time }),
  z.object({ tipo: z.literal("laborables"), hora: time }),
  z.object({
    tipo: z.literal("semanal"),
    hora: time,
    /** 1 = lunes … 7 = domingo */
    dias: z.array(z.number().int().min(1).max(7)).min(1),
  }),
  z.object({
    tipo: z.literal("mensual"),
    hora: time,
    /** Día del mes (1-31) o -1 para el último día. Si el mes es corto, se usa el último. */
    dia: z.number().int().min(-1).max(31).refine((d) => d !== 0, "Día 0 no existe"),
  }),
  z.object({ tipo: z.literal("intervalo"), minutos: z.number().int().min(5).max(60 * 24 * 7) }),
  z.object({ tipo: z.literal("una_vez"), cuando: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "AAAA-MM-DDTHH:MM") }),
]);

export type Schedule = z.infer<typeof scheduleSchema>;

const DAY_NAMES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

function at(d: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const x = new Date(d);
  x.setHours(h, m, 0, 0);
  return x;
}

/** 1 = lunes … 7 = domingo */
const isoDow = (d: Date) => ((d.getDay() + 6) % 7) + 1;

function lastDayOfMonth(y: number, m: number) {
  return new Date(y, m + 1, 0).getDate();
}

/**
 * Próxima ejecución estrictamente posterior a `after`. Devuelve null si ya no
 * habrá más (rutina de una vez ya pasada).
 */
export function nextRun(s: Schedule, after: Date): Date | null {
  switch (s.tipo) {
    case "intervalo":
      return new Date(after.getTime() + s.minutos * 60_000);
    case "una_vez": {
      const [date, hm] = s.cuando.split("T");
      const [y, mo, d] = date.split("-").map(Number);
      const t = at(new Date(y, mo - 1, d), hm);
      return t > after ? t : null;
    }
    case "mensual": {
      for (let i = 0; i < 14; i++) {
        const base = new Date(after.getFullYear(), after.getMonth() + i, 1);
        const last = lastDayOfMonth(base.getFullYear(), base.getMonth());
        const day = s.dia === -1 ? last : Math.min(s.dia, last);
        const t = at(new Date(base.getFullYear(), base.getMonth(), day), s.hora);
        if (t > after) return t;
      }
      return null;
    }
    default: {
      const allowed = s.tipo === "diaria" ? [1, 2, 3, 4, 5, 6, 7] : s.tipo === "laborables" ? [1, 2, 3, 4, 5] : s.dias;
      for (let i = 0; i < 8; i++) {
        const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() + i);
        if (!allowed.includes(isoDow(day))) continue;
        const t = at(day, s.hora);
        if (t > after) return t;
      }
      return null;
    }
  }
}

/** Descripción en español: «cada lunes y jueves a las 08:00». */
export function describeSchedule(s: Schedule): string {
  switch (s.tipo) {
    case "diaria":
      return `cada día a las ${s.hora}`;
    case "laborables":
      return `de lunes a viernes a las ${s.hora}`;
    case "semanal": {
      const names = [...s.dias].sort().map((d) => DAY_NAMES[d - 1]);
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} y ${names.at(-1)}` : names[0];
      return `cada ${list} a las ${s.hora}`;
    }
    case "mensual":
      return `${s.dia === -1 ? "el último día" : `el día ${s.dia}`} de cada mes a las ${s.hora}`;
    case "intervalo":
      return s.minutos % 60 === 0 ? `cada ${s.minutos / 60 === 1 ? "hora" : `${s.minutos / 60} horas`}` : `cada ${s.minutos} minutos`;
    case "una_vez":
      return `una vez, el ${s.cuando.replace("T", " a las ")}`;
  }
}

/** Plantillas de rutina sugeridas (las que se pidieron como ejemplo). */
export const ROUTINE_TEMPLATES: { name: string; prompt: string; schedule: Schedule; chiefOnly?: boolean }[] = [
  {
    name: "Resumen de cada mañana",
    prompt:
      "Prepara el resumen del día: eventos de hoy en los calendarios, tareas pendientes y fechas límite cercanas en los paneles, y algo relevante de la memoria. Déjalo en el panel de notas «Resumen del día» (créalo si no existe) y responde con 3-5 viñetas.",
    schedule: { tipo: "diaria", hora: "08:00" },
    chiefOnly: true,
  },
  {
    name: "Revisión semanal de proyectos",
    prompt:
      "Revisa los proyectos abiertos (memoria y paneles): qué avanzó, qué está bloqueado y cuáles son los próximos pasos. Actualiza la memoria si algo cambió y responde con un resumen breve.",
    schedule: { tipo: "semanal", dias: [7], hora: "19:00" },
  },
  {
    name: "Aviso de fechas límite",
    prompt:
      "Busca en los paneles tareas o eventos con fecha límite en los próximos 3 días. Si hay alguno, responde con la lista ordenada por urgencia; si no hay nada, responde solo «Sin fechas límite próximas».",
    schedule: { tipo: "diaria", hora: "09:00" },
  },
  {
    name: "Repaso mensual de finanzas",
    prompt:
      "Haz el repaso del mes anterior con los paneles de finanzas (gastos, presupuesto) y los objetivos de ahorro de la memoria: desviaciones, logros y 2-3 recomendaciones. Actualiza o crea el gráfico de gastos por categoría.",
    schedule: { tipo: "mensual", dia: 1, hora: "09:00" },
  },
];
