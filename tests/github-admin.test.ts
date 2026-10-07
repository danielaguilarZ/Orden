import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { createTask } from "@/lib/repo/tasks";
import { hireAgent } from "@/lib/team";
import { buildTools, type ToolDef } from "@/lib/agents/tools";
import { levelAtLeast, setGrant } from "@/lib/repo/connections";
import { addConnection } from "@/lib/connections";
import { getService } from "@/lib/connections/registry";
import { setTransportForTests, type GhRequest } from "@/lib/connections/github/api";
import "@/lib/agents/modules";
import type { Agent } from "@/lib/types";

beforeAll(() => {
  process.env.ORDEN_SECRET_KEY = "a".repeat(64);
});
afterAll(() => {
  delete process.env.ORDEN_SECRET_KEY;
  setTransportForTests(null);
});

/** Un PR de mentira con el estado que pida cada test. */
let pr: Record<string, unknown>;
let checks: { name: string; status: string; conclusion: string | null }[];
let calls: GhRequest[];
function fakeGithub() {
  calls = [];
  pr = { number: 5, title: "Nueva portada", state: "open", draft: false, merged: false, mergeable: true, html_url: "https://github.com/yo/web/pull/5", head: { ref: "portada", sha: "abc1234", repo: { full_name: "yo/web" } }, base: { ref: "main" } };
  checks = [{ name: "tests", status: "completed", conclusion: "success" }];
  setTransportForTests(async (req) => {
    calls.push(req);
    const p = req.path;
    if (p === "/user") return { login: "yo" };
    if (p === "/repos/yo/web") return { full_name: "yo/web", default_branch: "main", html_url: "", private: true, open_issues_count: 0 };
    if (p === "/repos/yo/web/pulls/5" && req.method === "GET") return pr;
    if (p.startsWith("/repos/yo/web/commits/abc1234/check-runs")) return { total_count: checks.length, check_runs: checks };
    if (p === "/repos/yo/web/pulls/5/merge") return { merged: true, sha: "def5678abc", message: "ok" };
    if (req.method === "DELETE" && p.startsWith("/repos/yo/web/git/refs/heads/")) return {};
    if (p === "/repos/yo/web/pulls/5/reviews") return { id: 1, html_url: "https://github.com/yo/web/pull/5#review", state: "APPROVED" };
    if (p === "/user/repos" && req.method === "POST") return { full_name: `yo/${(req.body as { name: string }).name}`, default_branch: "main", html_url: "https://github.com/yo/nuevo", private: true, open_issues_count: 0 };
    if (p.startsWith("/orgs/") && req.method === "POST") return { full_name: `acme/${(req.body as { name: string }).name}`, default_branch: "main", html_url: "", private: true, open_issues_count: 0 };
    throw new Error(`Ruta no prevista: ${req.method} ${p}`);
  });
}

let ana: Agent, leo: Agent, marta: Agent;
beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
  ana = hireAgent({ name: "Ana", specialty: "Jefa técnica" });
  leo = hireAgent({ name: "Leo", specialty: "Desarrollador" });
  marta = hireAgent({ name: "Marta", specialty: "Producto" });
  fakeGithub();
});

function toolsOf(agent: Agent): ToolDef[] {
  const task = createTask({ agentId: agent.id, kind: "chat", prompt: "x" });
  return buildTools({ agent, task, signal: new AbortController().signal, note: () => {} });
}
const names = (agent: Agent) => toolsOf(agent).map((t) => t.name).filter((n) => n.startsWith("github_"));
async function call(agent: Agent, name: string, args: Record<string, unknown>) {
  const t = toolsOf(agent).find((x) => x.name === name);
  if (!t) throw new Error(`${agent.name} no tiene ${name}`);
  const r = (await t.handler(args, {})) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0].text, error: Boolean(r.isError) };
}

const ADMIN_TOOLS = ["github_borrar_rama", "github_cerrar_pr", "github_crear_repo", "github_fusionar_pr", "github_revisar_pr"];

