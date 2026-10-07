import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openDb, setDbForTests } from "@/lib/db";
import { ensureSeed } from "@/lib/seed";
import { getChief } from "@/lib/repo/agents";
import { activeConversation, listMessages } from "@/lib/repo/chat";
import { createTask } from "@/lib/repo/tasks";
import { editAgent, hireAgent } from "@/lib/team";
import { runTask, type QueryFn } from "@/lib/agents/runner";
import { buildContext, buildSystemPrompt } from "@/lib/agents/prompt";
import { applyChange, changeDiff, discardChange, listChanges, setValidatorForTests, workspacePaths } from "@/lib/dev/workspace";
import "@/lib/agents/modules";

let repo: string;
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

beforeAll(() => {
  // Un proyecto de juguete con git, para no tocar el de verdad.
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "orden-admin-"));
  gitIn(repo, "init", "-q");
  fs.writeFileSync(path.join(repo, "README.md"), "# Juguete\n");
  // La misma regla que el proyecto: «node_modules» sin barra también ignora el enlace de las copias.
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\ndata/\n");
  fs.mkdirSync(path.join(repo, "node_modules"));
  gitIn(repo, "add", "-A");
  gitIn(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "inicio");
  process.env.ORDEN_REPO = repo;
  process.env.ORDEN_DB_PATH = path.join(repo, "data", "orden.db");
});

afterAll(() => {
  delete process.env.ORDEN_REPO;
  delete process.env.ORDEN_DB_PATH;
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: repo });
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    // Windows a veces tarda en soltar archivos
  }
});

beforeEach(() => {
  setDbForTests(openDb(":memory:"));
  ensureSeed();
});

const result = { type: "result", subtype: "success", result: "Añadido CAMBIOS.md", usage: {}, total_cost_usd: 0, num_turns: 1, duration_ms: 1 };

