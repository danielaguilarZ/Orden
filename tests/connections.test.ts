import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, getDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { createTask } from "@/lib/repo/tasks";
import { hireAgent } from "@/lib/team";
import { buildTools, type ToolDef } from "@/lib/agents/tools";
import { buildContext, buildSystemPrompt } from "@/lib/agents/prompt";
import { decryptSecret, encryptSecret, redact } from "@/lib/secrets";
import { getConnection, getConnectionSecret, grantsForAgent, listConnections, publicConnection, setConnectionSecret, setGrant } from "@/lib/repo/connections";
import { addConnection } from "@/lib/connections";
import { getService } from "@/lib/connections/registry";
import { parseRepo, safeBranch, safePath, setTransportForTests, type GhRequest } from "@/lib/connections/github/api";
import { statusMarkdown } from "@/lib/connections/github/status";
import "@/lib/agents/modules";
import type { Agent } from "@/lib/types";

const REPO = "mi-usuario/mi-web";
const BASE = `/repos/mi-usuario/mi-web`;

beforeAll(() => {
  process.env.ORDEN_SECRET_KEY = "a".repeat(64);
});
afterAll(() => {
  delete process.env.ORDEN_SECRET_KEY;
  setTransportForTests(null);
});

/** GitHub de mentira: registra las llamadas y responde lo mínimo. */
let calls: GhRequest[] = [];
let pulls: unknown[] = [];
function fakeGithub() {
  calls = [];
  pulls = [{ number: 7, title: "Nueva cabecera", state: "open", html_url: "https://github.com/x/pull/7", body: "", user: { login: "leo" }, draft: false, head: { ref: "feature/cabecera" }, base: { ref: "main" }, created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-02T10:00:00Z" }];
  setTransportForTests(async (req) => {
    calls.push(req);
    const p = req.path;
    if (p === BASE) return { full_name: REPO, default_branch: "main", html_url: `https://github.com/${REPO}`, private: true, open_issues_count: 2, permissions: { push: true } };
    if (p.startsWith(`${BASE}/pulls?`)) return pulls;
    if (p.startsWith(`${BASE}/issues?`))
      return [
        { number: 3, title: "Arreglar [menú] | móvil", state: "open", html_url: "https://github.com/x/issues/3", body: null, user: { login: "sara" }, labels: [{ name: "bug" }], comments: 0, created_at: "2026-09-30T10:00:00Z", updated_at: "2026-10-01T10:00:00Z" },
        { number: 7, title: "PR", state: "open", html_url: "", body: null, user: null, labels: [], comments: 0, created_at: "", updated_at: "2026-10-01T10:00:00Z", pull_request: {} },
      ];
    if (p.startsWith(`${BASE}/commits?`)) return [{ sha: "abcdef1234567", html_url: "https://github.com/x/commit/abcdef1", commit: { message: "Primer commit\n\ncuerpo", author: { name: "Ana", date: "2026-10-01T09:00:00Z" } }, author: { login: "ana" } }];
    if (p.startsWith(`${BASE}/git/ref/heads/`)) return { object: { sha: "1111111" } };
    if (p === `${BASE}/git/commits/1111111`) return { tree: { sha: "tree0" } };
    if (p === `${BASE}/git/trees`) return { sha: "tree1" };
    if (p === `${BASE}/git/commits`) return { sha: "2222222abc", html_url: "https://github.com/x/commit/2222222" };
    if (req.method === "PATCH" && p.startsWith(`${BASE}/git/refs/heads/`)) return {};
    if (p === `${BASE}/git/refs`) return {};
    if (p === `${BASE}/issues/3/comments`) return { id: 1, body: "", html_url: "https://github.com/x/issues/3#c1", user: null, created_at: "" };
    if (p === `${BASE}/issues` && req.method === "POST") return { number: 9, html_url: "https://github.com/x/issues/9" };
    if (p === `${BASE}/pulls` && req.method === "POST") return { number: 10, html_url: "https://github.com/x/pull/10" };
    if (p.startsWith("/search/code?")) return { total_count: 1, items: [{ path: "src/index.ts", html_url: "" }] };
    throw new Error(`Ruta no prevista en el test: ${req.method} ${p}`);
  });
}

let ana: Agent, leo: Agent, marta: Agent, sara: Agent;

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
  ana = hireAgent({ name: "Ana", specialty: "Desarrolladora backend" });
  leo = hireAgent({ name: "Leo", specialty: "Desarrollador frontend" });
  marta = hireAgent({ name: "Marta", specialty: "Coordinadora de proyectos" });
  sara = hireAgent({ name: "Sara", specialty: "Marketing" });
  fakeGithub();
});

