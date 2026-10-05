import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief, updateAgent } from "@/lib/repo/agents";
import { createRoutine, getRoutine, listRoutines } from "@/lib/repo/routines";
import { finishTask, listTasks } from "@/lib/repo/tasks";
import { listActivity } from "@/lib/repo/system";
import { describeSchedule, nextRun, scheduleSchema } from "@/lib/routines/schedule";
import { fireRoutine, tickRoutines } from "@/lib/routines/runner";

// Fechas locales para no depender de la zona horaria de quien ejecute los tests.
const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min);

describe("planificador (puro)", () => {
  it("diaria: hoy si aún no ha pasado, si no mañana", () => {
    expect(nextRun({ tipo: "diaria", hora: "08:00" }, d(2026, 10, 2, 7, 0))).toEqual(d(2026, 10, 2, 8, 0));
    expect(nextRun({ tipo: "diaria", hora: "08:00" }, d(2026, 10, 2, 8, 0))).toEqual(d(2026, 10, 3, 8, 0));
  });

  it("laborables salta el fin de semana", () => {
    // 2 oct 2026 es viernes
    expect(nextRun({ tipo: "laborables", hora: "09:00" }, d(2026, 10, 2, 10, 0))).toEqual(d(2026, 10, 5, 9, 0));
  });

  it("semanal en varios días", () => {
    const s = { tipo: "semanal" as const, dias: [1, 4], hora: "19:00" }; // lunes y jueves
    expect(nextRun(s, d(2026, 10, 2, 12))).toEqual(d(2026, 10, 5, 19)); // vie → lun
    expect(nextRun(s, d(2026, 10, 5, 20))).toEqual(d(2026, 10, 8, 19)); // lun tarde → jue
  });

  it("mensual: día 31 en meses cortos y «último día»", () => {
    expect(nextRun({ tipo: "mensual", dia: 31, hora: "09:00" }, d(2026, 2, 1))).toEqual(d(2026, 2, 28, 9));
    expect(nextRun({ tipo: "mensual", dia: -1, hora: "09:00" }, d(2026, 4, 30, 10))).toEqual(d(2026, 5, 31, 9));
    expect(nextRun({ tipo: "mensual", dia: 1, hora: "09:00" }, d(2026, 12, 15))).toEqual(d(2027, 1, 1, 9));
  });

  it("intervalo y una vez", () => {
    expect(nextRun({ tipo: "intervalo", minutos: 90 }, d(2026, 1, 1, 10))).toEqual(d(2026, 1, 1, 11, 30));
    expect(nextRun({ tipo: "una_vez", cuando: "2026-10-10T18:30" }, d(2026, 10, 2))).toEqual(d(2026, 10, 10, 18, 30));
    expect(nextRun({ tipo: "una_vez", cuando: "2026-10-01T18:30" }, d(2026, 10, 2))).toBeNull();
  });

  it("valida y describe en español", () => {
    expect(scheduleSchema.safeParse({ tipo: "diaria", hora: "25:00" }).success).toBe(false);
    expect(describeSchedule({ tipo: "semanal", dias: [4, 1], hora: "08:00" })).toBe("cada lunes y jueves a las 08:00");
    expect(describeSchedule({ tipo: "mensual", dia: -1, hora: "09:00" })).toBe("el último día de cada mes a las 09:00");
    expect(describeSchedule({ tipo: "intervalo", minutos: 120 })).toBe("cada 2 horas");
  });
});

describe("ejecución de rutinas", () => {
  beforeEach(() => {
    setDbForTests(openDb(":memory:"));
    ensureSeed();
  });

  it("al vencer crea un encargo y programa la siguiente; si se saltaron varias, solo corre una", () => {
    const zen = getChief()!;
    const r = createRoutine({ agentId: zen.id, name: "Resumen", prompt: "Resume el día", schedule: { tipo: "intervalo", minutos: 60 } });
    // El PC estuvo apagado 5 horas.
    const later = new Date(Date.now() + 5 * 3600_000);
    const tasks = tickRoutines(later);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].kind).toBe("routine");
    expect(tasks[0].prompt).toContain("Rutina programada «Resumen»");
    const after = getRoutine(r.id)!;
    expect(new Date(after.nextRunAt!).getTime()).toBe(later.getTime() + 3600_000);
    expect(tickRoutines(later)).toHaveLength(0);
  });

  it("no se apila si la ejecución anterior sigue en marcha", () => {
    const zen = getChief()!;
    const r = createRoutine({ agentId: zen.id, name: "R", prompt: "x", schedule: { tipo: "intervalo", minutos: 5 } });
    const first = fireRoutine(getRoutine(r.id)!, new Date(), true)!;
    expect(fireRoutine(getRoutine(r.id)!, new Date(), true)).toBeNull();
    finishTask(first.id, "done", { result: "ok" });
    expect(fireRoutine(getRoutine(r.id)!, new Date(), true)).not.toBeNull();
  });

  it("si el agente está en pausa se salta y queda en el registro", () => {
    const zen = getChief()!;
    updateAgent(zen.id, { paused: true });
    createRoutine({ agentId: zen.id, name: "Pausada", prompt: "x", schedule: { tipo: "intervalo", minutos: 5 } });
    expect(tickRoutines(new Date(Date.now() + 3600_000))).toHaveLength(0);
    expect(listActivity({ kind: "rutina" })[0].text).toMatch(/en pausa/);
    expect(listTasks({ kinds: ["routine"] })).toHaveLength(0);
  });

  it("una rutina de una vez se desactiva tras ejecutarse", () => {
    const zen = getChief()!;
    const soon = new Date(Date.now() + 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const cuando = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:${pad(soon.getMinutes())}`;
    const r = createRoutine({ agentId: zen.id, name: "Una", prompt: "x", schedule: { tipo: "una_vez", cuando } });
    tickRoutines(new Date(Date.now() + 3 * 60_000));
    expect(getRoutine(r.id)!.enabled).toBe(false);
    expect(listRoutines()).toHaveLength(1);
  });
});
