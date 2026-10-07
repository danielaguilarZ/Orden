import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { createTask, finishTask, getTask, setTaskStatus } from "@/lib/repo/tasks";
import { hireAgent } from "@/lib/team";
import { setSetting } from "@/lib/repo/system";
import { DEFAULT_AUTOPILOT, judgeBudget, setAutopilotSettings, weeklyAllowance } from "@/lib/org/budget";
import { tickAutopilot } from "@/lib/org/autopilot";
import { addItem, createUnit, getItem, getRole, listBacklog, setRole } from "@/lib/org/repo";
import type { ClaudeUsage } from "@/lib/claude/usageText";

const AT = new Date("2026-10-07T12:00:00Z");
/** La semana se reinicia el día 11: han pasado 3 de 7 días. */
const usage = (session: number, week: number, opus?: number): ClaudeUsage => ({
  available: true,
  plan: "max",
  fetchedAt: new Date(AT.getTime() - 60_000).toISOString(),
  windows: [
    { key: "five_hour", label: "Sesión", percent: session, resetsAt: "2026-10-07T14:00:00Z" },
    { key: "seven_day", label: "Semana", percent: week, resetsAt: "2026-10-11T12:00:00Z" },
    ...(opus !== undefined ? [{ key: "seven_day_opus", label: "Opus", percent: opus, resetsAt: "2026-10-11T12:00:00Z" }] : []),
  ],
});
const ON = { ...DEFAULT_AUTOPILOT, enabled: true };

describe("regulador del piloto automático", () => {
  it("reparte la semana por días, con un día de adelanto", () => {
    const week = usage(0, 0).windows[1];
    // 3 días de 7 + 1 de adelanto = 4/7 de 70 %.
    expect(weeklyAllowance(week, 70, AT)).toBe(40);
    expect(weeklyAllowance(week, 70, new Date("2026-10-11T11:00:00Z"))).toBe(70);
  });

  it("deja trabajar con margen y se para en los topes", () => {
    expect(judgeBudget(usage(20, 10), ON, AT).allowed).toBe(true);
    expect(judgeBudget(usage(80, 10), ON, AT)).toMatchObject({ allowed: false });
    expect(judgeBudget(usage(20, 45), ON, AT).reason).toContain("repartirla");
    expect(judgeBudget(usage(20, 10), { ...ON, enabled: false }, AT).allowed).toBe(false);
  });

  it("nunca gasta a ciegas: sin medidor o con datos viejos, no trabaja", () => {
    expect(judgeBudget(null, ON, AT).allowed).toBe(false);
    expect(judgeBudget({ ...usage(0, 0), available: false }, ON, AT).allowed).toBe(false);
    expect(judgeBudget({ ...usage(0, 0), fetchedAt: "2026-10-07T10:00:00Z" }, ON, AT).allowed).toBe(false);
  });

  it("si Opus está en su tope semanal, avisa para bajar a Sonnet", () => {
    expect(judgeBudget(usage(10, 10, 75), ON, AT)).toMatchObject({ allowed: true, allowOpus: false });
  });
});

describe("piloto automático", () => {
  beforeEach(() => {
    setDbForTests(openDb(":memory:"));
    ensureSeed();
    setAutopilotSettings({ enabled: true });
    setSetting("claude_usage", usage(10, 10));
  });

  const staff = () => {
    const unit = createUnit({ name: "Terral Studio", kind: "empresa", summary: "Agencia web" });
    const ana = hireAgent({ name: "Ana", specialty: "SEO", model: "sonnet" });
    setRole(ana.id, { unitId: unit.id, role: "Especialista SEO", duties: "Auditorías SEO de clientes" });
    return { unit, ana };
  };

  it("solo trabaja con quien tiene puesto, y planifica si la cartera está vacía", () => {
    const { ana } = staff();
    const { started } = tickAutopilot(AT);
    expect(started.map((t) => t.agentId)).toEqual([ana.id]);
    expect(started[0].kind).toBe("auto");
    expect(started[0].data).toMatchObject({ planning: 1, model: "sonnet" });
    // No vuelve a planificar en seguida.
    expect(getRole(ana.id).planAfter).not.toBeNull();
  });

  it("saca la tarea más prioritaria de la cartera con su modelo y la cierra al terminar", () => {
    const { ana } = staff();
    addItem({ agentId: ana.id, title: "Baja", priority: 3 });
    const alta = addItem({ agentId: ana.id, title: "Auditoría SEO", priority: 1, model: "opus" });
    const [task] = tickAutopilot(AT).started;
    expect(task.title).toBe("Auditoría SEO");
    expect(task.data).toMatchObject({ backlogId: alta.id, model: "opus" });
    expect(getItem(alta.id)?.status).toBe("en_curso");
    // Un solo encargo a la vez por agente.
    expect(tickAutopilot(AT).started).toHaveLength(0);
    finishTask(task.id, "done", { result: "Informe en Archivos" });
    tickAutopilot(AT);
    expect(getItem(alta.id)).toMatchObject({ status: "hecha", result: "Informe en Archivos" });
  });

  it("si una tarea falla la reintenta una vez y después la da por bloqueada", () => {
    const { ana } = staff();
    const item = addItem({ agentId: ana.id, title: "Algo frágil" });
    tickAutopilot(AT);
    for (let i = 0; i < 2; i++) {
      // Al cerrar el fallo, el mismo ciclo ya la relanza con un encargo nuevo.
      finishTask(getItem(item.id)!.taskId!, "error", { error: "falló" });
      tickAutopilot(AT);
    }
    expect(getItem(item.id)).toMatchObject({ status: "descartada", attempts: 2 });
  });

  it("cede ante los encargos del usuario y deja siempre un hueco libre", () => {
    const { ana } = staff();
    const zen = getChief()!;
    setRole(zen.id, { role: "Director general" });
    const user = createTask({ agentId: zen.id, kind: "chat", prompt: "hola" });
    expect(tickAutopilot(AT).started).toHaveLength(0);
    setTaskStatus(user.id, "running");
    // Con un worker de 2 huecos, el piloto solo usa 1.
    const started = tickAutopilot(AT, 2).started;
    expect(started).toHaveLength(1);
    expect(started[0].agentId).toBe(ana.id);
  });

  it("baja de Opus a Sonnet si Opus está en su tope", () => {
    const { ana } = staff();
    setSetting("claude_usage", usage(10, 10, 90));
    addItem({ agentId: ana.id, title: "Estrategia", model: "opus" });
    expect(tickAutopilot(AT).started[0].data.model).toBe("sonnet");
  });

  it("si planificó y no se le ocurrió nada, espera más antes de volver a intentarlo", () => {
    const { ana } = staff();
    const [plan] = tickAutopilot(AT).started;
    finishTask(plan.id, "done", { result: "Sin tareas útiles por ahora" });
    tickAutopilot(AT);
    expect(Date.parse(getRole(ana.id).planAfter!) - AT.getTime()).toBeGreaterThan(7 * 3600_000);
    expect(getTask(plan.id)?.data.reconciled).toBe(1);
    expect(listBacklog({ agentId: ana.id })).toHaveLength(0);
  });
});
