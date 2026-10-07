import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getDb, now, parseJson } from "../db";
import { emit } from "../events";
import { getAgent } from "../repo/agents";
import { logActivity } from "../repo/system";
import type { Agent } from "../types";

/**
 * Taller de código de los agentes admin.
 *
 * Cada agente admin trabaja en su propia copia del proyecto (un worktree de
 * git en data/dev/<agente>, rama orden/<agente>). Nunca toca la app que está
 * en marcha. Cuando termina, sus cambios quedan como PROPUESTA: el usuario la
 * aplica (se valida, se fusiona y Orden se reinicia) o la descarta.
 */

export type ChangeStatus = "pendiente" | "validando" | "aplicada" | "descartada" | "error";

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

export interface CodeChange {
  id: string;
  agentId: string;
  branch: string;
  worktree: string;
  base: string;
  summary: string;
  files: ChangedFile[];
  status: ChangeStatus;
  log: string;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  agent_id: string;
  branch: string;
  worktree: string;
  base: string;
  summary: string;
  files: string;
  status: string;
  log: string;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}

const toChange = (r: Row): CodeChange => ({
  id: r.id,
  agentId: r.agent_id,
  branch: r.branch,
  worktree: r.worktree,
  base: r.base,
  summary: r.summary,
  files: parseJson(r.files, []),
  status: r.status as ChangeStatus,
  log: r.log,
  taskId: r.task_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function repoRoot(): string {
  return path.resolve(process.env.ORDEN_REPO ?? process.cwd());
}

function slug(agent: Agent) {
  const base = agent.name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base || "agente"}-${agent.id.slice(0, 6)}`;
}

export function workspacePaths(agent: Agent) {
  const name = slug(agent);
  const dataDir = path.dirname(process.env.ORDEN_DB_PATH ?? path.join(repoRoot(), "data", "orden.db"));
  return { dir: path.join(dataDir, "dev", name), branch: `orden/${name}` };
}

/** Ejecuta un comando y devuelve su salida (o lanza con la salida en el mensaje). */
export function run(cmd: string, args: string[], cwd: string, timeoutMs = 10 * 60_000, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0", ...env } }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
      if (err) reject(new Error(`${[cmd, ...args].join(" ")} falló:\n${out || err.message}`));
      else resolve(out);
    });
  });
}

const git = (args: string[], cwd: string) => run("git", args, cwd, 120_000);

/**
 * Prepara el índice de la copia con todo menos node_modules. En la copia es un
 * enlace al del proyecto y, fuera de Windows, git lo ve como archivo (la regla
 * «node_modules/» no lo ignora). También lo saca si una rama vieja ya lo tenía.
 * Ojo: nada de «:(exclude)node_modules»; si .gitignore ya lo ignora, git
 * aborta el add por nombrar una ruta ignorada.
 */
async function stageAll(dir: string) {
  await git(["add", "-A"], dir);
  await git(["rm", "-r", "--cached", "--ignore-unmatch", "-q", "--", "node_modules"], dir);
}

export async function gitAvailable(): Promise<boolean> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], repoRoot());
    return true;
  } catch {
    return false;
  }
}

/** Rama principal del proyecto (la que tiene la app en marcha). */
export async function mainBranch(): Promise<string> {
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot())).trim();
}

export function getChange(id: string): CodeChange | null {
  const r = getDb().prepare("SELECT * FROM code_changes WHERE id = ?").get(id) as unknown as Row | undefined;
  return r ? toChange(r) : null;
}

export function listChanges(agentId?: string, limit = 20): CodeChange[] {
  const rows = (agentId
    ? getDb().prepare("SELECT * FROM code_changes WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?").all(agentId, limit)
    : getDb().prepare("SELECT * FROM code_changes ORDER BY created_at DESC LIMIT ?").all(limit)) as unknown as Row[];
  return rows.map(toChange);
}

export function openChange(agentId: string): CodeChange | null {
  const r = getDb()
    .prepare("SELECT * FROM code_changes WHERE agent_id = ? AND status IN ('pendiente', 'validando', 'error') ORDER BY created_at DESC LIMIT 1")
    .get(agentId) as unknown as Row | undefined;
  return r ? toChange(r) : null;
}

function updateChange(id: string, fields: Partial<Pick<CodeChange, "summary" | "files" | "status" | "log" | "taskId" | "base">>) {
  const cur = getChange(id)!;
  const next = { ...cur, ...fields };
  getDb()
    .prepare("UPDATE code_changes SET summary = ?, files = ?, status = ?, log = ?, task_id = ?, base = ?, updated_at = ? WHERE id = ?")
    .run(next.summary, JSON.stringify(next.files), next.status, next.log.slice(-60_000), next.taskId, next.base, now(), id);
  const out = getChange(id)!;
  emit("code.updated", out);
  return out;
}

/**
 * Prepara (o pone al día) la copia de trabajo del agente. Si no tiene
 * cambios pendientes, se sincroniza con la versión actual de la app.
 */
export async function ensureWorkspace(agent: Agent): Promise<{ dir: string; branch: string }> {
  const root = repoRoot();
  if (!(await gitAvailable())) throw new Error("El proyecto no es un repositorio git: el rol admin necesita git para trabajar en una copia aparte.");
  const { dir, branch } = workspacePaths(agent);
  const head = (await git(["rev-parse", "HEAD"], root)).trim();
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(["worktree", "prune"], root);
    await git(["worktree", "add", "-f", "-B", branch, dir, head], root);
  } else {
    const pending = openChange(agent.id);
    const dirty = (await git(["status", "--porcelain"], dir)).trim();
    if (!pending && !dirty) await git(["reset", "--hard", head], dir);
  }
  // Las dependencias se comparten con la app (enlace, no copia).
  const nm = path.join(dir, "node_modules");
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(root, "node_modules"), nm, "junction");
  return { dir, branch };
}

/** Tras un encargo del agente admin: si hay cambios, crea o actualiza su propuesta. */
export async function captureChanges(agent: Agent, taskId: string, summary: string): Promise<CodeChange | null> {
  const { dir, branch } = workspacePaths(agent);
  if (!fs.existsSync(dir)) return null;
  await stageAll(dir);
  // Se compara con la versión ACTUAL de la app (la copia puede tener commits propios).
  const appHead = (await git(["rev-parse", "HEAD"], repoRoot())).trim();
  const numstat = (await git(["diff", "--cached", "--numstat", appHead], dir)).trim();
  const files: ChangedFile[] = numstat
    ? numstat.split("\n").map((l) => {
        const [a, r, ...p] = l.split("\t");
        return { path: p.join("\t"), added: Number(a) || 0, removed: Number(r) || 0 };
      })
    : [];
  const existing = openChange(agent.id);
  if (!files.length) {
    if (existing && existing.status !== "validando") return updateChange(existing.id, { files: [], summary, status: "pendiente" });
    return null;
  }
  if (existing) return updateChange(existing.id, { files, summary, taskId, status: existing.status === "validando" ? "validando" : "pendiente" });
  const id = randomUUID();
  const ts = now();
  const base = (await git(["rev-parse", "HEAD"], repoRoot())).trim();
  getDb()
    .prepare(
      `INSERT INTO code_changes (id, agent_id, branch, worktree, base, summary, files, status, log, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', '', ?, ?, ?)`,
    )
    .run(id, agent.id, branch, dir, base, summary, JSON.stringify(files), taskId, ts, ts);
  logActivity("codigo", `${agent.name} propone cambios en ${files.length} archivo(s)`, agent.id, { changeId: id });
  const change = getChange(id)!;
  emit("code.updated", change);
  return change;
}

/** Diff completo (recortado) para revisarlo en la interfaz. */
export async function changeDiff(id: string): Promise<string> {
  const c = getChange(id);
  if (!c || !fs.existsSync(c.worktree)) return "";
  await stageAll(c.worktree);
  const appHead = (await git(["rev-parse", "HEAD"], repoRoot())).trim();
  const diff = await git(["diff", "--cached", "--no-color", appHead], c.worktree);
  return diff.length > 400_000 ? diff.slice(0, 400_000) + "\n… (recortado)" : diff;
}

const node = process.execPath;
const bin = (dir: string, rel: string) => path.join(dir, "node_modules", ...rel.split("/"));

/** Pide al supervisor que reconstruya y reinicie Orden. */
export function requestRestart(reason: string) {
  const dataDir = path.dirname(process.env.ORDEN_DB_PATH ?? path.join(repoRoot(), "data", "orden.db"));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, ".restart"), JSON.stringify({ at: now(), reason }));
  emit("system.restarting", { reason });
}

