import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getConnectionSecret, type Connection } from "../../repo/connections";
import { redact } from "../../secrets";

/**
 * Acceso a la API REST de GitHub por dos vías:
 * - `gh` (GitHub CLI) ya autenticado en el PC: `gh api …`.
 * - Token fine-grained guardado (cifrado) en la conexión: `fetch` directo.
 * Todo pasa por `RepoApi`, que solo construye rutas del repo configurado:
 * los agentes nunca eligen owner/repo ni escriben rutas de la API.
 */

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export interface GhRequest {
  method: Method;
  /** Ruta de la API, empezando por «/». */
  path: string;
  body?: unknown;
}
export type Transport = (req: GhRequest) => Promise<unknown>;

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 60_000;

/**
 * Valor de `config.repo` de una conexión de cuenta: todos los repos que ve la
 * credencial (la del inicio de sesión con GitHub o un token clásico).
 */
export const ALL_REPOS = "*";

/** ¿Lo escrito en «Repositorio» significa «todos»? («*», «todos», «todos los repositorios»…). */
export const isAllRepos = (value: unknown) => /^(\*|todos?|all)(\s+(los\s+)?(repos|repositorios))?$/i.test(String(value ?? "").trim());

// ── Validación (todo lo que viene de un agente pasa por aquí) ─────────────

/** «owner/repo» con los caracteres que admite GitHub. */
export function parseRepo(value: unknown): { owner: string; name: string; full: string } {
  const s = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const m = s.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/);
  if (!m || m[2] === "." || m[2] === "..") throw new Error("El repo debe ser «propietario/nombre», p. ej. mi-usuario/mi-repo.");
  return { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}` };
}

/** Ruta de archivo dentro del repo (relativa, sin «..»). "" = raíz. */
export function safePath(value: string | undefined, opts: { allowRoot?: boolean } = {}): string {
  const s = (value ?? "").trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s) {
    if (opts.allowRoot) return "";
    throw new Error("Falta la ruta del archivo.");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(s)) throw new Error("La ruta tiene caracteres no válidos.");
  const parts = s.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new Error(`Ruta no válida: «${value}». Usa rutas relativas al repo, sin «..».`);
  return parts.join("/");
}

/** Nombre de rama válido para git (subconjunto prudente). */
export function safeBranch(value: string | undefined): string {
  const s = (value ?? "").trim().replace(/^refs\/heads\//, "");
  const bad =
    !s ||
    s.length > 200 ||
    !/^[A-Za-z0-9._/-]+$/.test(s) ||
    s.startsWith("-") ||
    s.startsWith("/") ||
    s.endsWith("/") ||
    s.endsWith(".") ||
    s.endsWith(".lock") ||
    s.includes("..") ||
    s.includes("//") ||
    s.split("/").some((p) => p.startsWith("."));
  if (bad) throw new Error(`Nombre de rama no válido: «${value}». Usa letras, números, «-», «_», «.» y «/», p. ej. feature/nueva-cabecera.`);
  return s;
}

/** SHA de commit (corto o largo). */
export function safeSha(value: string): string {
  const s = value.trim();
  if (!/^[0-9a-f]{4,40}$/i.test(s)) throw new Error(`SHA no válido: «${value}».`);
  return s;
}

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

function query(params: Record<string, string | number | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return q ? `?${q}` : "";
}

// ── Transportes ───────────────────────────────────────────────────────────

/** `gh api`: usa la sesión del GitHub CLI del usuario. */
export function ghTransport(bin = process.env.ORDEN_GH_BIN ?? "gh"): Transport {
  return (req) =>
    new Promise((resolve, reject) => {
      const args = ["api", "--method", req.method, "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", req.path.replace(/^\//, "")];
      if (req.body !== undefined) args.push("--input", "-");
      const child = spawn(bin, args, {
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1" },
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new GitHubError(0, `No se pudo ejecutar gh: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const data = parseBody(out);
        if (code === 0) return resolve(data);
        const status = Number(err.match(/HTTP (\d{3})/)?.[1] ?? 0);
        const msg = (data as { message?: string } | null)?.message ?? err.trim() ?? `gh terminó con código ${code}`;
        reject(new GitHubError(status, redact(msg)));
      });
      if (req.body !== undefined) child.stdin.end(JSON.stringify(req.body));
      else child.stdin.end();
    });
}