/** Conexión de GitHub con permisos: Ana y Leo completo; Marta y Sara lectura. */
function connectGithub() {
  const c = addConnection("github", { repo: REPO });
  setGrant(c.id, ana.id, "completo");
  setGrant(c.id, leo.id, "completo");
  setGrant(c.id, marta.id, "lectura");
  setGrant(c.id, sara.id, "lectura");
  return c;
}

function toolsOf(agent: Agent): ToolDef[] {
  const task = createTask({ agentId: agent.id, kind: "chat", prompt: "x" });
  return buildTools({ agent, task, signal: new AbortController().signal, note: () => {} });
}
const githubNames = (agent: Agent) =>
  toolsOf(agent)
    .map((t) => t.name)
    .filter((n) => n.startsWith("github_"))
    .sort();

async function call(agent: Agent, name: string, args: Record<string, unknown>) {
  const t = toolsOf(agent).find((x) => x.name === name);
  if (!t) throw new Error(`${agent.name} no tiene ${name}`);
  return (await t.handler(args, {})) as { content: { text: string }[]; isError?: boolean };
}

describe("secretos", () => {
  it("cifra y descifra sin dejar el token en claro", () => {
    const token = "github_pat_11ABCDEFG0123456789_abcdefghijklmnop";
    const enc = encryptSecret(token);
    expect(enc).not.toContain(token);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(encryptSecret(token)).not.toBe(enc); // IV aleatorio
    expect(decryptSecret(enc)).toBe(token);
    expect(() => decryptSecret(enc.slice(0, -4) + "AAAA")).toThrow();
  });

  it("borra tokens de los mensajes de error", () => {
    expect(redact("fallo con ghp_abcdefghijklmnopqrstuvwxyz1234")).toBe("fallo con ***");
    expect(redact("token=mi-secreto-largo", "mi-secreto-largo")).toBe("token=***");
  });

  it("la BD guarda el token cifrado y la interfaz solo ve una pista", () => {
    const c = addConnection("github", { repo: REPO });
    setConnectionSecret(c.id, "github_pat_secreto_de_prueba_1234");
    const raw = getDb().prepare("SELECT secret FROM connections WHERE id = ?").get(c.id) as { secret: string };
    expect(raw.secret).not.toContain("secreto_de_prueba");
    expect(getConnectionSecret(c.id)).toBe("github_pat_secreto_de_prueba_1234");
    const pub = publicConnection(getConnection(c.id)!);
    expect(pub.secretHint).toBe("…1234");
    expect(JSON.stringify(pub)).not.toContain("secreto_de_prueba");
    setConnectionSecret(c.id, null);
    expect(getConnection(c.id)!.hasSecret).toBe(false);
  });
});

describe("validación del alcance", () => {
  it("repo, rutas y ramas", () => {
    expect(parseRepo("https://github.com/mi-usuario/mi-web.git").full).toBe(REPO);
    expect(() => parseRepo("mi-web")).toThrow();
    expect(() => parseRepo("a/b/c")).toThrow();
    expect(safePath("./src\\app/page.tsx")).toBe("src/app/page.tsx");
    expect(() => safePath("../otro-repo/x")).toThrow();
    expect(() => safePath("src/../../x")).toThrow();
    expect(safePath("", { allowRoot: true })).toBe("");
    expect(safeBranch("feature/nueva-cabecera")).toBe("feature/nueva-cabecera");
    for (const bad of ["", "-x", "a..b", "a b", "a//b", "x.lock", "../main", ".oculta"]) expect(() => safeBranch(bad)).toThrow();
  });

  it("no se pueden crear conexiones duplicadas ni con repos mal escritos", () => {
    addConnection("github", { repo: REPO });
    expect(() => addConnection("github", { repo: REPO })).toThrow(/ya existe/);
    expect(() => addConnection("github", { repo: "nada" })).toThrow();
  });
});

