import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getAgent, getChief, updateAgent } from "@/lib/repo/agents";
import { activeConversation, addMessage, listMessages } from "@/lib/repo/chat";
import { cancelTask, claimNextTask, createTask, failOrphanedTasks, getTask, listTasks } from "@/lib/repo/tasks";
import { listRooms } from "@/lib/repo/rooms";
import { editAgent, hireAgent } from "@/lib/team";
import { buildTools, waitForTasks, type ToolContext } from "@/lib/agents/tools";
import { runTask, type QueryFn } from "@/lib/agents/runner";
import type { Agent, Task } from "@/lib/types";

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
});

function ctxFor(agent: Agent, task: Task, notes: string[] = []): ToolContext {
  return { agent, task, signal: new AbortController().signal, note: (t) => notes.push(t) };
}

async function callTool(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  const def = buildTools(ctx).find((t) => t.name === name)!;
  const res = (await def.handler(args, {})) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content[0].text, isError: Boolean(res.isError) };
}

/** SDK simulado: emite los mensajes que le pasemos. */
function fakeQuery(messages: unknown[] | ((args: unknown) => unknown[])): QueryFn {
  return ((args: unknown) =>
    (async function* () {
      for (const m of typeof messages === "function" ? messages(args) : messages) yield m;
    })()) as unknown as QueryFn;
}

const result = (text: string) => ({
  type: "result",
  subtype: "success",
  result: text,
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
  total_cost_usd: 0.01,
  num_turns: 1,
  duration_ms: 1200,
  session_id: "s1",
});

describe("equipo", () => {
  it("al contratar un agente no se crea sala propia: se le asigna un escritorio", () => {
    const ana = hireAgent({ name: "Ana", specialty: "Finanzas personales y presupuesto" });
    expect(listRooms().some((r) => r.agentId === ana.id)).toBe(false);
    const room = listRooms().find((r) => r.id === getAgent(ana.id)!.roomId)!;
    expect(room).toMatchObject({ kind: "oficina", agentId: null });
    expect(room.furniture.some((f) => f.id === ana.deskSeatId)).toBe(true);
    expect(() => hireAgent({ name: "ana" })).toThrow(/Ya hay/);
  });

  it("un carácter a medida encarga frases de ambiente una sola vez", () => {
    const leo = hireAgent({ name: "Leo", personality: { preset: "curioso", description: "Un bibliotecario soñador", voice: "" } });
    const ambient = listTasks({ agentId: leo.id, kinds: ["ambient"] });
    expect(ambient).toHaveLength(1);
  });
});

describe("cola de encargos", () => {
  it("un agente solo ejecuta un encargo a la vez y respeta la pausa", () => {
    const zen = getChief()!;
    const ana = hireAgent({ name: "Ana" });
    const t1 = createTask({ agentId: zen.id, kind: "chat", prompt: "uno" });
    const t2 = createTask({ agentId: zen.id, kind: "chat", prompt: "dos" });
    updateAgent(ana.id, { paused: true });
    const t3 = createTask({ agentId: ana.id, kind: "chat", prompt: "tres" });

    expect(claimNextTask()!.id).toBe(t1.id);
    expect(claimNextTask()).toBeNull(); // t2 espera a t1; t3 está en pausa
    updateAgent(ana.id, { paused: false });
    expect(claimNextTask()!.id).toBe(t3.id);
    expect(getTask(t2.id)!.status).toBe("queued");
  });

  it("cancelar un encargo en cola es inmediato y arrastra a sus delegados", () => {
    const zen = getChief()!;
    const ana = hireAgent({ name: "Ana" });
    const parent = createTask({ agentId: zen.id, kind: "chat", prompt: "padre" });
    claimNextTask();
    const child = createTask({ agentId: ana.id, kind: "delegation", prompt: "hijo", parentId: parent.id });
    cancelTask(parent.id);
    expect(getTask(parent.id)!.cancelRequested).toBe(true); // en marcha: lo aborta el worker
    expect(getTask(child.id)!.status).toBe("cancelled"); // en cola: al momento
  });

  it("los encargos a medias se marcan como error al reiniciar el worker", () => {
    const zen = getChief()!;
    createTask({ agentId: zen.id, kind: "chat", prompt: "x" });
    claimNextTask();
    expect(failOrphanedTasks("reinicio")).toHaveLength(1);
    expect(listTasks({ statuses: ["error"] })[0].error).toBe("reinicio");
  });
});