/** API REST con un token (fine-grained o clásico). */
export function tokenTransport(token: string, base = "https://api.github.com"): Transport {
  return async (req) => {
    let res: Response;
    try {
      res = await fetch(base + req.path, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Orden",
          ...(req.body !== undefined && { "Content-Type": "application/json" }),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new GitHubError(0, redact(`Sin conexión con GitHub: ${(e as Error).message}`, token));
    }
    const data = parseBody(await res.text());
    if (!res.ok) throw new GitHubError(res.status, redact((data as { message?: string } | null)?.message ?? `HTTP ${res.status}`, token));
    return data;
  };
}

function parseBody(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── Elegir vía de acceso ──────────────────────────────────────────────────

let ghCache: { at: number; ok: boolean; detail: string } | null = null;
const GH_CACHE_MS = 5 * 60_000;

/** ¿Está `gh` instalado y con sesión iniciada? (se cachea 5 min) */
export function ghStatus(force = false): Promise<{ ok: boolean; detail: string }> {
  if (!force && ghCache && Date.now() - ghCache.at < GH_CACHE_MS) return Promise.resolve(ghCache);
  const bin = process.env.ORDEN_GH_BIN ?? "gh";
  return new Promise((resolve) => {
    const done = (ok: boolean, detail: string) => {
      ghCache = { at: Date.now(), ok, detail };
      resolve(ghCache);
    };
    let out = "";
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, ["auth", "status", "--hostname", "github.com"], { windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } });
    } catch (e) {
      return done(false, `gh no está disponible (${(e as Error).message}).`);
    }
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      done(false, "gh no está instalado (o no está en el PATH).");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const account = out.match(/account\s+(\S+)/i)?.[1] ?? out.match(/as\s+(\S+)/i)?.[1];
      if (code === 0) done(true, `gh con sesión iniciada${account ? ` como ${account}` : ""}.`);
      else done(false, "gh está instalado pero sin sesión (ejecuta «gh auth login»).");
    });
  });
}

let testTransport: Transport | null = null;
/** Para tests: sustituye cualquier acceso real a GitHub. */
export function setTransportForTests(t: Transport | null) {
  testTransport = t;
}

/** Elige gh o token según la conexión. Lanza un error claro si no hay ninguna vía. */
export async function resolveTransport(c: Connection): Promise<{ transport: Transport; via: "gh" | "token" | "test" }> {
  if (testTransport) return { transport: testTransport, via: "test" };
  const token = () => {
    const t = getConnectionSecret(c.id);
    return t ? { transport: tokenTransport(t), via: "token" as const } : null;
  };
  if (c.auth === "token") {
    const t = token();
    if (!t) throw new Error("Esta conexión usa token y no hay ninguno guardado. Añádelo en Conexiones.");
    return t;
  }
  const gh = await ghStatus();
  if (gh.ok) return { transport: ghTransport(), via: "gh" };
  if (c.auth === "gh") throw new Error(`Esta conexión usa gh y no está disponible: ${gh.detail}`);
  const t = token();
  if (t) return t;
  throw new Error(`Sin acceso a GitHub: ${gh.detail} Tampoco hay token guardado. Configúralo en Conexiones.`);
}

// ── API limitada a un repo ────────────────────────────────────────────────

/**
 * Cliente atado a un único repo. Las rutas se construyen aquí con segmentos
 * codificados: un agente no puede salir de `/repos/{owner}/{repo}`.
 */
export class RepoApi {
  readonly full: string;
  private base: string;
  private defaultBranchCache: string | null = null;