type Step = (title: string, out?: string) => void;

/** Comprobaciones antes de fusionar: tipos, tests y (en producción) compilación. */
async function defaultValidator(dir: string, root: string, step: Step) {
  step("Comprobando tipos…");
  step("Tipos correctos", await run(node, [bin(dir, "typescript/bin/tsc"), "--noEmit"], dir));
  step("Ejecutando tests…");
  step("Tests superados", await run(node, [bin(dir, "vitest/vitest.mjs"), "run"], dir));
  if (process.env.ORDEN_MODE === "prod") {
    step("Compilando la versión de producción en la copia…");
    // node_modules de la copia es un enlace al del proyecto: Turbopack exige que
    // quede dentro de su raíz, así que la raíz es el proyecto principal.
    // La compilación va a .next de la copia (no a la de la app en marcha).
    step(
      "Compila",
      await run(node, [bin(dir, "next/dist/bin/next"), "build"], dir, 15 * 60_000, {
        ORDEN_TURBOPACK_ROOT: root,
        ORDEN_DIST_DIR: ".next",
      }),
    );
  }
}

let validator = defaultValidator;
/** Solo para tests: sustituir la validación (compilar de verdad es lento). */
export function setValidatorForTests(fn: typeof defaultValidator | null) {
  validator = fn ?? defaultValidator;
}

