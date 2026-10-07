import { z } from "zod";
import { defineTool, fail, ok, type ToolContext, type ToolDef } from "../../agents/tools";
import { logActivity } from "../../repo/system";
import { redact } from "../../secrets";
import type { AgentGrant } from "../registry";
import { createRepo, currentUser, parseRepo, RepoApi, resolveTransport, safeBranch, safePath, safeSha, type ContentItem, type IssueItem } from "./api";
import { levelAtLeast, type GrantLevel } from "../../repo/connections";
import { inScope, isWildcard, listScopeRepos, scopeLabel } from "./scope";
import { fetchSnapshot, statusMarkdown } from "./status";

/**
 * Herramientas de GitHub para un agente. Solo aparecen las de su nivel:
 * - lectura: leer código, commits, issues y PRs, buscar y comentar.
 * - completo: además crear/editar issues, ramas, commits y PRs.
 * El repo sale SIEMPRE de la conexión: el agente no puede indicar otro. Si la
 * conexión cubre varios («propietario/*» o «*»), el agente elige uno dentro de
 * ese alcance y GitHub pone el límite real (lo que la cuenta puede ver o escribir).
 */

const MAX_OUT = 30_000;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 500_000;

export function clip(text: string, max = MAX_OUT): string {
  return text.length > max ? `${text.slice(0, max)}\n… (recortado: ${text.length - max} caracteres más)` : text;
}

const day = (iso: string) => iso.slice(0, 10);
const labelsOf = (i: IssueItem) => i.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);

/** Firma para lo que se publica con la cuenta del usuario. */
export const signature = (agentName: string) => `\n\n---\n_Escrito por ${agentName}, agente de Orden._`;

