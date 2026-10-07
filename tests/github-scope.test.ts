import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { createTask } from "@/lib/repo/tasks";
import { hireAgent } from "@/lib/team";
import { buildTools, type ToolDef } from "@/lib/agents/tools";
import { buildSystemPrompt } from "@/lib/agents/prompt";
import { setGrant } from "@/lib/repo/connections";
import { addConnection } from "@/lib/connections";
import { getService } from "@/lib/connections/registry";
import { setTransportForTests, type GhRequest } from "@/lib/connections/github/api";
import { inScope, isWildcard, parseScope } from "@/lib/connections/github/scope";
import "@/lib/agents/modules";
import type { Agent } from "@/lib/types";

beforeAll(() => {
  process.env.ORDEN_SECRET_KEY = "a".repeat(64);
});
afterAll(() => {
  delete process.env.ORDEN_SECRET_KEY;
  setTransportForTests(null);
});

/** La cuenta ve tres repos: dos propios y uno de una organización (sin permiso de escritura). */
const REPOS = [
  { full_name: "yo/web", private: false, archived: false, description: "Mi web", pushed_at: "2026-10-05T10:00:00Z", permissions: { push: true } },
  { full_name: "yo/app", private: true, archived: false, description: null, pushed_at: "2026-10-01T10:00:00Z", permissions: { push: true } },
  { full_name: "acme/api", private: true, archived: false, description: "API", pushed_at: "2026-09-01T10:00:00Z", permissions: { push: false } },
];
let calls: GhRequest[] = [];
function fakeGithub() {
  calls = [];
  setTransportForTests(async (req) => {
    calls.push(req);
    if (req.path.startsWith("/user/repos?")) return REPOS;
    const m = req.path.match(/^\/repos\/([^/]+)\/([^/]+)$/);
    if (m) return { full_name: `${m[1]}/${m[2]}`, default_branch: "main", html_url: "", private: true, open_issues_count: 0, permissions: { push: true } };
    if (req.path.includes("/issues") && req.method === "POST") return { number: 1, html_url: "https://github.com/x/issues/1" };
    throw new Error(`Ruta no prevista: ${req.method} ${req.path}`);
  });
}

let ana: Agent, marta: Agent;
beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
  ana = hireAgent({ name: "Ana", specialty: "Desarrolladora" });
  marta = hireAgent({ name: "Marta", specialty: "Producto" });
  fakeGithub();
});

function toolsOf(agent: Agent): ToolDef[] {
  const task = createTask({ agentId: agent.id, kind: "chat", prompt: "x" });
  return buildTools({ agent, task, signal: new AbortController().signal, note: () => {} });
}
async function call(agent: Agent, name: string, args: Record<string, unknown>) {
  const t = toolsOf(agent).find((x) => x.name === name);
  if (!t) throw new Error(`${agent.name} no tiene ${name}`);
  const r = (await t.handler(args, {})) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0].text, error: Boolean(r.isError) };
}

describe("alcance de una conexión de GitHub", () => {
  it("acepta un repo, todos los de un propietario o todos", () => {
    expect(parseScope("https://github.com/yo/web.git".replace(".git", ""))).toBe("yo/web");
    expect(parseScope("yo/*")).toBe("yo/*");
    expect(parseScope(" * ")).toBe("*");
    expect(parseScope("todos mis repos")).toBe("*");
    expect(() => parseScope("nada")).toThrow(/propietario\/\*/);
    expect(isWildcard("yo/*") && isWildcard("*") && !isWildcard("yo/web")).toBe(true);
    expect(inScope("yo/*", "Yo/App")).toBe(true);
    expect(inScope("yo/*", "acme/api")).toBe(false);
    expect(inScope("*", "acme/api")).toBe(true);
  });

  it("una sola conexión da acceso a todos los repos, y el agente elige cuál", async () => {
    const c = addConnection("github", { repo: "*" });
    expect(c.name).toBe("GitHub · todos mis repos");
    setGrant(c.id, ana.id, "completo");
    setGrant(c.id, marta.id, "lectura");

    const list = await call(marta, "github_repos", {});
    expect(list.text).toContain("3 repo(s)");
    expect(list.text).toContain("yo/web");
    expect(list.text).toMatch(/acme\/api \(privado\) · lectura/);
    // Ana tiene completo, pero en acme/api la cuenta no puede escribir.
    expect((await call(ana, "github_repos", {})).text).toMatch(/acme\/api \(privado\) · lectura \(la cuenta no puede escribir\)/);
    expect((await call(ana, "github_repos", {})).text).toMatch(/yo\/web · completo/);

    // Con acceso amplio hay que decir el repo.
    expect((await call(marta, "github_resumen", {})).text).toMatch(/Indica el repo/);
    await call(marta, "github_resumen", { repo: "acme/api" });
    expect(calls.some((x) => x.path === "/repos/acme/api")).toBe(true);

    // Escribir sigue siendo solo para quien tiene «completo».
    expect(toolsOf(marta).some((t) => t.name === "github_crear_issue")).toBe(false);
    const issue = await call(ana, "github_crear_issue", { repo: "yo/app", titulo: "Algo", texto: "Detalle" });
    expect(issue.error).toBe(false);
    expect(calls.some((x) => x.method === "POST" && x.path === "/repos/yo/app/issues")).toBe(true);

    expect(buildSystemPrompt(marta, createTask({ agentId: marta.id, kind: "chat", prompt: "x" }))).toContain("Acceso a todos tus repos");
  });

  it("«propietario/*» no deja salir de ese propietario", async () => {
    const c = addConnection("github", { repo: "yo/*" });
    setGrant(c.id, ana.id, "completo");
    expect((await call(ana, "github_repos", {})).text).not.toContain("acme/api");
    const out = await call(ana, "github_resumen", { repo: "acme/api" });
    expect(out.error).toBe(true);
    expect(out.text).toContain("No tienes acceso a ese repo");
    expect(calls.some((x) => x.path === "/repos/acme/api")).toBe(false);
  });

  it("una conexión de un repo concreto manda sobre la general para ese repo", async () => {
    const todos = addConnection("github", { repo: "*" });
    const web = addConnection("github", { repo: "yo/web" });
    setGrant(todos.id, ana.id, "lectura");
    setGrant(web.id, ana.id, "completo");
    expect((await call(ana, "github_crear_issue", { repo: "yo/web", titulo: "Algo", texto: "x" })).error).toBe(false);
    expect((await call(ana, "github_crear_issue", { repo: "yo/app", titulo: "Algo", texto: "x" })).text).toContain("No tienes permiso de escritura");
  });

  it("la prueba de conexión cuenta los repos visibles", async () => {
    const c = addConnection("github", { repo: "*" });
    const r = await getService("github").test(c);
    expect(r).toMatchObject({ ok: true });
    expect(r.text).toContain("3 repo(s)");
    expect(r.text).toContain("2 con permiso de escritura");
  });
});