let applying = false;

/**
 * Aplica una propuesta: valida en la copia del agente (tipos, tests y, en
 * producción, build), la fusiona en la rama principal y pide el reinicio.
 * Si algo falla, no se toca la app.
 */
export async function applyChange(id: string, opts: { wait?: boolean } = {}): Promise<CodeChange> {
  const c = getChange(id);
  if (!c) throw new Error("No existe esa propuesta.");
  if (!["pendiente", "error"].includes(c.status)) throw new Error(`La propuesta está ${c.status}.`);
  if (applying) throw new Error("Ya se está aplicando otra propuesta.");
  applying = true;
  const agent = getAgent(c.agentId);
  let log = "";
  const step = (title: string, out = "") => {
    log += `▸ ${title}\n${out ? out.split("\n").slice(-40).join("\n") + "\n" : ""}`;
    updateChange(id, { log, status: "validando" });
  };
  updateChange(id, { status: "validando", log: "" });
  const work = (async () => {
    try {
      const dir = c.worktree;
      const root = repoRoot();
      const name = agent?.name ?? "Agente";
      const who = ["-c", `user.name=${name} (Orden)`, "-c", `user.email=${slug(agent ?? ({ name, id: c.agentId } as Agent))}@orden.local`];
      const first = (c.summary.split("\n").find((l) => l.trim()) ?? "Cambios").replace(/[#*`]/g, "").trim().slice(0, 72);

      // 1. Guardar el trabajo del agente en su rama.
      await stageAll(dir);
      if ((await git(["diff", "--cached", "--name-only"], dir)).trim()) {
        await git([...who, "commit", "-m", `${name}: ${first}`, "-m", c.summary.slice(0, 4000)], dir);
      }
      // 2. Ponerla al día con la versión actual de la app: se valida lo que quedará.
      step("Poniendo la copia al día con la app…");
      const appHead = (await git(["rev-parse", "HEAD"], root)).trim();
      try {
        await git([...who, "merge", "--no-edit", appHead], dir);
      } catch (err) {
        await git(["merge", "--abort"], dir).catch(() => {});
        throw new Error(`Sus cambios chocan con cambios recientes de la app. Pídele que los rehaga sobre la versión actual.\n${(err as Error).message}`);
      }
      // 3. Validar.
      await validator(dir, root, step);
      // 4. Fusionar en la app.
      step("Fusionando con la app…");
      try {
        step("Fusionado", await git(["-c", "user.name=Orden", "-c", "user.email=orden@orden.local", "merge", "--no-ff", "--no-edit", c.branch], root));
      } catch (err) {
        await git(["merge", "--abort"], root).catch(() => {});
        throw new Error(`No se pudo fusionar (¿hay cambios sin guardar en el proyecto que tocan los mismos archivos?).\n${(err as Error).message}`);
      }
      // La copia vuelve a estar al día y limpia.
      await git(["reset", "--hard", (await git(["rev-parse", "HEAD"], root)).trim()], dir);
      updateChange(id, { status: "aplicada", log: log + "▸ Aplicada. Orden se reinicia para cargar los cambios.\n" });
      logActivity("codigo", `Se aplican los cambios de ${name}: ${first}`, c.agentId, { changeId: id });
      requestRestart(`Cambios de ${name}`);
    } catch (err) {
      updateChange(id, { status: "error", log: `${log}✗ ${(err as Error).message}\n` });
      logActivity("error", `No se pudieron aplicar los cambios de ${agent?.name ?? "un agente"}`, c.agentId, { changeId: id });
    } finally {
      applying = false;
    }
  })();
  if (opts.wait) await work;
  return getChange(id)!;
}

/** Descarta la propuesta y deja la copia del agente igual que la app. */
export async function discardChange(id: string): Promise<CodeChange> {
  const c = getChange(id);
  if (!c) throw new Error("No existe esa propuesta.");
  if (c.status === "validando") throw new Error("Espera a que termine la validación.");
  if (fs.existsSync(c.worktree)) {
    const head = (await git(["rev-parse", "HEAD"], repoRoot())).trim();
    await git(["reset", "--hard", head], c.worktree);
    await git(["clean", "-fd"], c.worktree);
  }
  logActivity("codigo", "Se descartan unos cambios de código propuestos", c.agentId, { changeId: id });
  return updateChange(id, { status: "descartada" });
}
