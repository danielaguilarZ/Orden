import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { getDb, openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { createTask } from "@/lib/repo/tasks";
import { hireAgent } from "@/lib/team";
import { buildTools, type ToolDef } from "@/lib/agents/tools";
import { buildSystemPrompt } from "@/lib/agents/prompt";
import "@/lib/agents/modules";
import { addConnection } from "@/lib/connections";
import { getConnection, setConnectionSecret, setGrant, type Connection, type GrantLevel } from "@/lib/repo/connections";
import type { Agent } from "@/lib/types";

/**
 * Utilidades comunes de los tests de conexiones: BD en memoria con Zen y una
 * agente «Ana», fetch simulado y llamadas a herramientas como un agente.
 */

export const team: { zen: Agent; ana: Agent } = {} as { zen: Agent; ana: Agent };

/** Registra los before/after: clave de cifrado fija, BD limpia y fetch real restaurado. */
export function useConnTestEnv(onReset?: () => void) {
  beforeAll(() => {
    process.env.ORDEN_SECRET_KEY = "d".repeat(64);
  });
  afterAll(() => {
    delete process.env.ORDEN_SECRET_KEY;
  });
  beforeEach(() => {
    setDbForTests(openDb(":memory:"));
    ensureSeed();
    team.zen = getChief()!;
    team.ana = hireAgent({ name: "Ana", specialty: "Ayudante" });
    onReset?.();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

export type Call = { url: string; init?: RequestInit };

/** Sustituye fetch: el manejador devuelve un objeto (JSON), un texto o una Response. */
export function mockFetch(handler: (url: string, init?: RequestInit) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const out = await handler(url, init);
      if (out instanceof Response) return out;
      if (out === null || out === undefined) return new Response(null, { status: 204 });
      return new Response(typeof out === "string" ? out : JSON.stringify(out), { status: 200 });
    }),
  );
  return calls;
}

/** Cuerpo JSON de una llamada simulada. */
export const jsonBody = (c: Call) => JSON.parse(String(c.init?.body ?? "null")) as Record<string, unknown>;
/** Cabeceras de una llamada simulada. */
export const headersOf = (c: Call) => new Headers(c.init?.headers);

/** Crea la conexión, guarda su credencial (si hay) y da permiso a un agente (si se pide). */
export function connect(service: string, config: Record<string, unknown>, secret?: string, grant?: { agent: Agent; level: GrantLevel }): Connection {
  const c = addConnection(service, config);
  if (secret) setConnectionSecret(c.id, secret);
  if (grant) setGrant(c.id, grant.agent.id, grant.level);
  return getConnection(c.id)!;
}

export function toolsOf(agent: Agent): ToolDef[] {
  const task = createTask({ agentId: agent.id, kind: "chat", prompt: "x" });
  return buildTools({ agent, task, signal: new AbortController().signal, note: () => {} });
}

export const toolNames = (agent: Agent, prefix: string) =>
  toolsOf(agent)
    .map((t) => t.name)
    .filter((n) => n.startsWith(prefix))
    .sort();

export type ToolOut = { content: { text: string }[]; isError?: boolean };

export async function callTool(agent: Agent, name: string, args: Record<string, unknown> = {}): Promise<ToolOut> {
  const t = toolsOf(agent).find((x) => x.name === name);
  if (!t) throw new Error(`${agent.name} no tiene ${name}`);
  return (await t.handler(args, {})) as ToolOut;
}

/** Texto de la respuesta de una herramienta. */
export const textOf = (r: ToolOut) => r.content.map((c) => c.text).join("\n");

export function promptOf(agent: Agent): string {
  return buildSystemPrompt(agent, createTask({ agentId: agent.id, kind: "chat", prompt: "x" }));
}

/** El secreto cifrado en la BD (para comprobar que no está en claro). */
export function storedSecret(id: string): string {
  return (getDb().prepare("SELECT secret FROM connections WHERE id = ?").get(id) as { secret: string }).secret;
}