describe("delegación", () => {
  it("delegar crea un encargo hijo y lo deja en el chat del agente", async () => {
    const zen = getChief()!;
    const ana = hireAgent({ name: "Ana", specialty: "Finanzas" });
    const parent = createTask({ agentId: zen.id, kind: "chat", prompt: "p" });
    const r = await callTool(ctxFor(zen, parent), "delegar", { agente: "ana", encargo: "Haz un presupuesto" });
    expect(r.isError).toBe(false);
    const [child] = listTasks({ parentId: parent.id });
    expect(child.agentId).toBe(ana.id);
    expect(child.prompt).toContain("Encargo de Zen");
    const msgs = listMessages(activeConversation(ana.id).id);
    expect(msgs[0].data.fromName).toBe("Zen");
  });

  it("no permite ciclos ni delegar en agentes en pausa", async () => {
    const zen = getChief()!;
    const ana = hireAgent({ name: "Ana" });
    const leo = hireAgent({ name: "Leo" });
    const root = createTask({ agentId: zen.id, kind: "chat", prompt: "p" });
    const sub = createTask({ agentId: ana.id, kind: "delegation", prompt: "s", parentId: root.id });
    const back = await callTool(ctxFor(ana, sub), "delegar", { agente: "Zen", encargo: "x" });
    expect(back.isError).toBe(true);
    updateAgent(leo.id, { paused: true });
    const paused = await callTool(ctxFor(ana, sub), "delegar", { agente: "Leo", encargo: "x" });
    expect(paused.text).toMatch(/pausa/);
  });

  it("esperar_resultados devuelve lo que entregan los delegados", async () => {
    const zen = getChief()!;
    const ana = hireAgent({ name: "Ana" });
    const parent = createTask({ agentId: zen.id, kind: "chat", prompt: "p" });
    const ctx = ctxFor(zen, parent);
    await callTool(ctx, "delegar", { agente: "Ana", encargo: "Regla de ahorro" });
    const [child] = listTasks({ parentId: parent.id });
    const run = runTask(child, { queryFn: fakeQuery([result("50/30/20")]) });
    const waited = await callTool(ctx, "esperar_resultados", { ids: [child.id] });
    await run;
    expect(waited.text).toContain("Ana");
    expect(waited.text).toContain("50/30/20");
    expect(getAgent(ana.id)!.status).toBe("idle");
  });

  it("waitForTasks termina cuando todos acaban", async () => {
    const zen = getChief()!;
    const t = createTask({ agentId: zen.id, kind: "chat", prompt: "p" });
    setTimeout(() => cancelTask(t.id), 30);
    const done = await waitForTasks([t.id], new AbortController().signal, 2000, 10);
    expect(done[0].status).toBe("cancelled");
  });
});