describe("conexiones y permisos", () => {
  it("no hay ninguna conexión de serie", () => {
    expect(listConnections()).toHaveLength(0);
  });

  it("cada agente solo tiene el permiso que se le da", () => {
    const c = connectGithub();
    expect(getConnection(c.id)!.grants).toEqual({ [ana.id]: "completo", [leo.id]: "completo", [marta.id]: "lectura", [sara.id]: "lectura" });
    expect(grantsForAgent(getChief()!.id, "github")).toHaveLength(0);
  });

  it("cada agente solo ve las herramientas de su nivel", () => {
    connectGithub();
    const lectura = ["github_archivos", "github_buscar", "github_comentar", "github_commits", "github_leer", "github_lista", "github_resumen", "github_ver"];
    const escritura = ["github_commit", "github_crear_issue", "github_crear_pr", "github_crear_rama", "github_editar_issue"];
    expect(githubNames(getChief()!)).toEqual([]);
    expect(githubNames(marta)).toEqual(lectura);
    expect(githubNames(sara)).toEqual(lectura);
    expect(githubNames(ana)).toEqual([...lectura, ...escritura].sort());
    expect(githubNames(leo)).toEqual([...lectura, ...escritura].sort());
  });

  it("los permisos se cambian y se desactivan", () => {
    const c = connectGithub();
    setGrant(c.id, marta.id, "completo");
    expect(githubNames(marta)).toContain("github_commit");
    setGrant(c.id, marta.id, null);
    expect(githubNames(marta)).toEqual([]);
    getDb().prepare("UPDATE connections SET enabled = 0").run();
    expect(githubNames(ana)).toEqual([]);
  });

  it("el prompt lo explica y el jefe sabe a quién delegar", () => {
    connectGithub();
    const task = createTask({ agentId: ana.id, kind: "chat", prompt: "x" });
    expect(buildSystemPrompt(ana, task)).toContain(`Repo ${REPO} · tu permiso: completo`);
    expect(buildSystemPrompt(marta, task)).toContain("tu permiso: lectura");
    expect(buildSystemPrompt(getChief()!, task)).not.toContain("Conexión con GitHub");
    const ctx = buildContext(getChief()!, task);
    expect(ctx).toContain("Ana (completo)");
    expect(ctx).toContain("Sara (lectura)");
  });
});