describe("rol admin", () => {
  it("solo lo activa el usuario, y el equipo sabe quién programa", () => {
    const lucy = hireAgent({ name: "Lucy", specialty: "Desarrolladora", model: "opus" });
    expect(lucy.admin).toBe(false);
    const admin = editAgent(lucy.id, { admin: true });
    expect(admin.admin).toBe(true);
    const zen = getChief()!;
    const task = createTask({ agentId: zen.id, kind: "chat", prompt: "x" });
    expect(buildContext(zen, task)).toContain("Lucy: Desarrolladora [admin");
    expect(buildSystemPrompt(admin, task)).toContain("Rol admin");
    expect(buildSystemPrompt(zen, task)).not.toContain("Rol admin");
  });

  it("trabaja en su copia con herramientas confinadas y deja una propuesta; descartar la limpia", async () => {
    const lucy = editAgent(hireAgent({ name: "Lucy", specialty: "Desarrolladora", model: "opus" }).id, { admin: true });
    const conv = activeConversation(lucy.id);
    let opts: Record<string, unknown> = {};
    const q = ((args: { options: Record<string, unknown> }) => {
      opts = args.options;
      // Simula que el agente edita un archivo en su directorio de trabajo.
      fs.writeFileSync(path.join(String(args.options.cwd), "CAMBIOS.md"), "nuevo\n");
      return (async function* () {
        yield result;
      })();
    }) as unknown as QueryFn;

    await runTask(createTask({ agentId: lucy.id, kind: "chat", prompt: "Añade CAMBIOS.md", conversationId: conv.id }), { queryFn: q });

    const { dir } = workspacePaths(lucy);
    expect(opts.cwd).toBe(dir);
    expect(opts.tools).toEqual(["Read", "Edit", "Write", "Glob", "Grep", "Bash"]);
    expect(opts.allowedTools).toContain("Edit(./**)");
    expect(opts.allowedTools).not.toContain("Bash");
    // La app de verdad no se ha tocado.
    expect(fs.existsSync(path.join(repo, "CAMBIOS.md"))).toBe(false);

    const [change] = listChanges(lucy.id);
    expect(change.status).toBe("pendiente");
    expect(change.files.map((f) => f.path)).toEqual(["CAMBIOS.md"]);
    expect(await changeDiff(change.id)).toContain("+nuevo");
    expect(listMessages(conv.id).some((m) => m.data.kind === "code")).toBe(true);

    await discardChange(change.id);
    expect(fs.existsSync(path.join(dir, "CAMBIOS.md"))).toBe(false);
    expect(listChanges(lucy.id)[0].status).toBe("descartada");
  });

  it("aplicar: se pone al día con la app, valida, fusiona y pide reinicio", async () => {
    const lucy = editAgent(hireAgent({ name: "Lucy", specialty: "Desarrolladora", model: "opus" }).id, { admin: true });
    const write = (file: string, text: string) =>
      ((args: { options: Record<string, unknown> }) => {
        fs.writeFileSync(path.join(String(args.options.cwd), file), text);
        return (async function* () {
          yield result;
        })();
      }) as unknown as QueryFn;
    await runTask(createTask({ agentId: lucy.id, kind: "chat", prompt: "x" }), { queryFn: write("lucy.txt", "de Lucy\n") });
    // Mientras tanto, la app avanza (otro commit en la rama principal).
    fs.writeFileSync(path.join(repo, "app.txt"), "nuevo en la app\n");
    gitIn(repo, "add", "app.txt");
    gitIn(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "la app avanza");

    const [change] = listChanges(lucy.id);
    // La propuesta solo muestra lo de Lucy, no lo que avanzó la app.
    expect(change.files.map((f) => f.path)).toEqual(["lucy.txt"]);
    const seen: string[] = [];
    setValidatorForTests(async (dir) => {
      // Se valida la copia YA puesta al día: tiene lo de Lucy y lo nuevo de la app.
      seen.push(...["lucy.txt", "app.txt"].filter((f) => fs.existsSync(path.join(dir, f))));
    });
    const done = await applyChange(change.id, { wait: true });
    setValidatorForTests(null);
    expect(done.status).toBe("aplicada");
    expect(seen).toEqual(["lucy.txt", "app.txt"]);
    expect(fs.readFileSync(path.join(repo, "lucy.txt"), "utf8").trim()).toBe("de Lucy");
    expect(fs.existsSync(path.join(repo, "data", ".restart"))).toBe(true);
  });

  it("si la validación falla, la app no se toca y se puede reintentar", async () => {
    const lucy = editAgent(hireAgent({ name: "Lucy", specialty: "Desarrolladora", model: "opus" }).id, { admin: true });
    const q = ((args: { options: Record<string, unknown> }) => {
      fs.writeFileSync(path.join(String(args.options.cwd), "roto.txt"), "x\n");
      return (async function* () {
        yield result;
      })();
    }) as unknown as QueryFn;
    await runTask(createTask({ agentId: lucy.id, kind: "chat", prompt: "x" }), { queryFn: q });
    const [change] = listChanges(lucy.id);
    setValidatorForTests(async () => {
      throw new Error("tests rotos");
    });
    const failed = await applyChange(change.id, { wait: true });
    setValidatorForTests(null);
    expect(failed.status).toBe("error");
    expect(failed.log).toContain("tests rotos");
    expect(fs.existsSync(path.join(repo, "roto.txt"))).toBe(false);
    // La propuesta sigue mostrando el cambio para reintentar.
    expect(listChanges(lucy.id)[0].files.map((f) => f.path)).toEqual(["roto.txt"]);
  });

  it("un agente normal no recibe herramientas de código", async () => {
    const zen = getChief()!;
    let opts: Record<string, unknown> = {};
    const q = ((args: { options: Record<string, unknown> }) => {
      opts = args.options;
      return (async function* () {
        yield result;
      })();
    }) as unknown as QueryFn;
    await runTask(createTask({ agentId: zen.id, kind: "chat", prompt: "hola" }), { queryFn: q });
    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).toEqual(["mcp__orden"]);
  });
});
