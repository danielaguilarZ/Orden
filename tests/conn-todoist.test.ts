import { describe, expect, it } from "vitest";
import { getService } from "@/lib/connections/registry";
import { addTodoistTask, prioLabel, taskLine, todoistLimit } from "@/lib/connections/todoist";
import { callTool, connect, headersOf, jsonBody, mockFetch, promptOf, storedSecret, team, textOf, toolNames, useConnTestEnv } from "./helpers/conn";

const TOKEN = "0123456789abcdef0123456789abcdef01234567";
useConnTestEnv(() => todoistLimit.reset());

const projects = { results: [{ id: "p1", name: "Casa" }, { id: "p2", name: "Trabajo" }], next_cursor: null };
const tasks = {
  results: [
    { id: "t1", content: "Pagar luz", priority: 4, project_id: "p1", due: { date: "2026-10-05", is_recurring: false }, labels: ["facturas"] },
    { id: "t2", content: "Llamar a Ana", priority: 1, project_id: "p2", due: null },
  ],
};

describe("Todoist", () => {
  it("formatea tareas como en la app", () => {
    expect(prioLabel(4)).toBe("p1");
    expect(prioLabel(undefined)).toBe("p4");
    const line = taskLine(tasks.results[0], new Map([["p1", "Casa"]]));
    expect(line).toBe("- Pagar luz · vence 2026-10-05 · p1 · #Casa · @facturas · id t1");
  });

  it("lectura: tareas con filtro y proyectos; token cifrado y en la cabecera", async () => {
    const c = connect("todoist", {}, TOKEN, { agent: team.ana, level: "lectura" });
    expect(storedSecret(c.id)).not.toContain(TOKEN);
    expect(toolNames(team.ana, "todoist")).toEqual(["todoist_proyectos", "todoist_tareas"]);
    const calls = mockFetch((url) => (url.includes("/projects") ? projects : tasks));
    const r = await callTool(team.ana, "todoist_tareas", {});
    expect(textOf(r)).toContain("2 tarea(s) con «today | overdue»");
    expect(textOf(r)).toContain("Llamar a Ana · #Trabajo · id t2");
    const filterCall = calls.find((x) => x.url.includes("/tasks/filter"))!;
    expect(new URL(filterCall.url).searchParams.get("query")).toBe("today | overdue");
    expect(headersOf(filterCall).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(promptOf(team.ana)).toContain("todoist_tareas");
    expect(promptOf(team.ana)).not.toContain("todoist_crear");
  });

  it("completo: crea con proyecto por nombre y prioridad, completa y respeta el límite", async () => {
    const c = connect("todoist", {}, TOKEN, { agent: team.ana, level: "completo" });
    expect(toolNames(team.ana, "todoist")).toEqual(["todoist_completar", "todoist_crear", "todoist_proyectos", "todoist_tareas"]);
    const calls = mockFetch((url, init) => {
      if (url.includes("/projects")) return projects;
      if (url.endsWith("/close")) return new Response(null, { status: 204 });
      if (init?.method === "POST") return { id: "t9", content: "Comprar pan", priority: 3, due: { date: "2026-10-06" } };
      return tasks;
    });
    const r = await callTool(team.ana, "todoist_crear", { texto: "Comprar pan", cuando: "mañana", proyecto: "casa", prioridad: 2 });
    expect(textOf(r)).toContain("Tarea creada: - Comprar pan · vence 2026-10-06 · p2");
    const post = calls.find((x) => x.init?.method === "POST" && x.url.endsWith("/tasks"))!;
    expect(jsonBody(post)).toEqual({ content: "Comprar pan", due_string: "mañana", due_lang: "es", priority: 3, project_id: "p1" });
    const done = await callTool(team.ana, "todoist_completar", { id: "t1" });
    expect(textOf(done)).toBe("Tarea t1 completada.");
    expect(calls.at(-1)!.url).toBe("https://api.todoist.com/api/v1/tasks/t1/close");

    const bad = await callTool(team.ana, "todoist_crear", { texto: "x", proyecto: "Inexistente" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("No existe el proyecto");

    const at = new Date("2020-01-01T10:00:00Z");
    for (let i = 0; i < todoistLimit.max; i++) todoistLimit.add(c.id, at);
    await expect(addTodoistTask(c, { texto: "una más" }, at)).rejects.toThrow(/máximo diario/);
  });

  it("los errores y la prueba no muestran el token", async () => {
    const c = connect("todoist", {}, TOKEN, { agent: team.ana, level: "lectura" });
    mockFetch(() => new Response(`Unauthorized ${TOKEN}`, { status: 401 }));
    const r = await callTool(team.ana, "todoist_proyectos");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("401");
    expect(textOf(r)).not.toContain(TOKEN);
    const t = await getService("todoist").test(c);
    expect(t).toMatchObject({ ok: false });
    expect(t.text).not.toContain(TOKEN);
    mockFetch(() => projects);
    expect((await getService("todoist").test(c)).text).toBe("Todoist conectado: 2 proyecto(s).");
  });

  it("sin token, la prueba dice dónde ponerlo", async () => {
    const c = connect("todoist", { cuenta: "Trabajo" });
    expect(c.name).toBe("Todoist · Trabajo");
    expect((await getService("todoist").test(c)).text).toMatch(/Falta el token de Todoist/);
  });
});