describe("herramientas de GitHub", () => {
  beforeEach(() => connectGithub());

  it("todas las llamadas se quedan en el repo configurado", async () => {
    await call(marta, "github_resumen", {});
    await call(marta, "github_lista", { tipo: "issues" });
    await call(marta, "github_buscar", { texto: "cabecera repo:otro/repo org:evil" });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      if (c.path.startsWith("/search/")) {
        const q = decodeURIComponent(c.path);
        expect(q).toContain(`repo:${REPO}`);
        expect(q).not.toContain("otro/repo");
        expect(q).not.toContain("org:evil");
      } else expect(c.path.startsWith(BASE)).toBe(true);
    }
  });

  it("rechaza rutas que intentan salir del repo", async () => {
    const r = await call(marta, "github_leer", { ruta: "../../users/otro/repo" });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("lectura puede comentar (firmado) pero no escribir código", async () => {
    const r = await call(sara, "github_comentar", { numero: 3, texto: "Revisado" });
    expect(r.isError).toBeUndefined();
    const post = calls.find((c) => c.method === "POST")!;
    expect((post.body as { body: string }).body).toContain("Sara, agente de Orden");
    await expect(call(sara, "github_commit", { rama: "x", mensaje: "m", archivos: [] })).rejects.toThrow(/no tiene/);
  });

  it("commit: varios archivos en una rama, nunca en la principal", async () => {
    const main = await call(ana, "github_commit", { rama: "main", mensaje: "directo", archivos: [{ ruta: "a.txt", contenido: "a" }] });
    expect(main.isError).toBe(true);
    expect(main.content[0].text).toMatch(/rama principal/);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);

    const ok = await call(ana, "github_commit", {
      rama: "feature/cabecera",
      mensaje: "Cabecera nueva",
      archivos: [
        { ruta: "src/Header.tsx", contenido: "export {}" },
        { ruta: "old.txt", borrar: true },
      ],
    });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0].text).toContain("2222222");
    const tree = calls.find((c) => c.path === `${BASE}/git/trees`)!.body as { base_tree: string; tree: { path: string; sha?: null; content?: string }[] };
    expect(tree.base_tree).toBe("tree0");
    expect(tree.tree).toEqual([
      { path: "src/Header.tsx", mode: "100644", type: "blob", content: "export {}" },
      { path: "old.txt", mode: "100644", type: "blob", sha: null },
    ]);
    const update = calls.find((c) => c.method === "PATCH")!;
    expect(update.path).toBe(`${BASE}/git/refs/heads/feature/cabecera`);
    expect(update.body).toEqual({ sha: "2222222abc", force: false });
  });

  it("rama, issue y PR", async () => {
    expect((await call(leo, "github_crear_rama", { nombre: "feature/x" })).isError).toBeUndefined();
    expect(calls.find((c) => c.path === `${BASE}/git/refs`)!.body).toEqual({ ref: "refs/heads/feature/x", sha: "1111111" });
    expect((await call(leo, "github_crear_issue", { titulo: "Bug" })).content[0].text).toContain("#9");
    const pr = await call(leo, "github_crear_pr", { titulo: "Cabecera", rama: "feature/x" });
    expect(pr.content[0].text).toContain("#10");
    expect(calls.find((c) => c.path === `${BASE}/pulls` && c.method === "POST")!.body).toMatchObject({ head: "feature/x", base: "main" });
  });
});

describe("resumen del repo (sin panel)", () => {
  beforeEach(() => connectGithub());

  it("markdown con PRs, issues (sin PRs) y commits", () => {
    const md = statusMarkdown(
      {
        repo: REPO,
        url: "https://github.com/x",
        defaultBranch: "main",
        pulls: pulls as never,
        issues: [{ number: 3, title: "Arreglar [menú] | móvil", state: "open", html_url: "u", body: null, user: { login: "sara" }, labels: ["bug"], comments: 0, created_at: "", updated_at: "2026-10-01T10:00:00Z" }],
        commits: [],
      },
      new Date("2026-10-03T18:00:00Z"),
    );
    expect(md).toContain("### Pull requests abiertos (1)");
    expect(md).toContain("[#7 Nueva cabecera]");
    expect(md).toContain("[#3 Arreglar menú móvil]"); // sin corchetes ni barras que rompan el enlace
    expect(md).toContain("`bug`");
    expect(md).toContain("### Últimos commits en `main`");
    expect(md.split("\n")[1]).toMatch(/^_Consultado: .+_$/);
  });

  it("github_resumen lo da al momento y no crea ningún panel", async () => {
    const r = await call(marta, "github_resumen", {});
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Pull requests abiertos (1)");
    expect(r.content[0].text).toContain("Tu permiso: lectura");
    const c = listConnections("github")[0];
    expect(getConnection(c.id)!.statusPanelId).toBeNull();
    expect("sync" in getService("github")).toBe(false);
  });

  it("la configuración ya no lleva «panel» y las antiguas siguen contando como duplicadas", () => {
    const c = listConnections("github")[0];
    expect(c.config).toEqual({ repo: REPO });
    getDb().prepare("UPDATE connections SET config = ? WHERE id = ?").run(JSON.stringify({ repo: REPO, panel: true }), c.id);
    expect(() => addConnection("github", { repo: REPO })).toThrow(/ya existe/);
  });

  it("los errores no filtran tokens", async () => {
    setTransportForTests(async () => {
      throw new Error("Bad credentials ghp_abcdefghijklmnopqrstuvwxyz1234");
    });
    const r = await call(marta, "github_resumen", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Bad credentials");
    expect(r.content[0].text).not.toContain("ghp_");
  });
});