describe("GitHub · nivel admin", () => {
  it("los niveles se incluyen: admin ⊇ completo ⊇ lectura", () => {
    expect(levelAtLeast("admin", "completo")).toBe(true);
    expect(levelAtLeast("completo", "admin")).toBe(false);
    expect(getService("github").levels.admin).toBeTruthy();
    // Los demás servicios no tienen nivel admin (la API lo rechaza).
    expect(getService("rss").levels.admin).toBeUndefined();
  });

  it("solo quien tiene «admin» puede fusionar, revisar, cerrar, borrar ramas o crear repos", () => {
    const c = addConnection("github", { repo: "yo/web" });
    setGrant(c.id, ana.id, "admin");
    setGrant(c.id, leo.id, "completo");
    setGrant(c.id, marta.id, "lectura");
    for (const t of ADMIN_TOOLS) expect(names(ana)).toContain(t);
    expect(names(ana)).toContain("github_crear_pr");
    expect(names(leo).filter((n) => ADMIN_TOOLS.includes(n))).toEqual([]);
    expect(names(leo)).toContain("github_crear_pr");
    expect(names(marta)).not.toContain("github_crear_pr");
  });

  it("fusiona solo PRs listos: ni borradores, ni con conflictos, ni con checks en rojo o pendientes", async () => {
    const c = addConnection("github", { repo: "yo/web" });
    setGrant(c.id, ana.id, "admin");
    const merge = () => call(ana, "github_fusionar_pr", { numero: 5 });

    pr = { ...pr, draft: true };
    expect((await merge()).text).toMatch(/borrador/);
    pr = { ...pr, draft: false, mergeable: false };
    expect((await merge()).text).toMatch(/conflictos/);
    pr = { ...pr, mergeable: true };
    checks = [{ name: "tests", status: "completed", conclusion: "failure" }];
    expect((await merge()).text).toMatch(/Checks en rojo: tests/);
    checks = [{ name: "build", status: "in_progress", conclusion: null }];
    expect((await merge()).text).toMatch(/aún en marcha: build/);
    expect(calls.some((x) => x.path.endsWith("/merge"))).toBe(false);

    checks = [{ name: "tests", status: "completed", conclusion: "success" }];
    const ok = await merge();
    expect(ok.error).toBe(false);
    expect(ok.text).toMatch(/fusionado en main.*Rama portada borrada/);
    const put = calls.find((x) => x.path.endsWith("/merge"))!;
    expect(put.body).toMatchObject({ merge_method: "squash", sha: "abc1234" });
    expect(calls.some((x) => x.method === "DELETE" && x.path.endsWith("/heads/portada"))).toBe(true);
  });

  it("con ignorar_checks fusiona aunque un check falle (solo si se pide)", async () => {
    const c = addConnection("github", { repo: "yo/web" });
    setGrant(c.id, ana.id, "admin");
    checks = [{ name: "lint", status: "completed", conclusion: "failure" }];
    expect((await call(ana, "github_fusionar_pr", { numero: 5, ignorar_checks: true, borrar_rama: false })).error).toBe(false);
    expect(calls.some((x) => x.method === "DELETE")).toBe(false);
  });

  it("nunca borra la rama principal", async () => {
    const c = addConnection("github", { repo: "yo/web" });
    setGrant(c.id, ana.id, "admin");
    expect((await call(ana, "github_borrar_rama", { rama: "main" })).text).toMatch(/rama principal/);
    expect((await call(ana, "github_borrar_rama", { rama: "vieja" })).error).toBe(false);
  });

  it("revisa PRs con la firma del agente", async () => {
    const c = addConnection("github", { repo: "yo/web" });
    setGrant(c.id, ana.id, "admin");
    expect((await call(ana, "github_revisar_pr", { numero: 5, veredicto: "aprobar", texto: "Todo correcto" })).error).toBe(false);
    const review = calls.find((x) => x.path.endsWith("/reviews"))!;
    expect(review.body).toMatchObject({ event: "APPROVE" });
    expect((review.body as { body: string }).body).toContain("agente de Orden");
  });

  it("crea repos solo dentro de su acceso admin", async () => {
    const one = addConnection("github", { repo: "yo/web" });
    setGrant(one.id, ana.id, "admin");
    // Con acceso a un solo repo no puede crear otros.
    expect((await call(ana, "github_crear_repo", { nombre: "nuevo" })).text).toMatch(/hace falta un acceso admin/);
    const mine = addConnection("github", { repo: "yo/*" });
    setGrant(mine.id, ana.id, "admin");
    const created = await call(ana, "github_crear_repo", { nombre: "nuevo" });
    expect(created.error).toBe(false);
    expect(calls.find((x) => x.path === "/user/repos")!.body).toMatchObject({ name: "nuevo", private: true, auto_init: true });
    // Fuera de «yo/*» no.
    expect((await call(ana, "github_crear_repo", { nombre: "x", propietario: "acme" })).text).toMatch(/acme/);
    expect(calls.some((x) => x.path.startsWith("/orgs/"))).toBe(false);
  });
});