describe("ejecutor", () => {
  it("guarda la respuesta en el chat, la sesión y el uso del mensaje result", async () => {
    const zen = getChief()!;
    const conv = activeConversation(zen.id);
    const task = createTask({ agentId: zen.id, kind: "chat", prompt: "hola", conversationId: conv.id });
    claimNextTask();
    let seenOptions: Record<string, unknown> = {};
    const out = await runTask(getTask(task.id)!, {
      queryFn: fakeQuery((args) => {
        seenOptions = (args as { options: Record<string, unknown> }).options;
        return [
          { type: "system", subtype: "init", session_id: "sess-1" },
          // Mensaje de asistente con uso parcial: no debe sumarse.
          { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Hola, soy Zen." }], usage: { input_tokens: 999999 } } },
          result("Hola, soy Zen."),
        ];
      }),
    });
    expect(out.status).toBe("done");
    expect(out.result).toBe("Hola, soy Zen.");
    expect(out.usage!.inputTokens).toBe(100);
    expect(seenOptions.tools).toEqual([]);
    expect(seenOptions.strictMcpConfig).toBe(true);
    expect(seenOptions.permissionMode).toBe("dontAsk");
    expect((seenOptions.env as Record<string, string>).MCP_TOOL_TIMEOUT).toBe("1800000");
    const msgs = listMessages(conv.id).filter((m) => m.role === "agent");
    expect(msgs.map((m) => m.content)).toEqual(["Hola, soy Zen."]);
    // La siguiente vez se reanuda la sesión.
    const t2 = createTask({ agentId: zen.id, kind: "chat", prompt: "otra", conversationId: conv.id });
    await runTask(t2, {
      queryFn: fakeQuery((args) => {
        seenOptions = (args as { options: Record<string, unknown> }).options;
        return [result("ok")];
      }),
    });
    expect(seenOptions.resume).toBe("sess-1");
  });

  it("cada mensaje lleva el equipo ACTUAL (un agente contratado después aparece aunque se reanude)", async () => {
    const zen = getChief()!;
    const conv = activeConversation(zen.id);
    const seen: { prompt: string; resume?: string; system: string }[] = [];
    const q = fakeQuery((args) => {
      const a = args as { prompt: string; options: { resume?: string; systemPrompt: string } };
      seen.push({ prompt: a.prompt, resume: a.options.resume, system: a.options.systemPrompt });
      return [{ type: "system", subtype: "init", session_id: "s-zen" }, result("ok")];
    });
    await runTask(createTask({ agentId: zen.id, kind: "chat", prompt: "hola", conversationId: conv.id }), { queryFn: q });
    hireAgent({ name: "Lucy", specialty: "Desarrolladora" });
    await runTask(createTask({ agentId: zen.id, kind: "chat", prompt: "pídele algo a Lucy", conversationId: conv.id }), { queryFn: q });
    expect(seen[1].resume).toBe("s-zen");
    expect(seen[1].prompt).toContain("<contexto_actual>");
    expect(seen[1].prompt).toContain("- Lucy: Desarrolladora");
    expect(seen[1].system).not.toContain("Lucy");
  });

  it("si el agente se edita, no reanuda la sesión vieja y le pasa un resumen", async () => {
    const zen = getChief()!;
    const conv = activeConversation(zen.id);
    const seen: { prompt: string; resume?: string }[] = [];
    const q = fakeQuery((args) => {
      const a = args as { prompt: string; options: { resume?: string } };
      seen.push({ prompt: a.prompt, resume: a.options.resume });
      return [{ type: "system", subtype: "init", session_id: `s${seen.length}` }, { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Entendido, Daniel." }] } }, result("Entendido, Daniel.")];
    });
    const t1 = createTask({ agentId: zen.id, kind: "chat", prompt: "Me llamo Daniel", conversationId: conv.id });
    addMessage({ conversationId: conv.id, role: "user", content: "Me llamo Daniel", taskId: t1.id });
    await runTask(t1, { queryFn: q });
    updateAgent(zen.id, { instructions: "Sé todavía más breve." });
    await runTask(createTask({ agentId: zen.id, kind: "chat", prompt: "¿Cómo me llamo?", conversationId: conv.id }), { queryFn: q });
    expect(seen[1].resume).toBeUndefined();
    expect(seen[1].prompt).toContain("<conversacion_previa>");
    expect(seen[1].prompt).toContain("Usuario: Me llamo Daniel");
    expect(seen[1].prompt).toContain("Tú: Entendido, Daniel.");
  });

  it("un fallo deja al agente en error y avisa en el chat", async () => {
    const zen = getChief()!;
    const conv = activeConversation(zen.id);
    const task = createTask({ agentId: zen.id, kind: "chat", prompt: "x", conversationId: conv.id });
    const out = await runTask(task, {
      queryFn: fakeQuery([{ type: "result", subtype: "error_during_execution", errors: ["se rompió"], usage: {}, total_cost_usd: 0 }]),
    });
    expect(out.status).toBe("error");
    expect(out.error).toContain("se rompió");
    expect(getAgent(zen.id)!.status).toBe("error");
    expect(listMessages(conv.id).at(-1)!.role).toBe("system");
  });

  it("si se aborta, el encargo queda cancelado", async () => {
    const zen = getChief()!;
    const task = createTask({ agentId: zen.id, kind: "chat", prompt: "x" });
    const abort = new AbortController();
    abort.abort();
    const out = await runTask(task, { abort, queryFn: fakeQuery([result("tarde")]) });
    expect(out.status).toBe("cancelled");
  });
});

describe("editar agentes", () => {
  it("cambiar una sola cosa no borra el resto", () => {
    const ana = hireAgent({ name: "Ana", specialty: "Finanzas", instructions: "Sé precisa", model: "sonnet" });
    const paused = editAgent(ana.id, { paused: true });
    expect(paused.specialty).toBe("Finanzas");
    expect(paused.instructions).toBe("Sé precisa");
    expect(paused.model).toBe("sonnet");
    expect(paused.paused).toBe(true);
  });
});
