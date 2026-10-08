import { z } from "zod";
import { defineTool, fail, ok, type ToolContext, type ToolDef } from "../../agents/tools";
import { logActivity } from "../../repo/system";
import { redact } from "../../secrets";
import type { AgentGrant } from "../registry";
import { AccountApi, ALL_REPOS, parseRepo, RepoApi, resolveTransport, safeBranch, safePath, safeSha, type ContentItem, type IssueItem } from "./api";
import { fetchSnapshot, statusMarkdown } from "./status";

/**
 * Herramientas de GitHub para un agente. Solo aparecen las de su nivel:
 * - lectura: leer código, commits, issues y PRs, buscar y comentar.
 * - completo: además crear/editar issues, ramas, commits y PRs.
 * El repo sale SIEMPRE de la conexión: el agente no puede indicar otro.
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
  /** Conexión de cuenta («todos los repos»): el agente indica el repo en cada llamada. */
  const isAll = (g: AgentGrant) => g.connection.config.repo === ALL_REPOS;
  const named = (list: AgentGrant[]) => list.filter((g) => !isAll(g)).map((g) => String(g.connection.config.repo));
  const fullGrants = grants.filter((g) => g.level === "completo");
  const multi = grants.length > 1;
  const hasAll = grants.some(isAll);

  /**
   * Parámetro «repo»: obligatorio si hay una conexión de cuenta (cualquier
   * «propietario/nombre» que vea la credencial); si no, solo cuando hay varios
   * repos conectados y limitado a los suyos.
   */
  const repoShape = (list: AgentGrant[]): Record<string, z.ZodType> => {
    const names = named(list);
    if (list.some(isAll)) {
      return { repo: z.string().describe(`Repo «propietario/nombre»${names.length ? ` (conectados aparte: ${names.join(", ")})` : ""}. Puedes usar cualquier repo de la cuenta; lista los tuyos con github_repos`) };
    }
    return multi && names.length ? { repo: z.enum(names as [string, ...string[]]).describe("Repo (solo los que tienes conectados)") } : {};
  };

  /** Conexión y repo (completo, «propietario/nombre») de una llamada. */
  const pick = (repo: unknown, needFull: boolean): { g: AgentGrant; full: string } => {
    const list = needFull ? fullGrants : grants;
    const wanted = repo ? parseRepo(repo).full : "";
    const exact = wanted ? list.find((x) => !isAll(x) && String(x.connection.config.repo).toLowerCase() === wanted.toLowerCase()) : undefined;
    const g = exact ?? (wanted ? list.find(isAll) : list.find((x) => !isAll(x)) ?? list[0]);
    if (!g) throw new Error(needFull ? "No tienes permiso de escritura en ese repo." : "No tienes acceso a ese repo.");
    if (isAll(g) && !wanted) throw new Error("Indica el repo («propietario/nombre»). Lista los tuyos con github_repos.");
    return { g, full: isAll(g) ? wanted : String(g.connection.config.repo) };
  };

  /** Envuelve cada herramienta: elige conexión, abre el cliente y limpia errores. */
  const run =
    <A,>(needFull: boolean, fn: (api: RepoApi, args: A, g: AgentGrant) => Promise<string>) =>
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
      { ...repoShape(grants) },
      run(false, async (api, _a, g) => `${statusMarkdown(await fetchSnapshot(api), new Date())}\n\nTu permiso: ${g.level}.`),
    ),
    defineTool(
      "github_archivos",
      "Lista los archivos de una carpeta del repo (o todo el árbol con recursivo).",
      {
        ...repoShape(grants),
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
        ...repoShape(grants),
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
      { ...repoShape(grants), texto: z.string().min(2) },
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
        ...repoShape(grants),
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
        ...repoShape(grants),
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
      { ...repoShape(grants), numero: z.number().int().min(1) },
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
      { ...repoShape(grants), numero: z.number().int().min(1), texto: z.string().min(1).max(20_000) },
      run(false, async (api, a: { numero: number; texto: string }) => {
        const c = await api.comment(a.numero, sign(a.texto));
        audit(api, `comentario en #${a.numero}`, c.html_url);
        return `Comentario publicado: ${c.html_url}`;
      }),
    ),
  ];

  if (hasAll) {
    read.unshift(
      defineTool(
        "github_repos",
        "Lista los repositorios de la cuenta de GitHub conectada (los más recientes primero), con su visibilidad y el permiso que tiene la cuenta en cada uno.",
        { limite: z.number().int().min(1).max(100).optional().describe("Por defecto 30") },
        async ({ limite }: { limite?: number }) => {
          try {
            const g = grants.find(isAll)!;
            const { transport } = await resolveTransport(g.connection);
            const list = await new AccountApi(transport).repos(limite ?? 30);
            if (!list.length) return ok("La cuenta no tiene repositorios visibles.");
            return ok(
              clip(
                list
                  .map((r) => {
                    const perm = r.permissions ? (r.permissions.push ? "escritura" : "solo lectura") : "";
                    const flags = [r.private ? "privado" : "público", perm, r.fork ? "fork" : "", r.archived ? "archivado" : ""].filter(Boolean).join(", ");
                    return `${r.full_name} · ${flags} · rama ${r.default_branch}${r.pushed_at ? ` · ${day(r.pushed_at)}` : ""}${r.description ? ` — ${r.description.slice(0, 100)}` : ""}`;
                  })
                  .join("\n"),
              ),
            );
          } catch (err) {
            return fail(`GitHub: ${redact((err as Error).message)}`);
          }
        },
      ),
    );
  }

  if (!fullGrants.length) return read;

  const write: ToolDef[] = [
    defineTool(
      "github_crear_issue",
      "Crea un issue en el repo.",
      {
        ...repoShape(fullGrants),
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
        ...repoShape(fullGrants),
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
      { ...repoShape(fullGrants), nombre: z.string(), desde: z.string().optional() },
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
        ...repoShape(fullGrants),
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
        ...repoShape(fullGrants),
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
  return [...read, ...write];
}