  constructor(
    repo: string,
    private transport: Transport,
  ) {
    const r = parseRepo(repo);
    this.full = r.full;
    this.base = `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
  }

  private call<T>(method: Method, sub: string, body?: unknown): Promise<T> {
    if (sub && !sub.startsWith("/")) throw new Error("Ruta interna no válida.");
    if (sub.split("?")[0].split("/").includes("..")) throw new Error("Ruta interna no válida.");
    return this.transport({ method, path: this.base + sub, body }) as Promise<T>;
  }

  info() {
    return this.call<RepoInfo>("GET", "");
  }
  async defaultBranch(): Promise<string> {
    if (!this.defaultBranchCache) this.defaultBranchCache = (await this.info()).default_branch;
    return this.defaultBranchCache;
  }

  contents(path: string, ref?: string) {
    return this.call<ContentItem | ContentItem[]>("GET", `${path ? `/contents/${encPath(path)}` : "/contents"}${query({ ref })}`);
  }
  tree(ref: string) {
    return this.call<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>("GET", `/git/trees/${encPath(ref)}${query({ recursive: 1 })}`);
  }
  commits(opts: { branch?: string; path?: string; limit?: number }) {
    return this.call<CommitItem[]>("GET", `/commits${query({ sha: opts.branch, path: opts.path, per_page: opts.limit ?? 10 })}`);
  }
  commit(sha: string) {
    return this.call<CommitDetail>("GET", `/commits/${encodeURIComponent(sha)}`);
  }
  issues(opts: { state?: string; labels?: string; limit?: number }) {
    return this.call<IssueItem[]>("GET", `/issues${query({ state: opts.state ?? "open", labels: opts.labels, per_page: opts.limit ?? 20 })}`);
  }
  pulls(opts: { state?: string; limit?: number }) {
    return this.call<PullItem[]>("GET", `/pulls${query({ state: opts.state ?? "open", per_page: opts.limit ?? 20 })}`);
  }
  issue(n: number) {
    return this.call<IssueItem>("GET", `/issues/${n}`);
  }
  pull(n: number) {
    return this.call<PullItem>("GET", `/pulls/${n}`);
  }
  pullFiles(n: number) {
    return this.call<FileChange[]>("GET", `/pulls/${n}/files${query({ per_page: 50 })}`);
  }
  comments(n: number) {
    return this.call<CommentItem[]>("GET", `/issues/${n}/comments${query({ per_page: 30 })}`);
  }
  comment(n: number, body: string) {
    return this.call<CommentItem>("POST", `/issues/${n}/comments`, { body });
  }
  createIssue(body: { title: string; body?: string; labels?: string[] }) {
    return this.call<IssueItem>("POST", "/issues", body);
  }
  editIssue(n: number, body: { title?: string; body?: string; state?: string; labels?: string[] }) {
    return this.call<IssueItem>("PATCH", `/issues/${n}`, body);
  }
  async branchSha(branch: string): Promise<string> {
    const ref = await this.call<{ object: { sha: string } }>("GET", `/git/ref/heads/${encPath(branch)}`);
    return ref.object.sha;
  }
  createBranch(branch: string, sha: string) {
    return this.call<unknown>("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha });
  }
  /** Un commit con varios archivos (crear, modificar o borrar) sobre una rama existente. */
  async commitFiles(branch: string, message: string, files: { path: string; content?: string; delete?: boolean }[]) {
    const parent = await this.branchSha(branch);
    const base = await this.call<{ tree: { sha: string } }>("GET", `/git/commits/${parent}`);
    const tree = await this.call<{ sha: string }>("POST", "/git/trees", {
      base_tree: base.tree.sha,
      tree: files.map((f) => (f.delete ? { path: f.path, mode: "100644", type: "blob", sha: null } : { path: f.path, mode: "100644", type: "blob", content: f.content ?? "" })),
    });
    const commit = await this.call<{ sha: string; html_url: string }>("POST", "/git/commits", { message, tree: tree.sha, parents: [parent] });
    await this.call<unknown>("PATCH", `/git/refs/heads/${encPath(branch)}`, { sha: commit.sha, force: false });
    return commit;
  }
  createPull(body: { title: string; head: string; base: string; body?: string; draft?: boolean }) {
    return this.call<PullItem>("POST", "/pulls", body);
  }
  /** Búsqueda de código SOLO en este repo (se quitan calificadores que amplíen el alcance). */
  searchCode(text: string) {
    const clean = text.replace(/\b(repo|org|user|owner):\S+/gi, " ").replace(/\s+/g, " ").trim();
    if (!clean) throw new Error("Escribe qué buscar.");
    return this.transport({ method: "GET", path: `/search/code${query({ q: `${clean} repo:${this.full}`, per_page: 20 })}` }) as Promise<{
      total_count: number;
      items: { path: string; html_url: string }[];
    }>;
  }
}

/** Preguntas sobre la cuenta (no sobre un repo): quién es y qué repos tiene. Solo lectura. */
export class AccountApi {
  constructor(private transport: Transport) {}

  me() {
    return this.transport({ method: "GET", path: "/user" }) as Promise<{ login: string }>;
  }
  repos(limit = 50) {
    return this.transport({
      method: "GET",
      path: `/user/repos${query({ per_page: Math.max(1, Math.min(limit, 100)), sort: "pushed", affiliation: "owner,collaborator,organization_member" })}`,
    }) as Promise<AccountRepo[]>;
  }
}

// ── Tipos mínimos de la API ───────────────────────────────────────────────

export interface AccountRepo {
  full_name: string;
  private: boolean;
  fork?: boolean;
  archived?: boolean;
  default_branch: string;
  description: string | null;
  pushed_at: string | null;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export interface RepoInfo {
  full_name: string;
  default_branch: string;
  html_url: string;
  private: boolean;
  open_issues_count: number;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}
export interface ContentItem {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  size: number;
  encoding?: string;
  content?: string;
  html_url?: string;
}
export interface User {
  login: string;
}
export interface CommitItem {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } | null };
  author: User | null;
}
export interface FileChange {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}
export interface CommitDetail extends CommitItem {
  stats?: { additions: number; deletions: number; total: number };
  files?: FileChange[];
}
export interface IssueItem {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  user: User | null;
  labels: ({ name: string } | string)[];
  comments: number;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}
export interface PullItem {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  user: User | null;
  draft?: boolean;
  merged?: boolean;
  head: { ref: string };
  base: { ref: string };
  created_at: string;
  updated_at: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  mergeable?: boolean | null;
}
export interface CommentItem {
  id: number;
  body: string;
  html_url: string;
  user: User | null;
  created_at: string;
}