export function githubTools(ctx: ToolContext, grants: AgentGrant[]): ToolDef[] {
  if (!grants.length) return [];
  const scopeOf = (g: AgentGrant) => String(g.connection.config.repo);
  const repos = grants.map(scopeOf);
  const fullRepos = grants.filter((g) => levelAtLeast(g.level, "completo")).map(scopeOf);
  const adminRepos = grants.filter((g) => g.level === "admin").map(scopeOf);
  const wildcard = repos.some(isWildcard);
  const multi = repos.length > 1 || wildcard;

  /** Parámetro «repo» solo si tiene varios; siempre limitado a los suyos. */
  const repoShape = (list: string[]): Record<string, z.ZodType> => {
    if (!multi || !list.length) return {};
    if (list.some(isWildcard)) return { repo: z.string().describe("Repo «propietario/nombre» dentro de tu acceso (github_repos los lista)") };
    return { repo: z.enum(list as [string, ...string[]]).describe("Repo (solo los que tienes conectados)") };
  };

  /** Conexión y repo para una llamada: el repo concreto pedido, o el único que tiene. */
  /** need: false = leer, true = escribir (completo), "admin" = fusionar, borrar ramas… */
  const pick = (repo: unknown, need: boolean | "admin"): { g: AgentGrant; full: string } => {
    const min: GrantLevel = need === "admin" ? "admin" : need ? "completo" : "lectura";
    const list = grants.filter((g) => levelAtLeast(g.level, min));
    const denied =
      need === "admin" ? "Eso necesita permiso «admin» en ese repo." : need ? "No tienes permiso de escritura en ese repo." : "No tienes acceso a ese repo.";
    if (!repo) {
      const g = list[0];
      if (!g) throw new Error(denied);
      if (isWildcard(scopeOf(g))) throw new Error("Indica el repo («propietario/nombre»): usa github_repos para ver cuáles tienes.");
      return { g, full: scopeOf(g) };
    }
    const full = parseRepo(repo).full;
    // Mejor una conexión de ese repo concreto que una general.
    const g = list.find((x) => !isWildcard(scopeOf(x)) && inScope(scopeOf(x), full)) ?? list.find((x) => inScope(scopeOf(x), full));
    if (!g) throw new Error(denied);
    return { g, full };
  };

  /** Envuelve cada herramienta: elige conexión, abre el cliente y limpia errores. */
  const run =
    <A,>(needFull: boolean | "admin", fn: (api: RepoApi, args: A, g: AgentGrant) => Promise<string>) =>
    async (args: A) => {
      try {
        const { g, full } = pick((args as { repo?: string }).repo, needFull);
        const { transport } = await resolveTransport(g.connection);
        return ok(clip(await fn(new RepoApi(full, transport), args, g)));
      } catch (err) {
        return fail(`GitHub: ${redact((err as Error).message)}`);
      }
    };

  /** Deja constancia de una acción con efectos fuera de Orden. */
  const audit = (api: RepoApi, text: string, url?: string) => {
    ctx.note(`GitHub · ${text}`, { kind: "github", repo: api.full, url });
    logActivity("conexion", `${ctx.agent.name} en GitHub (${api.full}): ${text}`, ctx.agent.id, { repo: api.full, url, taskId: ctx.task.id });
  };

  const sign = (body: string | undefined) => (body ?? "").trim() + signature(ctx.agent.name);

  const read: ToolDef[] = [
    defineTool(
      "github_resumen",
      "Resumen del repo de GitHub: rama principal, PRs e issues abiertos y últimos commits.",
      { ...repoShape(repos) },
      run(false, async (api, _a, g) => `${statusMarkdown(await fetchSnapshot(api), new Date())}\n\nTu permiso: ${g.level}.`),
    ),
    defineTool(
      "github_archivos",
      "Lista los archivos de una carpeta del repo (o todo el árbol con recursivo).",
      {
        ...repoShape(repos),
        ruta: z.string().optional().describe("Carpeta relativa al repo; vacío = raíz"),
        rama: z.string().optional().describe("Rama, etiqueta o SHA; por defecto la principal"),
        recursivo: z.boolean().optional().describe("Todo el árbol (máx. 400 rutas)"),
      },
      run(false, async (api, a: { ruta?: string; rama?: string; recursivo?: boolean }) => {
        const path = safePath(a.ruta, { allowRoot: true });
        const ref = a.rama ? safeBranch(a.rama) : undefined;
        if (a.recursivo) {
          const t = await api.tree(ref ?? (await api.defaultBranch()));
          const items = t.tree.filter((x) => x.type === "blob" && (!path || x.path.startsWith(path + "/")));
          return `${items.length} archivo(s)${t.truncated ? " (árbol truncado por GitHub)" : ""}:\n${items
            .slice(0, 400)
            .map((x) => x.path)
            .join("\n")}${items.length > 400 ? `\n… y ${items.length - 400} más` : ""}`;
        }
        const res = await api.contents(path, ref);
        if (!Array.isArray(res)) return `«${path}» es un archivo (${res.size} bytes). Léelo con github_leer.`;
        return res
          .sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === "dir" ? -1 : 1))
          .map((x: ContentItem) => (x.type === "dir" ? `${x.path}/` : `${x.path} (${x.size} B)`))
          .join("\n");
      }),
    ),
    defineTool(
      "github_leer",
      "Lee un archivo del repo. Para archivos largos, pide un rango de líneas.",
      {
        ...repoShape(repos),
        ruta: z.string().describe("Ruta del archivo relativa al repo"),
        rama: z.string().optional(),
        desde: z.number().int().min(1).optional().describe("Primera línea"),
        hasta: z.number().int().min(1).optional().describe("Última línea"),
      },
      run(false, async (api, a: { ruta: string; rama?: string; desde?: number; hasta?: number }) => {
        const path = safePath(a.ruta);
        const res = await api.contents(path, a.rama ? safeBranch(a.rama) : undefined);
        if (Array.isArray(res)) return `«${path}» es una carpeta. Usa github_archivos.`;
        if (res.type !== "file") return `«${path}» es un ${res.type}, no un archivo normal.`;
        if (res.encoding !== "base64" || res.content === undefined) return `«${path}» es demasiado grande para leerlo por la API (${res.size} bytes).`;
        const text = Buffer.from(res.content, "base64").toString("utf8");
        const lines = text.split("\n");
        const from = a.desde ?? 1;
        const to = Math.min(a.hasta ?? lines.length, lines.length);
        const part = a.desde || a.hasta ? lines.slice(from - 1, to).join("\n") : text;
        return `${path} · ${lines.length} líneas${a.desde || a.hasta ? ` · mostrando ${from}-${to}` : ""}\n\n${part}`;
      }),
    ),
    defineTool(
      "github_buscar",
      "Busca texto en el código del repo (búsqueda de GitHub; solo la rama principal).",
      { ...repoShape(repos), texto: z.string().min(2) },
      run(false, async (api, a: { texto: string }) => {
        const r = await api.searchCode(a.texto);
        if (!r.items.length) return "Sin resultados.";
        return `${r.total_count} resultado(s):\n${r.items.map((i) => i.path).join("\n")}`;
      }),
    ),
    defineTool(
      "github_commits",
      "Últimos commits (de una rama o de un archivo) o el detalle de uno con su diff si pasas sha.",
      {
        ...repoShape(repos),
        rama: z.string().optional(),
        ruta: z.string().optional().describe("Solo commits que tocan esta ruta"),
        sha: z.string().optional().describe("Ver un commit concreto"),
        limite: z.number().int().min(1).max(50).optional(),
      },
      run(false, async (api, a: { rama?: string; ruta?: string; sha?: string; limite?: number }) => {
        if (a.sha) {
          const c = await api.commit(safeSha(a.sha));
          const files = (c.files ?? []).slice(0, 40);
          return [
            `${c.sha.slice(0, 7)} · ${c.author?.login ?? c.commit.author?.name ?? "?"} · ${c.commit.author?.date ?? ""}`,
            c.commit.message,
            c.stats ? `+${c.stats.additions} −${c.stats.deletions}` : "",
            ...files.map((f) => `\n### ${f.filename} (${f.status}, +${f.additions} −${f.deletions})\n${clip(f.patch ?? "(sin diff)", 4000)}`),
          ]
            .filter(Boolean)
            .join("\n");
        }
        const list = await api.commits({ branch: a.rama ? safeBranch(a.rama) : undefined, path: a.ruta ? safePath(a.ruta) : undefined, limit: a.limite ?? 10 });
        if (!list.length) return "Sin commits.";
        return list.map((c) => `${c.sha.slice(0, 7)} · ${day(c.commit.author?.date ?? "")} · ${c.author?.login ?? c.commit.author?.name ?? "?"} · ${c.commit.message.split("\n")[0]}`).join("\n");
      }),
    ),
    defineTool(
      "github_lista",
      "Lista issues o pull requests del repo.",
      {
        ...repoShape(repos),
        tipo: z.enum(["issues", "prs"]),
        estado: z.enum(["open", "closed", "all"]).optional().describe("Por defecto open"),
        etiquetas: z.string().optional().describe("Solo issues: etiquetas separadas por comas"),
        limite: z.number().int().min(1).max(50).optional(),
      },
      run(false, async (api, a: { tipo: "issues" | "prs"; estado?: string; etiquetas?: string; limite?: number }) => {
        if (a.tipo === "prs") {
          const prs = await api.pulls({ state: a.estado, limit: a.limite });
          if (!prs.length) return "No hay pull requests.";
          return prs.map((p) => `#${p.number} [${p.state}${p.draft ? ", borrador" : ""}] ${p.title} — ${p.user?.login ?? "?"} · ${p.head.ref} → ${p.base.ref} · ${day(p.updated_at)}`).join("\n");
        }
        const issues = (await api.issues({ state: a.estado, labels: a.etiquetas, limit: a.limite })).filter((i) => !i.pull_request);
        if (!issues.length) return "No hay issues.";
        return issues
          .map((i) => {
            const labels = labelsOf(i);
            return `#${i.number} [${i.state}] ${i.title}${labels.length ? ` {${labels.join(", ")}}` : ""} — ${i.user?.login ?? "?"} · ${i.comments} coment. · ${day(i.updated_at)}`;
          })
          .join("\n");
      }),
    ),
    defineTool(
      "github_ver",
      "Muestra un issue o pull request por número, con sus comentarios (y archivos cambiados si es un PR).",
      { ...repoShape(repos), numero: z.number().int().min(1) },
      run(false, async (api, a: { numero: number }) => {
        const issue = await api.issue(a.numero);
        const out = [`#${issue.number} ${issue.title} [${issue.state}] — ${issue.user?.login ?? "?"} · ${issue.html_url}`];
        if (issue.pull_request) {
          const [pr, files] = await Promise.all([api.pull(a.numero), api.pullFiles(a.numero)]);
          out.push(`PR: ${pr.head.ref} → ${pr.base.ref}${pr.draft ? " · borrador" : ""}${pr.merged ? " · fusionado" : ""} · +${pr.additions ?? 0} −${pr.deletions ?? 0} en ${pr.changed_files ?? files.length} archivo(s)`);
          out.push(`Archivos:\n${files.map((f) => `- ${f.filename} (${f.status}, +${f.additions} −${f.deletions})`).join("\n")}`);
        }
        const labels = labelsOf(issue);
        if (labels.length) out.push(`Etiquetas: ${labels.join(", ")}`);
        out.push(`\n${issue.body?.trim() || "(sin descripción)"}`);
        const comments = issue.comments ? await api.comments(a.numero) : [];
        for (const c of comments) out.push(`\n— ${c.user?.login ?? "?"} (${day(c.created_at)}):\n${clip(c.body, 3000)}`);
        return out.join("\n");
      }),
    ),
    defineTool(
      "github_comentar",
      "Publica un comentario en un issue o pull request (se firma como agente de Orden).",
      { ...repoShape(repos), numero: z.number().int().min(1), texto: z.string().min(1).max(20_000) },
      run(false, async (api, a: { numero: number; texto: string }) => {
        const c = await api.comment(a.numero, sign(a.texto));
        audit(api, `comentario en #${a.numero}`, c.html_url);
        return `Comentario publicado: ${c.html_url}`;
      }),
    ),
  ];

  // Con acceso a varios repos de golpe, el agente necesita ver cuáles son.
  if (wildcard) {
    read.unshift(
      defineTool(
        "github_repos",
        "Lista los repos de GitHub a los que tienes acceso (los más activos primero), con tu permiso en cada uno.",
        { filtro: z.string().optional().describe("Texto para filtrar por nombre") },
        async ({ filtro }) => {
          try {
            const seen = new Map<string, string>();
            for (const g of grants.filter((x) => isWildcard(scopeOf(x)))) {
              const { transport } = await resolveTransport(g.connection);
              for (const r of await listScopeRepos(transport, scopeOf(g))) {
                const level = pick(r.full_name, false).g.level;
                const best = grants.filter((x) => inScope(scopeOf(x), r.full_name)).reduce<GrantLevel>((acc, x) => (levelAtLeast(x.level, acc) ? x.level : acc), "lectura");
                const canWrite = levelAtLeast(best, "completo") && r.permissions?.push !== false;
                seen.set(
                  r.full_name,
                  `- ${r.full_name}${r.private ? " (privado)" : ""}${r.archived ? " (archivado)" : ""} · ${canWrite ? best : levelAtLeast(level, "completo") ? "lectura (la cuenta no puede escribir)" : "lectura"}${r.pushed_at ? ` · último push ${day(r.pushed_at)}` : ""}${r.description ? ` · ${r.description.slice(0, 100)}` : ""}`,
                );
              }
            }
            for (const scope of repos.filter((x) => !isWildcard(x))) if (!seen.has(scope)) seen.set(scope, `- ${scope}`);
            const q = filtro?.toLowerCase();
            const lines = [...seen.entries()].filter(([name]) => !q || name.toLowerCase().includes(q)).map(([, line]) => line);
            return ok(clip(lines.length ? `${lines.length} repo(s) (${repos.map(scopeLabel).join(" + ")}):\n${lines.join("\n")}` : "Ningún repo coincide."));
          } catch (err) {
            return fail(`GitHub: ${redact((err as Error).message)}`);
          }
        },
      ),
    );
  }

  if (!fullRepos.length) return read;

  const write: ToolDef[] = [
    defineTool(
      "github_crear_issue",
      "Crea un issue en el repo.",
      {
        ...repoShape(fullRepos),
        titulo: z.string().min(1).max(250),
        texto: z.string().max(60_000).optional(),
        etiquetas: z.array(z.string()).max(10).optional(),
      },
      run(true, async (api, a: { titulo: string; texto?: string; etiquetas?: string[] }) => {
        const i = await api.createIssue({ title: a.titulo, body: sign(a.texto), ...(a.etiquetas?.length && { labels: a.etiquetas }) });
        audit(api, `issue #${i.number} creado: ${a.titulo}`, i.html_url);
        return `Issue #${i.number} creado: ${i.html_url}`;
      }),
    ),
    defineTool(
      "github_editar_issue",
      "Cambia título, texto, etiquetas o estado (abrir/cerrar) de un issue o PR.",
      {
        ...repoShape(fullRepos),
        numero: z.number().int().min(1),
        titulo: z.string().min(1).max(250).optional(),
        texto: z.string().max(60_000).optional(),
        estado: z.enum(["open", "closed"]).optional(),
        etiquetas: z.array(z.string()).max(10).optional(),
      },
      run(true, async (api, a: { numero: number; titulo?: string; texto?: string; estado?: string; etiquetas?: string[] }) => {
        const patch = { title: a.titulo, body: a.texto, state: a.estado, labels: a.etiquetas };
        if (Object.values(patch).every((v) => v === undefined)) throw new Error("No has indicado ningún cambio.");
        const i = await api.editIssue(a.numero, patch);
        audit(api, `#${a.numero} editado${a.estado ? ` (${a.estado === "closed" ? "cerrado" : "reabierto"})` : ""}`, i.html_url);
        return `#${i.number} actualizado: ${i.html_url}`;
      }),
    ),
    defineTool(
      "github_crear_rama",
      "Crea una rama nueva a partir de otra (por defecto, la principal).",
      { ...repoShape(fullRepos), nombre: z.string(), desde: z.string().optional() },
      run(true, async (api, a: { nombre: string; desde?: string }) => {
        const name = safeBranch(a.nombre);
        const from = a.desde ? safeBranch(a.desde) : await api.defaultBranch();
        await api.createBranch(name, await api.branchSha(from));
        audit(api, `rama «${name}» creada desde «${from}»`);
        return `Rama «${name}» creada desde «${from}».`;
      }),
    ),
    defineTool(
      "github_commit",
      "Hace UN commit con uno o varios archivos (crear, sustituir el contenido completo o borrar) en una rama que no sea la principal.",
      {
        ...repoShape(fullRepos),
        rama: z.string(),
        mensaje: z.string().min(1).max(2000),
        archivos: z
          .array(
            z.object({
              ruta: z.string(),
              contenido: z.string().optional().describe("Contenido completo del archivo (texto)"),
              borrar: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(MAX_FILES),
      },
      run(true, async (api, a: { rama: string; mensaje: string; archivos: { ruta: string; contenido?: string; borrar?: boolean }[] }) => {
        const branch = safeBranch(a.rama);
        const main = await api.defaultBranch();
        if (branch === main) throw new Error(`No se permiten commits directos en la rama principal («${main}»). Crea una rama con github_crear_rama y abre un PR.`);
        const files = a.archivos.map((f) => {
          const path = safePath(f.ruta);
          if (!f.borrar && f.contenido === undefined) throw new Error(`Falta el contenido de «${path}» (o marca borrar).`);
          if (Buffer.byteLength(f.contenido ?? "", "utf8") > MAX_FILE_BYTES) throw new Error(`«${path}» supera ${MAX_FILE_BYTES / 1000} KB.`);
          return { path, content: f.contenido, delete: Boolean(f.borrar) };
        });
        if (new Set(files.map((f) => f.path)).size !== files.length) throw new Error("Hay rutas repetidas en el commit.");
        const c = await api.commitFiles(branch, `${a.mensaje.trim()}\n\nHecho por ${ctx.agent.name} (agente de Orden).`, files);
        audit(api, `commit ${c.sha.slice(0, 7)} en «${branch}» (${files.length} archivo(s)): ${a.mensaje.split("\n")[0]}`, c.html_url);
        return `Commit ${c.sha.slice(0, 7)} en «${branch}»: ${c.html_url}`;
      }),
    ),
    defineTool(
      "github_crear_pr",
      "Abre un pull request de una rama hacia otra (por defecto, la principal). No fusiona: eso lo decide el usuario.",
      {
        ...repoShape(fullRepos),
        titulo: z.string().min(1).max(250),
        rama: z.string().describe("Rama con los cambios"),
        base: z.string().optional().describe("Rama destino; por defecto la principal"),
        texto: z.string().max(60_000).optional(),
        borrador: z.boolean().optional(),
      },
      run(true, async (api, a: { titulo: string; rama: string; base?: string; texto?: string; borrador?: boolean }) => {
        const head = safeBranch(a.rama);
        const base = a.base ? safeBranch(a.base) : await api.defaultBranch();
        const pr = await api.createPull({ title: a.titulo, head, base, body: sign(a.texto), draft: Boolean(a.borrador) });
        audit(api, `PR #${pr.number} abierto: ${a.titulo} (${head} → ${base})`, pr.html_url);
        return `PR #${pr.number} abierto: ${pr.html_url}`;
      }),
    ),
  ];
  if (!adminRepos.length) return [...read, ...write];

  // ── Admin: lo de más alcance. GitHub sigue aplicando sus protecciones de rama. ──
  const FAILED = ["failure", "cancelled", "timed_out", "action_required", "startup_failure"];
  const admin: ToolDef[] = [
    defineTool(
      "github_fusionar_pr",
      "Fusiona un pull request abierto. No lo hace si es borrador, tiene conflictos o algún check falla o sigue en marcha (salvo ignorar_checks). Por defecto squash y borra la rama del PR al terminar.",
      {
        ...repoShape(adminRepos),
        numero: z.number().int().min(1),
        metodo: z.enum(["squash", "merge", "rebase"]).optional().describe("squash (por defecto), merge o rebase"),
        titulo: z.string().max(250).optional().describe("Título del commit de fusión"),
        borrar_rama: z.boolean().optional().describe("Borrar la rama del PR después (por defecto sí)"),
        ignorar_checks: z.boolean().optional().describe("Fusionar aunque haya checks fallando o pendientes (solo si el usuario lo pidió)"),
      },
      run("admin", async (api, a: { numero: number; metodo?: "squash" | "merge" | "rebase"; titulo?: string; borrar_rama?: boolean; ignorar_checks?: boolean }) => {
        let pr = await api.pull(a.numero);
        if (pr.merged) return `El PR #${a.numero} ya estaba fusionado.`;
        if (pr.state !== "open") throw new Error(`El PR #${a.numero} está cerrado.`);
        if (pr.draft) throw new Error(`El PR #${a.numero} es un borrador: márcalo como listo antes.`);
        // GitHub calcula «mergeable» en segundo plano: si aún no lo sabe, se le da un momento.
        if (pr.mergeable === null || pr.mergeable === undefined) {
          await new Promise((r) => setTimeout(r, 1500));
          pr = await api.pull(a.numero);
        }
        if (pr.mergeable === false) throw new Error(`El PR #${a.numero} tiene conflictos con ${pr.base.ref}: hay que resolverlos antes.`);
        if (pr.head.sha && !a.ignorar_checks) {
          const runs = (await api.checkRuns(pr.head.sha)).check_runs;
          const failed = runs.filter((r) => r.status === "completed" && FAILED.includes(r.conclusion ?? ""));
          const pending = runs.filter((r) => r.status !== "completed");
          if (failed.length) throw new Error(`Checks en rojo: ${failed.map((r) => r.name).join(", ")}. No se fusiona.`);
          if (pending.length) throw new Error(`Checks aún en marcha: ${pending.map((r) => r.name).join(", ")}. Vuelve a intentarlo cuando acaben.`);
        }
        const merged = await api.mergePull(a.numero, { merge_method: a.metodo ?? "squash", commit_title: a.titulo, sha: pr.head.sha });
        if (!merged.merged) throw new Error(merged.message || "GitHub no lo ha fusionado.");
        audit(api, `fusiona el PR #${a.numero} «${pr.title}» en ${pr.base.ref} (${a.metodo ?? "squash"})`, pr.html_url);
        let tail = "";
        const sameRepo = !pr.head.repo || pr.head.repo.full_name.toLowerCase() === api.full.toLowerCase();
        if ((a.borrar_rama ?? true) && sameRepo && pr.head.ref !== (await api.defaultBranch())) {
          try {
            await api.deleteBranch(pr.head.ref);
            tail = ` Rama ${pr.head.ref} borrada.`;
          } catch {
            tail = ` No se pudo borrar la rama ${pr.head.ref} (quizá está protegida).`;
          }
        }
        return `PR #${a.numero} fusionado en ${pr.base.ref} (${merged.sha.slice(0, 7)}).${tail}`;
      }),
    ),
    defineTool(
      "github_revisar_pr",
      "Deja una revisión en un pull request: aprobar, pedir cambios o solo comentar. GitHub no deja aprobar un PR propio de la cuenta.",
      {
        ...repoShape(adminRepos),
        numero: z.number().int().min(1),
        veredicto: z.enum(["aprobar", "pedir_cambios", "comentar"]),
        texto: z.string().min(1).max(20_000),
      },
      run("admin", async (api, a: { numero: number; veredicto: "aprobar" | "pedir_cambios" | "comentar"; texto: string }) => {
        const event = a.veredicto === "aprobar" ? "APPROVE" : a.veredicto === "pedir_cambios" ? "REQUEST_CHANGES" : "COMMENT";
        const r = await api.review(a.numero, { event, body: sign(a.texto) });
        audit(api, `revisa el PR #${a.numero}: ${a.veredicto.replace("_", " ")}`, r.html_url);
        return `Revisión enviada (${a.veredicto.replace("_", " ")}): ${r.html_url}`;
      }),
    ),
    defineTool(
      "github_cerrar_pr",
      "Cierra un pull request sin fusionarlo, con un comentario que explique por qué.",
      { ...repoShape(adminRepos), numero: z.number().int().min(1), motivo: z.string().min(1).max(5000) },
      run("admin", async (api, a: { numero: number; motivo: string }) => {
        await api.comment(a.numero, sign(a.motivo));
        const pr = await api.closePull(a.numero);
        audit(api, `cierra el PR #${a.numero} sin fusionar`, pr.html_url);
        return `PR #${a.numero} cerrado.`;
      }),
    ),
    defineTool(
      "github_borrar_rama",
      "Borra una rama (nunca la principal del repo; GitHub tampoco deja borrar las protegidas).",
      { ...repoShape(adminRepos), rama: z.string() },
      run("admin", async (api, a: { rama: string }) => {
        const rama = safeBranch(a.rama);
        if (rama === (await api.defaultBranch())) throw new Error(`«${rama}» es la rama principal: no se borra.`);
        await api.deleteBranch(rama);
        audit(api, `borra la rama ${rama}`);
        return `Rama ${rama} borrada.`;
      }),
    ),
    defineTool(
      "github_crear_repo",
      "Crea un repositorio nuevo (privado por defecto, con README inicial) en tu cuenta o en una organización, siempre dentro de tu acceso admin.",
      {
        nombre: z.string().min(1).max(100),
        descripcion: z.string().max(350).optional(),
        privado: z.boolean().optional().describe("Por defecto true"),
        propietario: z.string().optional().describe("Organización (o tu usuario); por defecto, tu cuenta"),
      },
      async (a) => {
        try {
          const g = grants.find((x) => x.level === "admin")!;
          const { transport } = await resolveTransport(g.connection);
          const login = (await currentUser(transport)).login;
          const owner = (a.propietario ?? login).trim();
          const full = `${owner}/${a.nombre.trim()}`;
          // El repo nuevo tiene que caer dentro de un acceso admin (p. ej. «*» o «propietario/*»).
          if (!grants.some((x) => x.level === "admin" && isWildcard(scopeOf(x)) && inScope(scopeOf(x), full))) {
            return fail(`Para crear repos en «${owner}» hace falta un acceso admin que lo cubra («${owner}/*» o «*»).`);
          }
          const repo = await createRepo(transport, { owner, name: a.nombre, description: a.descripcion, private: a.privado ?? true }, login);
          ctx.note(`GitHub · crea el repo ${repo.full_name}${repo.private ? " (privado)" : ""}`, { kind: "github", repo: repo.full_name, url: repo.html_url });
          logActivity("conexion", `${ctx.agent.name} crea el repo ${repo.full_name} en GitHub`, ctx.agent.id, { repo: repo.full_name, url: repo.html_url, taskId: ctx.task.id });
          return ok(`Repo creado: ${repo.html_url} (${repo.private ? "privado" : "público"}, rama ${repo.default_branch}).`);
        } catch (err) {
          return fail(`GitHub: ${redact((err as Error).message)}`);
        }
      },
    ),
  ];

  return [...read, ...write, ...admin];
}
